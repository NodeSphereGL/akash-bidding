// Akash GPU auto-bidding daemon. Each account runs its own async loop via
// `runAccountLoop`. The supervisor spawns N loops with `Promise.allSettled`;
// when every account returns EXHAUSTED, it notifies, cools off, and respawns.
// SIGINT/SIGTERM aborts all loops via a shared AbortController.

import { resolve } from "node:path";

import { loadConfig, uactPerBlockToUsdPerHour } from "./config.js";

function summarizeResources(bid) {
  const offer = bid?.resources_offer?.[0]?.resources;
  if (!offer) return null;
  const gpu = offer.gpu || {};
  const gpuAttrs = Array.isArray(gpu.attributes)
    ? gpu.attributes.map((a) => ({ k: a?.key, v: a?.value }))
    : gpu.attributes;
  return {
    cpu: offer.cpu?.units?.val,
    memory: offer.memory?.quantity?.val,
    storage: Array.isArray(offer.storage) ? offer.storage.map((s) => s?.quantity?.val) : offer.storage?.quantity?.val,
    gpuUnits: gpu.units?.val,
    gpuAttrs,
  };
}
import { createLogger } from "./logger.js";
import { loadAccountsFromDb } from "./accounts-loader.js";
import { filterAndRank } from "./bidder.js";
import * as akashImpl from "./akash.js";
import { AkashApiError } from "./errors.js";
import * as notifyImpl from "./notify.js";
import * as sdlMod from "./sdl.js";
import * as groupsRepo from "./db/repo/groups.js";
import * as deploymentsRepo from "./db/repo/deployments.js";
import { createPool, closePool, ping as dbPing } from "./db/pool.js";
import { postLeaseAtomic } from "./post-lease.js";
import { NoGroupAvailableError } from "./errors.js";
import { startSweeper } from "./sweeper.js";
import { startApiServer } from "./api/server.js";

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
        usdPerHour: Number(uactPerBlockToUsdPerHour(candidate.uactPerBlock).toFixed(4)),
        model: candidate.model,
        resources: summarizeResources(candidate.bid),
      });
      return { leased: true, lease, bid: candidate };
    } catch (err) {
      logger.warn("lease.attempt.failed", {
        provider: candidate.provider,
        model: candidate.model,
        status: err?.status,
        error: err.message,
        uactPerBlock: candidate.uactPerBlock,
        usdPerHour: Number(uactPerBlockToUsdPerHour(candidate.uactPerBlock).toFixed(4)),
        compositeId: candidate.compositeId,
        resources: summarizeResources(candidate.bid),
        apiBody: err?.body,
      });
    }
  }
  return { leased: false };
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 3600_000);
}

/**
 * Runs the bidding loop for one account. Returns when the account exhausts
 * itself or when the shared abortSignal fires.
 *
 * @param {object} account
 * @param {{
 *   config: object,
 *   sdl: string,
 *   sdlTemplate?: object,
 *   logger: object,
 *   notify: object,
 *   akash: object,
 *   sdlMod?: object,
 *   groupsRepo?: object,
 *   deploymentsRepo?: object,
 *   abortSignal?: AbortSignal,
 * }} deps
 * @returns {Promise<{ reason: string }>}
 */
