// Background timer. Every SWEEP_INTERVAL_MS:
//   1. Release expired LOCKED groups → AVAILABLE.
//   2. Mark expired deployments → EXPIRED.
//   3. Telegram-nag PUT_FAILED groups whose last_nag_at is older than PUT_NAG_INTERVAL_MS.
//   4. Retry disableAutoTopUp PATCH for rows still pending (auto_topup_disabled=FALSE).
//      Cost guard: deployments must not auto-refill escrow.
//
// No Akash close calls — Akash auto-evicts when deposit drains.

function tgCfg(config, logger) {
  return {
    botToken: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
    logger,
  };
}

const NOTIFY_RELEASE_THRESHOLD = 3;
// Alert once if auto-topup is still ON > 1h after lease — escrow may refill.
const AUTO_TOPUP_ALERT_THRESHOLD_MS = 60 * 60 * 1000;

export function startSweeper({ config, logger, notify, groupsRepo, deploymentsRepo, accounts, akash, abortSignal }) {
  const log = logger.child({ component: "sweeper" });
  log.info("sweeper.start", { intervalMs: config.SWEEP_INTERVAL_MS });

  const accountsById = new Map((accounts ?? []).map((a) => [a.id, a]));
  const alertedDseqs = new Set();

  let running = false;
  let stopped = false;

  async function retryAutoTopUp(now) {
    if (!akash?.disableAutoTopUp || !deploymentsRepo?.listPendingAutoTopUp) return { tried: 0, ok: 0, alerted: 0 };
    let rows;
    try {
      rows = await deploymentsRepo.listPendingAutoTopUp(50);
    } catch (e) {
      log.error("sweeper.auto_topup.list.failed", { error: e.message });
      return { tried: 0, ok: 0, alerted: 0 };
    }
    let tried = 0, ok = 0, alerted = 0;
    for (const row of rows) {
      const account = accountsById.get(row.account_id);
      if (!account) continue; // account was removed/disabled — leave row pending
      tried++;
      try {
        await akash.disableAutoTopUp({ account, config, logger: log }, row.dseq);
        await deploymentsRepo.markAutoTopUpDisabled(row.dseq, row.account_id);
        log.info("sweeper.auto_topup.retry.ok", { dseq: row.dseq, account: account.name });
        ok++;
        alertedDseqs.delete(row.dseq);
      } catch (err) {
        log.warn("sweeper.auto_topup.retry.failed", { dseq: row.dseq, account: account.name, error: err.message });
        const leasedAt = row.leased_at ? new Date(row.leased_at).getTime() : Date.now();
        const ageMs = now.getTime() - leasedAt;
        if (ageMs > AUTO_TOPUP_ALERT_THRESHOLD_MS && !alertedDseqs.has(row.dseq)) {
          alertedDseqs.add(row.dseq);
          alerted++;
          if (notify.notifyLeaseOrphan) {
            await notify.notifyLeaseOrphan(
              { account, dseq: row.dseq, error: `auto-topup disable still failing after ${Math.round(ageMs / 60000)}min: ${err.message}` },
              tgCfg(config, log),
            );
          }
        }
      }
    }
    return { tried, ok, alerted };
  }

  async function tick() {
    if (stopped || abortSignal?.aborted) return;
    if (running) return; // skip overlap
    running = true;
    try {
      log.info("sweeper.cycle.start", {});
      const now = new Date();
      const released = await groupsRepo.expireDue(now).catch((e) => {
        log.error("sweeper.expire.groups.failed", { error: e.message });
        return 0;
      });
      const expired = await deploymentsRepo.expireDue(now).catch((e) => {
        log.error("sweeper.expire.deployments.failed", { error: e.message });
        return 0;
      });

      let nagged = 0;
      try {
        const due = await groupsRepo.listPutFailedNagDue(config.PUT_NAG_INTERVAL_MS, now);
        for (const g of due) {
          await notify.notifyPutFailedNag(g, tgCfg(config, log));
          await groupsRepo.markNagged(g.name, new Date());
          nagged++;
        }
      } catch (e) {
        log.error("sweeper.nag.failed", { error: e.message });
      }

      const autoTopUp = await retryAutoTopUp(now);

      log.info("sweeper.cycle.done", { released, expired, nagged, autoTopUp });

      if (released >= NOTIFY_RELEASE_THRESHOLD) {
        await notify.notifySweepRelease(released, tgCfg(config, log));
      }
    } catch (err) {
      log.error("sweeper.cycle.error", { error: err.message });
    } finally {
      running = false;
    }
  }

  const interval = setInterval(tick, config.SWEEP_INTERVAL_MS);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    log.info("sweeper.stop", {});
  };

  abortSignal?.addEventListener("abort", stop, { once: true });

  return { stop, tick };
}
