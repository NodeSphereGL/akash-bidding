---
phase: 5
title: "Sweeper and Telegram Nag"
status: implemented
priority: P2
effort: "2h"
dependencies: [1, 4]
---

# Phase 5: Sweeper and Telegram Nag

## Overview

Background timer task started by the supervisor. Every `SWEEP_INTERVAL_MS`
(default 5 min):

1. Release group locks whose `expires_at < NOW()` (status=LOCKED → AVAILABLE).
2. Mark deployments with `expires_at < NOW()` as EXPIRED.
3. For each group with `status=PUT_FAILED` whose `last_nag_at` is null or
   older than `PUT_NAG_INTERVAL_MS` (default 30 min) → fire Telegram,
   update `last_nag_at`.

No Akash close calls (per decision — auto-evicts).

## Requirements

- Functional:
  - Sweeper starts when supervisor starts; stops on SIGINT/SIGTERM.
  - Each sweep cycle logs `sweeper.cycle.start` and `sweeper.cycle.done` with counts.
  - PUT_FAILED nag fires per group, not per sweep — respects `last_nag_at`.
  - Sweeper does NOT block the supervisor / account loops.
- Non-functional:
  - Sweep cycle wrapped in try/catch; one bad cycle doesn't kill the timer.
  - Bulk SQL operations (single UPDATE for batch expire).

## Architecture

```
src/
  sweeper.js             ← NEW: startSweeper(deps), stop()
  index.js               ← MODIFIED: main() starts sweeper alongside loops
  notify.js              ← MODIFIED: + notifyPutFailedNag(group, account, hoursLeft)
  notify.js              ← MODIFIED: + notifySweepRelease(count) [optional, see below]
```

### sweeper.js skeleton

```js
import { groupsRepo, deploymentsRepo } from "./db/repo/...";

export function startSweeper({ config, logger, notify, abortSignal }) {
  let stopped = false;
  const interval = setInterval(async () => {
    if (stopped || abortSignal.aborted) return;
    const log = logger.child({ component: "sweeper" });
    try {
      log.info("sweeper.cycle.start", {});
      const released = await groupsRepo.expireDue(new Date());
      const expired = await deploymentsRepo.expireDue(new Date());
      const nagDue = await groupsRepo.listPutFailedNagDue(config.PUT_NAG_INTERVAL_MS, new Date());
      for (const g of nagDue) {
        await notify.notifyPutFailedNag(g, tgCfg(config, log));
        await groupsRepo.markNagged(g.name, new Date());
      }
      log.info("sweeper.cycle.done", {
        released, expired, nagged: nagDue.length,
      });
      // optional: notify on releases for visibility
      if (released > 0) await notify.notifySweepRelease(released, tgCfg(config, log));
    } catch (e) {
      log.error("sweeper.cycle.error", { error: e.message });
    }
  }, config.SWEEP_INTERVAL_MS);

  abortSignal.addEventListener("abort", () => {
    stopped = true;
    clearInterval(interval);
  }, { once: true });
}
```

### Repo additions (Phase 1 already declared signatures; implement here if not)

```js
// groupsRepo
expireDue(now) → returns affectedRows
  UPDATE groups SET status='AVAILABLE', locked_by_account_id=NULL,
    locked_dseq=NULL, locked_at=NULL, expires_at=NULL
    WHERE status='LOCKED' AND expires_at < ?

listPutFailedNagDue(intervalMs, now) → rows
  SELECT * FROM groups WHERE status='PUT_FAILED'
    AND (last_nag_at IS NULL OR last_nag_at < ? - INTERVAL ? SECOND)
  (compute the cutoff in JS to avoid mixing arithmetic styles)

markNagged(name, now) → void
  UPDATE groups SET last_nag_at=? WHERE name=?

// deploymentsRepo
expireDue(now) → affectedRows
  UPDATE deployments SET status='EXPIRED'
    WHERE status IN ('LEASED','PUT_OK') AND expires_at < ?
```

### Notify additions

```js
// notify.js
export async function notifyPutFailedNag(group, cfg) {
  return sendTelegram(
    cfg,
    `⚠️ PUT FAILED — manual action required\n` +
    `Group: ${group.name}\n` +
    `Dseq: ${group.locked_dseq}\n` +
    `Account: ${group.locked_by_account_id}\n` +
    `Locked at: ${group.locked_at}\n` +
    `Expires at: ${group.expires_at}\n` +
    `Last error: ${group.last_error || "n/a"}\n\n` +
    `Fix manually then DELETE /v1/groups/${group.name}/lock or PUT status=AVAILABLE.`,
  );
}

export async function notifySweepRelease(count, cfg) {  // optional
  return sendTelegram(cfg, `🧹 Sweeper released ${count} group lock(s).`);
}
```

`notifySweepRelease` is optional — could be noisy. Default: only fire if
`count >= 3` to reduce chatter.

## Related Code Files

- Create:
  - `src/sweeper.js`
- Modify:
  - `src/index.js` — call `startSweeper(deps)` after loading accounts/sdl, before supervisor while-loop
  - `src/notify.js` — add `notifyPutFailedNag`, `notifySweepRelease`
  - `src/db/repo/groups.js` — implement `expireDue`, `listPutFailedNagDue`, `markNagged` (if stubs from Phase 1 not done)
  - `src/db/repo/deployments.js` — implement `expireDue`
- Delete: none

## Implementation Steps

1. Implement remaining repo methods (`expireDue`, `listPutFailedNagDue`, `markNagged`).
2. Write `src/sweeper.js` per skeleton.
3. Wire into `main()` in `src/index.js`: `startSweeper({ config, logger, notify: notifyImpl, abortSignal: abortController.signal })`.
4. Add `notifyPutFailedNag` and (optionally) `notifySweepRelease`.
5. Verify: insert a fake group with `expires_at = NOW() - INTERVAL 1 MINUTE, status='LOCKED'`. Run daemon for ~5 min, check it flips to AVAILABLE.
6. Verify nag: insert group with status='PUT_FAILED', last_nag_at=NULL. Confirm Telegram fires once, then doesn't fire again for 30 min.

## Success Criteria

- [ ] Sweeper logs `sweeper.cycle.start`/`done` every `SWEEP_INTERVAL_MS`.
- [ ] Expired LOCKED groups flip to AVAILABLE without operator action.
- [ ] Expired deployments rows flip to EXPIRED.
- [ ] PUT_FAILED groups receive Telegram nag every ~30 min until status changes.
- [ ] SIGINT cleanly stops the sweeper interval.
- [ ] One sweeper error doesn't kill the timer (verify by throwing inside repo briefly).

## Risk Assessment

- **Sweeper Telegram spam** — bounded by `last_nag_at` per row. Default 30 min. Operator can lengthen via `PUT_NAG_INTERVAL_MS`.
- **Clock skew between Node and MySQL** — irrelevant for 5-min granularity; use MySQL `NOW()` consistently in queries.
- **Sweeper crash during nag → group missed** — acceptable; next cycle picks it up.
- **Released group picked immediately by a waiting loop** — desired behavior.

## Notes

- Sweeper cadence (5 min) is conservative. Could go to 1 min if expiry precision matters; not needed for a 24h window.
- `notifySweepRelease` threshold of 3 keeps the channel quiet during normal nightly mass-release.
