---
phase: 3
title: Multi-Loop Supervisor and Delete Rotator
status: completed
priority: P1
effort: 4-6h
dependencies:
  - 2
---

# Phase 3: Multi-Loop Supervisor and Delete Rotator

## Overview

The behavior-change phase. New failing tests first (red), then make them pass by switching the supervisor from `while+rotator` to `Promise.allSettled` over N concurrent `runAccountLoop` invocations. Per-loop owns its own state. Rotator + `AllExhaustedError` deleted. Startup jitter + `AbortController` for clean shutdown.

## Requirements

- Functional:
  - N accounts → N concurrent loops in same process.
  - Account A `await sleep(LEASE_HOLD_MS)` does NOT block account B.
  - All-exhausted: log + Telegram + sleep `RETRY_MAX_MS` + respawn all loops (matches current TEMP-DISABLE-STOP).
  - SIGINT/SIGTERM → all loops abort cleanly → `Promise.allSettled` resolves → exit 0.
  - Per-iteration exception caught inside loop; loop continues. Only `uncaughtException`/`unhandledRejection` kill process.
- Non-functional:
  - Startup jitter: random 0-30000ms before each loop's first iteration.
  - Logger remains safe under concurrent JSONL appends (line-atomic).
  - `npm test` exits 0; new orchestrator concurrency tests pass.

## Architecture

```
async function main() {
  ...load config/sdl/accounts/logger...
  const abortController = new AbortController()
  process.on("SIGINT",  () => abortController.abort("SIGINT"))
  process.on("SIGTERM", () => abortController.abort("SIGTERM"))
  // crash handlers unchanged

  while (!abortController.signal.aborted) {
    const loops = accounts.map(account =>
      runAccountLoop(account, { config, sdl, logger, notify, akash, abortSignal: abortController.signal })
    )
    const results = await Promise.allSettled(loops)
    logger.warn("all.accounts.exhausted", { results: summarize(results) })
    await notify.notifyAllDepleted(accounts.length, tgCfg(config, logger))
    await sleep(config.RETRY_MAX_MS, abortController.signal)
  }
  await logger.drain()
  process.exit(0)
}
```

`runAccountLoop` additions vs Phase 2:
- Accept `abortSignal` in `deps`.
- First line: `await sleep(random(0..30_000), abortSignal)` for startup jitter.
- Outer `while (!abortSignal.aborted)`.
- Outer-most `try/catch` around the iteration body so one unexpected throw never kills the loop (logs `cycle.unexpected`, sleeps `RETRY_MAX_MS`, continues).
- Returns when EXHAUSTED OR when abort fires.
- Emits `account.loop.start` on entry, `account.loop.exit` on return (with reason).

`sleep(ms, signal)` becomes abort-aware: rejects/resolves early when signal fires.

## Related Code Files

- Modify: `src/index.js`
- Delete: `src/rotator.js`
- Delete: `tests/rotator.test.js`
- Modify: `src/errors.js` (drop `AllExhaustedError` if no other callers — verify with grep)
- Create: `tests/orchestrator-concurrency.test.js`
- Read-only: `src/akash.js`, `src/notify.js`, `src/logger.js`, `src/bidder.js`

## Implementation Steps

1. **Write `tests/orchestrator-concurrency.test.js`** (red phase). Cases — all using fake `akash` + fake `notify` injected via `deps`:
   1. **independence**: two accounts, both healthy, fake `pollAndLease` makes account A's iteration take 500ms (simulated `LEASE_HOLD_MS`). Within 600ms, account B has completed ≥2 cycles. Asserts via timestamps in fake logger.
   2. **isolation**: account A fakes 401; account B continues. After A returns EXHAUSTED, B is still cycling.
   3. **abort**: fire `abortController.abort()` mid-cycle; assert both loops return within 50ms.
   4. **all-exhausted respawn**: both accounts return EXHAUSTED; supervisor calls `notifyAllDepleted` once, sleeps (use tiny `RETRY_MAX_MS=10` override), respawns. Assert `cycle.start` fires again on respawn.
   5. **per-iteration crash isolation**: fake `createDeployment` throws on iteration 1 for account A; assert `cycle.unexpected` logged, loop continues, iteration 2 runs normally.