export async function runAccountLoop(account, deps) {
  const { config, sdl, sdlTemplate, logger, notify, akash, abortSignal } = deps;
  const sdlInjector = deps.sdlMod;
  const groupsRepoDep = deps.groupsRepo;
  const deploymentsRepoDep = deps.deploymentsRepo;
  const loopLog = logger.child({ account: account.name });
  loopLog.info("account.loop.start", { workspace: account.workspace });

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
        const tg = tgCfg(config, cycleLog);
        const now = new Date();
        const expiresAt = addHours(now, config.GROUP_LOCK_HOURS);

        // 1+2. Atomic: insert deployments row AND lock next group, or neither.
        let group = null;
        let putStatus = null;
        const dbWired = !!(deploymentsRepoDep && groupsRepoDep);
        if (dbWired) {
          try {
            const r = await postLeaseAtomic({
              db: { deploymentsRepo: deploymentsRepoDep, groupsRepo: groupsRepoDep },
              dseq,
              account,
              leaseResult: result,
              hours: config.GROUP_LOCK_HOURS,
              now,
              expiresAt,
            });
            group = r.group;
          } catch (err) {
            if (err instanceof NoGroupAvailableError) {
              cycleLog.warn("group.none-available", { dseq, workspace: account.workspace });
              putStatus = "NO_GROUP";
              if (notify.notifyPutFailed) {
                await notify.notifyPutFailed(
                  { dseq, reason: "no available group", group: null, account },
                  tg,
                );
              }
            } else {
              // Lease succeeded on-chain but DB tx failed → no row, no lock.
              // Operator must close the on-chain deployment manually.
              cycleLog.error("lease.orphan", { dseq, account: account.name, error: err.message });
              await notify.notifyLeaseOrphan({ account, dseq, error: err.message }, tg);
              putStatus = "ORPHAN";
            }
          }
        }

        // 3. inject GROUP_NAME and PUT new SDL (only when we own a group)
        if (group && sdlTemplate && sdlInjector) {
          try {
            const newSdl = sdlInjector.injectGroupName(sdlTemplate, group.name);
            await akash.updateDeployment({ account, config, logger: cycleLog }, dseq, newSdl);
            await deploymentsRepoDep.updateStatus(dseq, account.id, "PUT_OK", {
              group_name: group.name,
              put_attempts: 1,
            }).catch((e) => cycleLog.warn("db.deployment.update.failed", { error: e.message }));
            putStatus = "PUT_OK";
            cycleLog.info("deployment.put.ok", { dseq, group: group.name });

            // 4. Disable console managed-wallet auto-topup. Cost guard.
            // Non-fatal: if PATCH fails, sweeper retries on its tick.
            try {
              await akash.disableAutoTopUp({ account, config, logger: cycleLog }, dseq);
              await deploymentsRepoDep.markAutoTopUpDisabled(dseq, account.id)
                .catch((e) => cycleLog.warn("db.deployment.update.failed", { error: e.message }));
              cycleLog.info("deployment.auto_topup.disabled", { dseq });
            } catch (err) {
              cycleLog.warn("deployment.auto_topup.disable.failed", { dseq, error: err.message });
            }
          } catch (err) {
            cycleLog.error("deployment.put.failed", { dseq, group: group.name, error: err.message });
            await deploymentsRepoDep.updateStatus(dseq, account.id, "PUT_FAILED", {
              group_name: group.name,
              last_error: err.message,
              put_attempts: 1,
            }).catch((e) => cycleLog.warn("db.deployment.update.failed", { error: e.message }));
            await groupsRepoDep.update(group.name, {
              status: "PUT_FAILED",
              last_error: err.message,
            }).catch((e) => cycleLog.warn("db.group.update.failed", { error: e.message }));
            if (notify.notifyPutFailed) {
              await notify.notifyPutFailed(
                { dseq, reason: err.message, group: group.name, account },
                tg,
              );
            }
            putStatus = "PUT_FAILED";
          }
        }

        await notify.notifyLeaseSuccess(
          { bid: result.bid, lease: result.lease, account, group: group?.name ?? null, putStatus },
          tg,
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

  // DB pool first — accounts come from there, repos need it.
  createPool(config);
  try {
    await dbPing();
    logger.info("db.connected", { host: config.MYSQL_HOST, db: config.MYSQL_DATABASE });
  } catch (err) {
    logger.error("db.connect.failed", { error: err.message });
    await notifyImpl.notifyFatal("DB Connect Failed", err, tgCfg(config, logger));
    process.exit(1);
  }

  let sdlTemplate;
  let sdl;
  try {
    sdlTemplate = await sdlMod.loadTemplate(resolve(config.SDL_PATH));
    sdl = sdlTemplate.raw;
  } catch (err) {
    logger.error("sdl.load.failed", { path: config.SDL_PATH, error: err.message });
    await notifyImpl.notifySdlFail(err, tgCfg(config, logger));
    process.exit(1);
  }

  let accounts;
  try {
    accounts = await loadAccountsFromDb();
  } catch (err) {
    logger.error("accounts.load.failed", { error: err.message });
    await notifyImpl.notifyFatal("Accounts Load Failed", err, tgCfg(config, logger));
    process.exit(1);
  }
  logger.info("accounts.loaded", { count: accounts.length, source: "db" });

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
    config, sdl, sdlTemplate, logger, notify: notifyImpl, akash: akashImpl,
    sdlMod, groupsRepo, deploymentsRepo,
    abortSignal: abortController.signal,
  };

  startSweeper({
    config, logger, notify: notifyImpl, groupsRepo, deploymentsRepo,
    accounts, akash: akashImpl,
    abortSignal: abortController.signal,
  });

  const apiServer = startApiServer({
    config, logger, abortSignal: abortController.signal,
  });
  if (apiServer) {
    abortController.signal.addEventListener("abort", () => {
      apiServer.close(() => logger.info("api.closed", {}));
    }, { once: true });
  }

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

  await closePool().catch(() => {});
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
