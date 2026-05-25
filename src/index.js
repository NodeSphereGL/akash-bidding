// Akash GPU auto-bidding daemon. Each account runs its own async loop via
// `runAccountLoop`. The supervisor spawns N loops with `Promise.allSettled`;
// when every account returns EXHAUSTED, it notifies, cools off, and respawns.
// SIGINT/SIGTERM aborts all loops via a shared AbortController.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadConfig, uactPerBlockToUsdPerHour } from "./config.js";
import { createLogger } from "./logger.js";
import { loadAccounts } from "./accounts-loader.js";
import { filterAndRank } from "./bidder.js";
import * as akashImpl from "./akash.js";
import { AkashApiError } from "./errors.js";
import * as notifyImpl from "./notify.js";

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const onAbort = () => {
    clearTimeout(t);
    resolve();
  };
  const t = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

const SUPERVISOR_COOLOFF_FLOOR_MS = 60_000;

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));

function tgCfg(config, logger) {
  return {
    botToken: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
    logger,
  };
}

async function pollAndLease({ ctx, dseq, owner, manifest, config, logger, akash, abortSignal }) {
  const deadline = Date.now() + config.BID_WAIT_MS;
  let fallbackList = [];

  while (Date.now() < deadline && !abortSignal?.aborted) {
    let raw = [];
    try {
      raw = await akash.getBids(ctx, dseq, owner);
    } catch (err) {
      logger.warn("bids.fetch.error", { error: err.message });
    }
    const candidates = filterAndRank(raw, {
      gpuBlacklist: config.GPU_BLACKLIST,
      maxUactPerBlock: config.MAX_UACT_PER_BLOCK,
      logger,
    });
    if (candidates.length > 0) {
      fallbackList = candidates;
      logger.info("bids.matched", {
        dseq,
        count: candidates.length,
        topPrice: candidates[0].uactPerBlock,
      });
      break;
    }
    await sleep(config.BID_POLL_INTERVAL_MS, abortSignal);
  }

  if (fallbackList.length === 0) {
    logger.info("bids.none", { dseq, waitedMs: config.BID_WAIT_MS });
    return { leased: false };
  }

  for (const candidate of fallbackList) {
    if (abortSignal?.aborted) return { leased: false };
    try {
      const lease = await akash.createLease(ctx, candidate.compositeId, manifest);
      logger.info("lease.success", {
        dseq,
        provider: candidate.provider,
        uactPerBlock: candidate.uactPerBlock,
        model: candidate.model,
      });
      return { leased: true, lease, bid: candidate };
    } catch (err) {
      logger.warn("lease.attempt.failed", {
        provider: candidate.provider,
        model: candidate.model,
        status: err?.status,
        error: err.message,
      });
    }
  }
  return { leased: false };
}

/**
 * Runs the bidding loop for one account. Returns when the account exhausts
 * itself or when the shared abortSignal fires.
 *
 * @param {object} account
 * @param {{ config: object, sdl: string, logger: object, notify: object, akash: object, abortSignal?: AbortSignal }} deps
 * @returns {Promise<{ reason: string }>}
 */