2. **Run tests** — they FAIL against Phase 2 code. Confirm red state.
3. **Make `sleep` abort-aware**: tiny helper at top of `src/index.js`:
   ```js
   const sleep = (ms, signal) => new Promise((resolve) => {
     const t = setTimeout(resolve, ms)
     signal?.addEventListener("abort", () => { clearTimeout(t); resolve() }, { once: true })
   })
   ```
4. **Refactor `main()`** per architecture diagram above. Replace `while`+`rotator` block with `while (!abort)` + `Promise.allSettled`.
5. **Update `runAccountLoop`**:
   - Add `abortSignal` to `deps` destructuring.
   - Prepend startup jitter.
   - Wrap outer `while` in `while (!abortSignal.aborted)`.
   - Wrap iteration body in `try { ... } catch (err) { cycleLog.error("cycle.unexpected", {error:err.message}); await sleep(random(RETRY_MIN..MAX), abortSignal) }`.
   - Emit `account.loop.start` / `account.loop.exit` events.
6. **Delete rotator**: `git rm src/rotator.js tests/rotator.test.js`. Remove the import in `src/index.js`. Grep repo for `rotator` / `AllExhaustedError` — fix or remove remaining refs.
7. **Decide on `AllExhaustedError`**:
   - `grep -r "AllExhaustedError"` after rotator deletion.
   - If 0 callers → delete from `src/errors.js`.
   - If still referenced → keep (note in commit msg).
8. **Run all tests** — must pass. Phase 1's `AllExhaustedError` guard assertion should be removed at this point (it's the "remove with Phase 3 rotator deletion" comment).
9. **Smoke run** — local with 2 fake accounts (short timeouts):
   - Observe two concurrent `account.loop.start` events.
   - Observe both accounts' `cycle.start` events interleaved in log.
   - Send SIGINT — both loops exit, process exits 0 within seconds.
10. `ck plan check 3`.

## Success Criteria

- [ ] `tests/orchestrator-concurrency.test.js` passes all 5 cases
- [ ] `src/rotator.js` and `tests/rotator.test.js` deleted
- [ ] `AllExhaustedError` removed from `src/errors.js` (or justified retention noted)
- [ ] `main()` uses `Promise.allSettled` over `accounts.map(runAccountLoop)`
- [ ] `runAccountLoop` accepts `abortSignal`, emits `account.loop.start` + `account.loop.exit`
- [ ] SIGINT smoke test: both loops exit, process exits 0
- [ ] `npm test` exits 0
- [ ] No `setInterval` / no shared mutable state across loops

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Telegram burst when N loops `lease.success` simultaneously | Out of scope (N is small today); revisit if N > 20 — note in journal |
| `setTimeout` not cleared on abort → handle leak | The abort-aware `sleep` helper clears the timer in the `abort` listener |
| `Promise.allSettled` swallows a programming error inside a loop | Outer try/catch + `cycle.unexpected` log + Telegram via `notify.notifyFatal` on repeated unexpected (>5 in 10min) — optional, defer if simple counter not worth the surface |
| JSONL log line interleave at sub-line granularity on slow disks | `fs.appendFile` for single small writes (< PIPE_BUF, 4KB) is atomic on POSIX; verify current logger uses single `write()` per line. If it streams via `WriteStream`, single `.write(json+"\n")` is also serialized at stream level |
| Hidden global state from Phase 2 leaks across respawn | After respawn, every loop starts fresh — `noMatchStreak` is loop-local; verify no other module-level state |
| Test 1 (independence) timing flakiness | Use injected fake clocks or generous bounds (B completes ≥2 cycles in 600ms when each cycle is ~50ms). Use `node:test`'s `mock.timers` if needed |
| Aborting mid-`fetch` leaves dangling sockets | Pass `abortSignal` into `akash.*` calls — defer to Phase 4 if scope creeps; for Phase 3 the test only needs loops to return, not sockets to close |
