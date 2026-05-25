// Akash GPU auto-bidding daemon. Orchestrates the full cycle per R1-R10.
// One sequential cycle per loop iteration:
//   rotator.next → balance check → createDeployment → pollAndLease →
//   leaseSuccess(sleep 1h) OR close + random sleep.
// Exits 0 when every account is exhausted; exits 1 on uncaught exception.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadConfig, uactPerBlockToUsdPerHour } from "./config.js";
import { createLogger } from "./logger.js";
import { loadAccounts } from "./accounts-loader.js";
import { createRotator } from "./rotator.js";
import { filterAndRank } from "./bidder.js";
import * as akash from "./akash.js";
import { AkashApiError, AllExhaustedError } from "./errors.js";
import * as notify from "./notify.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));

function tgCfg(config, logger) {
  return {
    botToken: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
    logger,
  };
}

async function pollAndLease({ ctx, dseq, owner, manifest, config, logger }) {
  const deadline = Date.now() + config.BID_WAIT_MS;
  let fallbackList = [];

  while (Date.now() < deadline) {
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
    await sleep(config.BID_POLL_INTERVAL_MS);
  }

  if (fallbackList.length === 0) {
    logger.info("bids.none", { dseq, waitedMs: config.BID_WAIT_MS });
    return { leased: false };
  }

  for (const candidate of fallbackList) {
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
    await notify.notifySdlFail(err, tgCfg(config, logger));
    process.exit(1);
  }

  let accounts;
  try {
    accounts = await loadAccounts(resolve(config.ACCOUNTS_PATH));
  } catch (err) {
    logger.error("accounts.load.failed", { error: err.message });
    await notify.notifyFatal("Accounts Load Failed", err, tgCfg(config, logger));
    process.exit(1);
  }
  const rotator = createRotator(accounts);
  logger.info("accounts.loaded", { count: accounts.length });

  process.on("SIGINT", () => { void shutdown("SIGINT", logger); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM", logger); });
  process.on("uncaughtException", async (err) => {
    logger.error("uncaught.exception", { error: err.message, stack: err.stack });
    await notify.notifyCrash(err, tgCfg(config, logger));
    await logger.drain().catch(() => {});
    process.exit(1);
  });
  process.on("unhandledRejection", async (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("unhandled.rejection", { error: err.message, stack: err.stack });
    await notify.notifyCrash(err, tgCfg(config, logger));
    await logger.drain().catch(() => {});
    process.exit(1);
  });

  const noMatchStreak = new Map();

  while (true) {
    let account;
    try {
      account = rotator.next();
    } catch (err) {
      if (err instanceof AllExhaustedError) {
        // TEMP-DISABLE-STOP: run endless, no auto-exit on all-exhausted.
        // Restore by replacing this block with:
        //   await notify.notifyAllDepleted(accounts.length, tgCfg(config, logger));
        //   await logger.drain().catch(() => {});
        //   process.exit(0);
        logger.warn("rotator.exhausted.tempContinue", rotator.status());
        await notify.notifyAllDepleted(accounts.length, tgCfg(config, logger));
        await sleep(config.RETRY_MAX_MS);
        rotator.reset();
        continue;
      }
      throw err;
    }

    const cycleLog = logger.child({ account: account.name });
    const ctx = { account, config, logger: cycleLog };
    cycleLog.info("cycle.start", {});

    // Health precheck — confirms API key works. No dedicated balance endpoint
    // on console-api, so we rely on insufficient-credit error at create time
    // to mark an account exhausted (plan risk #2 fallback).
    try {
      await akash.getBalance(ctx);
      cycleLog.info("account.healthy", {});
    } catch (err) {
      if (err instanceof AkashApiError && err.status === 401) {
        cycleLog.warn("auth.fail", { status: 401 });
        await notify.notifyAuthFail(account, tgCfg(config, cycleLog));
        rotator.markExhausted(account, "401");
        continue;
      }
      cycleLog.warn("health.check.error", { error: err.message });
    }

    // Create deployment
    let dseq;
    let manifest;
    try {
      const created = await akash.createDeployment(ctx, sdl, config.DEPOSIT_USD);
      dseq = created.dseq;
      manifest = created.manifest;
      cycleLog.info("deployment.created", { dseq, txHash: created.txHash });
    } catch (err) {
      if (err instanceof AkashApiError && err.status === 401) {
        cycleLog.warn("auth.fail", { status: 401 });
        await notify.notifyAuthFail(account, tgCfg(config, cycleLog));
        rotator.markExhausted(account, "401");
        continue;
      }
      if (err instanceof AkashApiError && /insufficient|credit|balance/i.test(JSON.stringify(err.body || ""))) {
        rotator.markExhausted(account, `insufficient credit on create: ${err.status}`);
        continue;
      }
      cycleLog.warn("deployment.create.failed", { status: err?.status, error: err.message });
      await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS));
      continue;
    }

    let owner;
    try {
      owner = await akash.getOwnerAddress(ctx, dseq);
      cycleLog.info("owner.resolved", { owner });
    } catch (err) {
      cycleLog.warn("owner.resolve.failed", { error: err.message });
      // No owner → can't poll bids. Close the deployment and wait a cycle.
      await akash.closeDeployment(ctx, dseq).catch(() => {});
      await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS));
      continue;
    }

    const result = await pollAndLease({ ctx, dseq, owner, manifest, config, logger: cycleLog });

    if (result.leased) {
      noMatchStreak.set(account.name, 0);
      await notify.notifyLeaseSuccess(
        { bid: result.bid, lease: result.lease, account },
        tgCfg(config, cycleLog),
      );
      cycleLog.info("cycle.hold", { ms: config.LEASE_HOLD_MS });
      await sleep(config.LEASE_HOLD_MS);
      continue;
    }

    // No-match path: close deployment, sleep, possibly exhaust account
    try {
      await akash.closeDeployment(ctx, dseq);
      cycleLog.info("deployment.closed", { dseq });
    } catch (err) {
      cycleLog.warn("deployment.close.failed", { dseq, error: err.message });
    }

    const streak = (noMatchStreak.get(account.name) ?? 0) + 1;
    noMatchStreak.set(account.name, streak);
    if (streak >= config.NO_MATCH_EXHAUST_THRESHOLD) {
      rotator.markExhausted(account, `no matching bids in ${streak} cycles`);
      cycleLog.warn("account.exhausted.no_match", { streak });
      continue;
    }

    const wait = randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS);
    cycleLog.info("cycle.retry.sleep", { ms: wait });
    await sleep(wait);
  }
}

async function shutdown(signal, logger) {
  logger.info("daemon.shutdown", { signal });
  await logger.drain().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error("fatal:", err);
  try {
    const cfg = loadConfig();
    await notify.notifyCrash(err, {
      botToken: cfg.TELEGRAM_BOT_TOKEN,
      chatId: cfg.TELEGRAM_CHAT_ID,
    });
  } catch { /* swallow secondary errors */ }
  process.exit(1);
});
