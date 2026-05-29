// Background timer. Every SWEEP_INTERVAL_MS:
//   1. Release expired LOCKED groups → AVAILABLE.
//   2. Mark expired deployments → EXPIRED.
//   3. Telegram-nag PUT_FAILED groups whose last_nag_at is older than PUT_NAG_INTERVAL_MS.
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

export function startSweeper({ config, logger, notify, groupsRepo, deploymentsRepo, abortSignal }) {
  const log = logger.child({ component: "sweeper" });
  log.info("sweeper.start", { intervalMs: config.SWEEP_INTERVAL_MS });

  let running = false;
  let stopped = false;

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

      log.info("sweeper.cycle.done", { released, expired, nagged });

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