export async function runAccountLoop(account, deps) {
  const { config, sdl, logger, notify, akash, abortSignal } = deps;
  const loopLog = logger.child({ account: account.name });
  loopLog.info("account.loop.start", {});

  const jitterMs = randomBetween(0, config.STARTUP_JITTER_MS);
  await sleep(jitterMs, abortSignal);

  let noMatchStreak = 0;
  let exitReason = "aborted";

  while (!abortSignal?.aborted) {
    const cycleLog = logger.child({ account: account.name });
    const ctx = { account, config, logger: cycleLog };

    try {
      cycleLog.info("cycle.start", {});

      try {
        await akash.getBalance(ctx);
        cycleLog.info("account.healthy", {});
      } catch (err) {
        if (err instanceof AkashApiError && err.status === 401) {
          cycleLog.warn("auth.fail", { status: 401 });
          await notify.notifyAuthFail(account, tgCfg(config, cycleLog));
          exitReason = "401";
          break;
        }
        cycleLog.warn("health.check.error", { error: err.message });
      }

      let dseq;
      let manifest;
      try {
        const created = await akash.createDeployment(ctx, sdl, config.DEPOSIT_USD);
        dseq = created.dseq;
        manifest = created.manifest;
        cycleLog.info("deployment.created", { dseq, txHash: created.txHash });
      } catch (err) {
        if (!(err instanceof AkashApiError)) throw err;
        if (err.status === 401) {
          cycleLog.warn("auth.fail", { status: 401 });
          await notify.notifyAuthFail(account, tgCfg(config, cycleLog));
          exitReason = "401";
          break;
        }
        if (/insufficient|credit|balance/i.test(JSON.stringify(err.body || ""))) {
          exitReason = `insufficient credit on create: ${err.status}`;
          break;
        }
        cycleLog.warn("deployment.create.failed", { status: err.status, error: err.message });
        await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
        continue;
      }

      let owner;
      try {
        owner = await akash.getOwnerAddress(ctx, dseq);
        cycleLog.info("owner.resolved", { owner });
      } catch (err) {
        if (!(err instanceof AkashApiError)) throw err;
        cycleLog.warn("owner.resolve.failed", { error: err.message });
        await akash.closeDeployment(ctx, dseq).catch(() => {});
        await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
        continue;
      }

      const result = await pollAndLease({
        ctx, dseq, owner, manifest, config, logger: cycleLog, akash, abortSignal,
      });

      if (result.leased) {
        noMatchStreak = 0;
        await notify.notifyLeaseSuccess(
          { bid: result.bid, lease: result.lease, account },
          tgCfg(config, cycleLog),
        );
        cycleLog.info("cycle.hold", { ms: config.LEASE_HOLD_MS });
        await sleep(config.LEASE_HOLD_MS, abortSignal);
        continue;
      }

      try {
        await akash.closeDeployment(ctx, dseq);
        cycleLog.info("deployment.closed", { dseq });
      } catch (err) {
        cycleLog.warn("deployment.close.failed", { dseq, error: err.message });
      }

      noMatchStreak++;
      if (noMatchStreak >= config.NO_MATCH_EXHAUST_THRESHOLD) {
        cycleLog.warn("account.exhausted.no_match", { streak: noMatchStreak });
        exitReason = `no matching bids in ${noMatchStreak} cycles`;
        break;
      }

      const wait = randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS);
      cycleLog.info("cycle.retry.sleep", { ms: wait });
      await sleep(wait, abortSignal);
    } catch (err) {
      cycleLog.error("cycle.unexpected", { error: err.message, stack: err.stack });
      await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
    }
  }

  loopLog.info("account.loop.exit", { reason: exitReason });
  return { reason: exitReason };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_FILE);
  logger.info("daemon.start", {
    node: process.version,
    base: config.AKASH_API_BASE,
    maxUactPerBlock: config.MAX_UACT_PER_BLOCK,
    maxUsdPerHour: Number(uactPerBlockToUsdPerHour(config.MAX_UACT_PER_BLOCK).toFixed(4)),
    blacklist: config.GPU_BLACKLIST,
  });

  let sdl;
  try {
    sdl = await readFile(resolve(config.SDL_PATH), "utf8");
  } catch (err) {
    logger.error("sdl.load.failed", { path: config.SDL_PATH, error: err.message });
    await notifyImpl.notifySdlFail(err, tgCfg(config, logger));
    process.exit(1);
  }

  let accounts;
  try {
    accounts = await loadAccounts(resolve(config.ACCOUNTS_PATH));
  } catch (err) {
    logger.error("accounts.load.failed", { error: err.message });
    await notifyImpl.notifyFatal("Accounts Load Failed", err, tgCfg(config, logger));
    process.exit(1);
  }
  logger.info("accounts.loaded", { count: accounts.length });

  const abortController = new AbortController();
  process.on("SIGINT", () => {
    logger.info("daemon.shutdown", { signal: "SIGINT" });
    abortController.abort();
  });
  process.on("SIGTERM", () => {
    logger.info("daemon.shutdown", { signal: "SIGTERM" });
    abortController.abort();
  });
  process.on("uncaughtException", async (err) => {
    logger.error("uncaught.exception", { error: err.message, stack: err.stack });
    await notifyImpl.notifyCrash(err, tgCfg(config, logger));
    await logger.drain().catch(() => {});
    process.exit(1);
  });
  process.on("unhandledRejection", async (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("unhandled.rejection", { error: err.message, stack: err.stack });
    await notifyImpl.notifyCrash(err, tgCfg(config, logger));
    await logger.drain().catch(() => {});
    process.exit(1);
  });

  const deps = {
    config, sdl, logger, notify: notifyImpl, akash: akashImpl,
    abortSignal: abortController.signal,
  };

  while (!abortController.signal.aborted) {
    const loops = accounts.map((account) => runAccountLoop(account, deps));
    const results = await Promise.allSettled(loops);

    if (abortController.signal.aborted) break;

    const summary = results.map((r, i) => ({
      account: accounts[i].name,
      status: r.status,
      reason: r.status === "fulfilled" ? r.value?.reason : r.reason?.message,
    }));
    logger.warn("all.accounts.exhausted", { results: summary });

    const allAborted = summary.every((s) => s.reason === "aborted");
    if (!allAborted) {
      await notifyImpl.notifyAllDepleted(accounts.length, tgCfg(config, logger));
    }
    const cooloff = Math.max(config.RETRY_MAX_MS ?? 0, SUPERVISOR_COOLOFF_FLOOR_MS);
    await sleep(cooloff, abortController.signal);
  }

  await logger.drain().catch(() => {});
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    console.error("fatal:", err);
    try {
      const cfg = loadConfig();
      await notifyImpl.notifyCrash(err, {
        botToken: cfg.TELEGRAM_BOT_TOKEN,
        chatId: cfg.TELEGRAM_CHAT_ID,
      });
    } catch { /* swallow secondary errors */ }
    process.exit(1);
  });
}
