---
phase: 5
title: "Orchestrator loop and greedy bid poll"
status: pending
priority: P1
effort: "5h"
dependencies: [2, 3, 4]
---

# Phase 5: Orchestrator loop and greedy bid poll

<!-- Updated: Validation Session 1 — config renamed: MAX_UACT_PER_BLOCK replaces MAX_USD_PER_HOUR + UACT_USD_RATE -->

## Overview

Implement `src/index.js` — the long-running daemon orchestrating the full cycle: account rotate → balance check → create deployment → greedy bid poll → lease (with fallback walk) → sleep. Heart of the tool. Greedy-first: poll exits as soon as one candidate appears; full 120s only used when no candidate ever shows.

## Requirements

- Functional: implements the cycle pseudocode in `plan.md` (R1–R10).
- Functional: greedy poll returns first matching candidate immediately; collects fallback list separately for lease retry.
- Non-functional: clean shutdown on SIGINT/SIGTERM; uncaught-exception handler notifies Telegram and exits 1.

## Architecture

```
main()
  ├── load config + accounts
  ├── load SDL as raw string
  ├── build rotator
  ├── install signal handlers (SIGINT, SIGTERM)
  ├── install uncaughtException + unhandledRejection handlers
  │
  └── loop forever:
        account = rotator.next()
        try:
           balance = akash.getBalance(account)
        catch (AkashApiError 401):
           notify.authFail(account)
           rotator.markExhausted(account, "401")
           if rotator.isAllExhausted(): notify.allDepleted() + exit(0)
           continue

        if balance < MIN_BALANCE_USD:
           rotator.markExhausted(account, `balance ${balance}`)
           if rotator.isAllExhausted(): notify.allDepleted() + exit(0)
           continue

        dseq = await akash.createDeployment(account, sdl, DEPOSIT_USD)
        result = await pollAndLease(account, dseq)

        if result.leased:
           await notify.leaseSuccess({ ...result, account })
           await sleep(LEASE_HOLD_MS)        # 1h
        else:
           await akash.closeDeployment(account, dseq)
           await sleep(randomBetween(RETRY_MIN_MS, RETRY_MAX_MS))
```

```
pollAndLease(account, dseq) → { leased: bool, lease?, bid? }
  start = now
  fallbackList = []
  while (now - start) < BID_WAIT_MS:
     raw = await akash.getBids(account, dseq)
     candidates = filterAndRank(raw, config)
     if candidates.length > 0:
        # GREEDY: try top candidate now, but keep rest for fallback
        [primary, ...rest] = candidates
        fallbackList = [primary, ...rest]
        break
     await sleep(BID_POLL_INTERVAL_MS)

  if fallbackList.empty:
     return { leased: false }

  for candidate in fallbackList:
     try:
        lease = await akash.createLease(account, candidate.compositeId, manifest)
        return { leased: true, lease, bid: candidate }
     catch (e):
        log.warn("lease attempt failed", { candidate, error: e.message })

  return { leased: false }   # all fallback attempts exhausted
```

## Related Code Files

- Create: `src/index.js`
- Create: `src/config.js` (env loader + constants)
- Modify: `package.json` (set `"main": "src/index.js"`, ensure `"start"` script)
- Read: all phase 2/3/4 modules

## Implementation Steps

1. Write `src/config.js`:
   - Load `.env` via `dotenv`.
   - Export typed constants: `DEPOSIT_USD`, `MIN_BALANCE_USD`, `MAX_UACT_PER_BLOCK` (parseInt), `GPU_BLACKLIST` (parsed array, lowercased), `BID_WAIT_MS`, `BID_POLL_INTERVAL_MS`, `LEASE_HOLD_MS`, `RETRY_MIN_MS`, `RETRY_MAX_MS`, `REQUEST_TIMEOUT_MS`, `SDL_PATH`, `ACCOUNTS_PATH`, `LOG_FILE`.
   - Validate required keys present and `MAX_UACT_PER_BLOCK > 0`; throw with clear message if missing/invalid.
   - **No** `UACT_USD_RATE`, **no** `MAX_USD_PER_HOUR` — dropped per validation session 1.
2. Write `pollAndLease` helper in `src/index.js` per pseudocode.
3. Write `sleep(ms)` and `randomBetween(min, max)` utilities (inline in index.js).
4. Write `main()`:
   - Load config, SDL, accounts.
   - Build rotator.
   - Install signal handlers (`SIGINT`, `SIGTERM`) → log + clean exit 0.
   - Install `process.on("uncaughtException", ...)` and `unhandledRejection` → notify.crash + exit 1.
   - Enter infinite loop per pseudocode.
5. Handle the manifest argument for `createLease`: per Phase 1 findings, lease body needs manifest derived from SDL — if API accepts raw SDL, reuse the SDL string; otherwise parse with `yaml` and convert.
6. Smoke-test against staging/single account: confirm full cycle runs end-to-end.

## Success Criteria

- [ ] Daemon runs an entire cycle (create → poll → lease OR close → sleep) without manual intervention.
- [ ] Greedy poll exits within seconds when bids appear; uses full 120s only when none match.
- [ ] Fallback lease walk attempts each candidate top-down.
- [ ] SIGINT triggers clean exit with "shutdown" log line.
- [ ] Uncaught exception sends Telegram + exits 1.
- [ ] Random retry sleep observed in 60–180s range (logged).
- [ ] No-match cycle followed by successful-cycle works (account state survives correctly).

## Risk Assessment

- **`createLease` manifest format** unknown until Phase 1 → block this phase until findings confirmed.
- **Infinite loop without backoff on persistent failures** → if every cycle fails, daemon spins fast. Mitigation: after N (e.g. 10) consecutive no-match cycles per account, mark account exhausted with reason "no matching bids in N cycles".
- **Memory leak from long-running fetches** → `pollAndLease` must clear all timers; verify with `--inspect` for 1h run.
- **Race condition: lease created but response lost** → out of scope for v1 (documented in non-goals).
