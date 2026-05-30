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
import * as accountsRepo from "./db/repo/accounts.js";
import { createPool, closePool, ping as dbPing } from "./db/pool.js";
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

// Stop the bleed when we have an on-chain lease we cannot run a workload on
// (no group available, or DB tx failed after lease success). Tries DELETE
// first — refunds remaining escrow. If close fails, PATCH auto-topup off as
// backstop so the wallet can't keep refilling a draining escrow. Always
// resolves with status flags; never throws.
async function containLeasedDeployment({ ctx, dseq, akash, logger, reason }) {
  let closed = false;
  let autoTopUpDisabled = false;
  try {
    await akash.closeDeployment(ctx, dseq);
    closed = true;
    logger.info("containment.close.ok", { dseq, reason });
  } catch (err) {
    logger.error("containment.close.failed", { dseq, reason, error: err.message });
  }
  if (!closed) {
    try {
      await akash.disableAutoTopUp(ctx, dseq);
      autoTopUpDisabled = true;
      logger.warn("containment.auto_topup.disabled", { dseq, reason });
    } catch (err) {
      logger.error("containment.auto_topup.disable.failed", { dseq, reason, error: err.message });
    }
  }
  return { closed, autoTopUpDisabled };
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

  const dbWired = !!(deploymentsRepoDep && groupsRepoDep);

  // Best-effort group release. Swallows DB errors — caller path is already
  // unwinding for some other reason, and the sweeper will pick up any leak
  // at the GROUP_LOCK_PENDING_MINUTES TTL anyway.
  const releaseGroupSafe = async (cycleLog, name) => {
    if (!dbWired || !name) return;
    try {
      await groupsRepoDep.release(name);
      cycleLog.info("group.released", { group: name });
    } catch (e) {
      cycleLog.warn("group.release.failed", { group: name, error: e.message });
    }
  };

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

      // ── Pre-flight: lock a group BEFORE POST so the SDL ships with the real
      // GROUP_NAME baked in (single ReplicaSet on the provider, no PUT).
      // If no AVAILABLE group, skip the cycle entirely — no POST, no escrow
      // at risk. Operator adds capacity via `npm run db:seed-groups`.
      let group = null;
      if (dbWired) {
        try {
          group = await groupsRepoDep.lockNextAvailablePending(
            account.id,
            account.workspace,
            config.GROUP_LOCK_PENDING_MINUTES,
          );
        } catch (err) {
          cycleLog.error("group.lock.pending.failed", { error: err.message });
          await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
          continue;
        }
        if (!group) {
          cycleLog.warn("no_group.skip_cycle", { workspace: account.workspace });
          await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
          continue;
        }
        cycleLog.info("group.locked.pending", {
          group: group.name,
          ttl_min: config.GROUP_LOCK_PENDING_MINUTES,
        });
      }

      // Bake real GROUP_NAME into SDL (per-cycle). Test path with no
      // sdlTemplate/sdlMod falls back to raw `sdl` for compatibility.
      let cycleSdl = sdl;
      if (group && sdlTemplate && sdlInjector) {
        try {
          cycleSdl = sdlInjector.injectGroupName(sdlTemplate, group.name);
        } catch (err) {
          cycleLog.error("sdl.inject.failed", { group: group.name, error: err.message });
          await releaseGroupSafe(cycleLog, group.name);
          await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
          continue;
        }
      }

      let dseq;
      let manifest;
      try {
        const created = await akash.createDeployment(ctx, cycleSdl, config.DEPOSIT_USD);
        dseq = created.dseq;
        manifest = created.manifest;
        cycleLog.info("deployment.created", {
          dseq,
          txHash: created.txHash,
          group: group?.name ?? null,
        });
      } catch (err) {
        if (!(err instanceof AkashApiError)) throw err;
        if (err.status === 401) {
          cycleLog.warn("auth.fail", { status: 401 });
          await notify.notifyAuthFail(account, tgCfg(config, cycleLog));
          await releaseGroupSafe(cycleLog, group?.name);
          exitReason = "401";
          break;
        }
        if (/insufficient|credit|balance/i.test(JSON.stringify(err.body || ""))) {
          await releaseGroupSafe(cycleLog, group?.name);
          exitReason = `insufficient credit on create: ${err.status}`;
          break;
        }
        cycleLog.warn("deployment.create.failed", { status: err.status, error: err.message });
        await releaseGroupSafe(cycleLog, group?.name);
        await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
        continue;
      }

      // Promote the pending lock to full TTL with the dseq bound. Crash window
      // shrinks to ~30s (between POST success and this bind) instead of ~120s
      // bid wait — and any orphan still gets swept at PENDING_MINUTES TTL.
      if (group) {
        try {
          await groupsRepoDep.bindLockToDseq(group.name, dseq, config.GROUP_LOCK_HOURS);
        } catch (err) {
          // Programming error or DB outage. Close on-chain to stop escrow drain,
          // release the group, sleep + retry.
          cycleLog.error("group.bind.failed", { group: group.name, dseq, error: err.message });
          await akash.closeDeployment(ctx, dseq).catch(() => {});
          await releaseGroupSafe(cycleLog, group.name);
          await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
          continue;
        }
      }

      let owner;
      try {
        owner = await akash.getOwnerAddress(ctx, dseq);
        cycleLog.info("owner.resolved", { owner });
      } catch (err) {
        if (!(err instanceof AkashApiError)) throw err;
        cycleLog.warn("owner.resolve.failed", { error: err.message });
        await akash.closeDeployment(ctx, dseq).catch(() => {});
        await releaseGroupSafe(cycleLog, group?.name);
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

        // SDL was POSTed with the real GROUP_NAME already baked in — no PUT
        // needed, no second ReplicaSet on the provider. Status is PUT_OK
        // directly on insert.
        let putStatus = null;
        if (dbWired) {
          try {
            await deploymentsRepoDep.insert({
              dseq,
              accountId: account.id,
              groupName: group.name,
              provider: result.bid?.provider ?? null,
              uactPerBlock: result.bid?.uactPerBlock ?? null,
              status: "PUT_OK",
              leasedAt: now,
              expiresAt,
            });
            putStatus = "PUT_OK";
            cycleLog.info("deployment.recorded", { dseq, group: group.name });
          } catch (err) {
            // Orphan: chain lease succeeded, DB insert failed. Same containment
            // path as before — try to close on-chain (refunds escrow); if close
            // fails, disable auto-topup so wallet can't refill the drain.
            const containment = await containLeasedDeployment({
              ctx, dseq, akash, logger: cycleLog, reason: "orphan",
            });
            cycleLog.error("lease.orphan", {
              dseq, account: account.name, error: err.message, ...containment,
            });
            await notify.notifyLeaseOrphan(
              { account, dseq, error: err.message, containment },
              tg,
            );
            await releaseGroupSafe(cycleLog, group.name);
            putStatus = "ORPHAN";
            // Skip the auto-topup PATCH and 1h hold — there's no row to track.
            await notify.notifyLeaseSuccess(
              { bid: result.bid, lease: result.lease, account, group: group.name, putStatus },
              tg,
            );
            await sleep(randomBetween(config.RETRY_MIN_MS, config.RETRY_MAX_MS), abortSignal);
            continue;
          }

          // Disable console managed-wallet auto-topup. Cost guard.
          // Non-fatal: sweeper retries on its tick if this PATCH fails.
          try {
            await akash.disableAutoTopUp({ account, config, logger: cycleLog }, dseq);
            await deploymentsRepoDep.markAutoTopUpDisabled(dseq, account.id)
              .catch((e) => cycleLog.warn("db.deployment.update.failed", { error: e.message }));
            cycleLog.info("deployment.auto_topup.disabled", { dseq });
          } catch (err) {
            cycleLog.warn("deployment.auto_topup.disable.failed", { dseq, error: err.message });
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

      // No bid matched (or all leases failed). Close the on-chain deployment
      // (refunds escrow) and release the group so another account can take it.
      try {
        await akash.closeDeployment(ctx, dseq);
        cycleLog.info("deployment.closed", { dseq });
      } catch (err) {
        cycleLog.warn("deployment.close.failed", { dseq, error: err.message });
      }
      await releaseGroupSafe(cycleLog, group?.name);

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
    accountsRepo, akash: akashImpl,
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
