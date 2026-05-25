# Brainstorm Summary — Per-Account Concurrent Bidding Loops

Date: 2026-05-25
Status: Approved by user, ready for `/ck:plan`

## Problem Statement

Current orchestrator (`src/index.js:134`) runs ONE sequential `while(true)` loop:
- `rotator.next()` picks 1 account
- run full cycle (create → poll → lease/close)
- on `lease.success` → `await sleep(LEASE_HOLD_MS)` (1h) — **all other accounts blocked**
- on no-match → random 60–180s sleep, then next account

Effect: with N accounts, daemon utilizes at most 1 account at a time. A 1h lease hold on account A freezes accounts B, C, ... for the full hour.

## Requirement

Each account runs its own independent cycle in parallel. Account A's `lease → sleep 1h` must NOT delay account B's bidding cycle.

## Approaches Evaluated

| # | Approach | Verdict |
|---|---|---|
| 1 | In-process async loops (one per account, Promise.all) | **CHOSEN** — matches I/O-bound workload, minimal LOC, KISS |
| 2 | `worker_threads` per account | Rejected — workload is HTTP I/O, no CPU benefit; adds IPC complexity |
| 3 | Child processes (one daemon per account) | Rejected — process-isolation overkill; needs external supervisor + per-process log routing |

## Final Solution

### Architecture

```
main()
  ├── load config + sdl + accounts
  ├── install signal handlers (SIGINT/SIGTERM → AbortController.abort)
  ├── supervisor loop:
  │     spawn N runAccountLoop(account, ...) in parallel
  │     await Promise.allSettled(loops)
  │     all settled → notify all-depleted → cool-off RETRY_MAX_MS → respawn
  └── on abort → exit 0
```

### Per-account loop

- Startup jitter: random 0–30s
- Loop-local `noMatchStreak` counter (replaces module-level Map)
- Full cycle inline: balance → create → poll → lease/close
- `lease.success` → sleep `LEASE_HOLD_MS` (1h) — affects ONLY this account
- 401 / insufficient-credit → return `EXHAUSTED`
- `noMatchStreak >= NO_MATCH_EXHAUST_THRESHOLD` → return `EXHAUSTED`
- Outer `try/catch` per iteration body — one bug never kills the loop

### Supervisor

After `Promise.allSettled` returns (all accounts exhausted):
- log `all.accounts.exhausted`
- `notifyAllDepleted`
- sleep `RETRY_MAX_MS`
- respawn all loops fresh (matches current TEMP-DISABLE-STOP semantics)

### Locked Design Decisions

1. **Concurrency primitive**: in-process async loops (`Promise.all`)
2. **All-exhausted policy**: notify + cool-off + respawn (no process exit)
3. **Rotator**: **delete** — per-loop owns local state
4. **Startup**: stagger via random jitter 0–30s

## Touchpoints

| File | Change |
|---|---|
| `src/index.js` | Extract `runAccountLoop`; replace main loop with supervisor; drop rotator/`noMatchStreak`-map plumbing |
| `src/rotator.js` | **Delete** |
| `tests/rotator.test.js` | **Delete** |
| `src/errors.js` | Drop `AllExhaustedError` (verify no other callers) |
| `src/logger.js` | No change — JSONL append is line-atomic, child logger ready |
| `src/akash.js` | No change — already ctx-scoped |
| `src/notify.js` | No change |
| `src/accounts-loader.js` | No change |
| `README.md` | Drop "No concurrent bidding cycles." from Known limitations |
| `docs/run-and-ops.md` | Note: filter logs by `.account` field |

## Acceptance Criteria

1. With 3 healthy accounts, 3 deployments can be in-flight simultaneously (verify via log grouping on `.account`)
2. Account A's `lease.success` 1h hold does NOT block account B's `cycle.start`
3. Account A 401 marks A exhausted; B/C continue
4. All-exhausted → `all.accounts.exhausted` + Telegram → cool-off → all loops respawn
5. SIGINT/SIGTERM aborts all loops, `Promise.allSettled` resolves, process exits 0
6. Per-iteration exception caught and loop continues; only out-of-band errors crash process
7. Existing tests pass (`bidder.test.js`, `logger.test.js`)

## Out of Scope

- Worker threads, child processes
- Persistence of exhausted state across restarts
- SDL mutation per account
- Telegram rate-limit throttling
- Tracking/closing leases after 1h hold

## Risks

| Risk | Mitigation |
|---|---|
| Loop dies silently, daemon "looks healthy" | Log `account.loop.exit` + Telegram on each loop exit |
| Concurrent JSONL writes interleave | None needed — append() line-atomic for one stringify + "\n" |
| Telegram burst on simultaneous lease.success | Acceptable at current N; revisit if N > 20 |
| Implicit global rate-limit lost (1h hold paced API hits) | Per-account API key + proxy isolates upstream; verify after first run |
| `rotator.status()` removed = lost debug surface | Supervisor tracks per-account state Map; log on supervisor cycle |

## Success Metrics

- Distinct `.account` values in any rolling 5-min window of logs ≈ healthy accounts (NOT 1)
- Wall-clock from `lease.success` (account A) → next `cycle.start` (account B) << `LEASE_HOLD_MS`
- No regressions in `tests/bidder.test.js`, `tests/logger.test.js`

## Next Steps

- `/ck:plan` to produce phase-by-phase implementation plan
- After plan: `/ck:cook` to implement
- Validate against acceptance criteria 1–7 on a 2-account test setup before production

## Unresolved Questions

None at brainstorm-close. Implementation may surface:
- Whether to drop `AllExhaustedError` entirely or repurpose (decide during implementation by grepping callers)
- Exact log event names for loop lifecycle (`account.loop.start` / `.exit`) — minor, finalize in code review
