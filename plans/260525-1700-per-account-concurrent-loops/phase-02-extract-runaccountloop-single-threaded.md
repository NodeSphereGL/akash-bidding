---
phase: 2
title: Extract runAccountLoop (Single-Threaded)
status: completed
priority: P1
effort: 3-4h
dependencies:
  - 1
---

# Phase 2: Extract runAccountLoop (Single-Threaded)

## Overview

Pure structural refactor — zero behavior change. Extract the inline cycle body in `src/index.js` (lines 134-242) into a named `runAccountLoop(account, deps)` async function. Supervisor still picks ONE account at a time via the existing rotator and calls `runAccountLoop` once per iteration. Single-threaded behavior preserved. Phase 1 tests + all existing tests must continue to pass.

TDD note: this phase is a refactor under a green test suite. The "red" step is conceptual — Phase 1 set up the safety net; this phase makes the code easier to test concurrently in Phase 3 without changing what's tested.

## Requirements

- Functional: zero observable behavior change. Same log events, same notify calls, same sleep durations, same rotator/exhaustion semantics.
- Non-functional: `runAccountLoop` is exported (named export) for Phase 3 testability.
- Concurrency: still strictly serial. No `Promise.all`. No `AbortController` yet.

## Architecture

Before (current):
```
main() {
  while (true) {
    account = rotator.next()
    ...cycle body inline...
  }
}
```

After (this phase):
```
export async function runAccountLoop(account, deps) {
  // Returns "EXHAUSTED" (with reason) when the loop should stop for this account.
  // Returns when caller signals stop (Phase 3 adds AbortSignal — not yet).
  let noMatchStreak = 0
  while (true) {
    // one iteration = one cycle = current cycle body verbatim
    // on EXHAUSTED conditions → return { reason }
    // on lease.success → sleep LEASE_HOLD_MS, continue
    // on no-match → sleep RETRY_MIN..MAX, continue
  }
}

async function main() {
  ...load config/sdl/accounts/logger/rotator...
  while (true) {
    let account
    try { account = rotator.next() } catch (AllExhaustedError) { ...current temp-disable-stop handling... }
    const result = await runAccountLoop(account, { config, sdl, logger, notify, akash })
    rotator.markExhausted(account, result.reason)
  }
}
```

`deps` arg = `{ config, sdl, logger, notify, akash }` — explicit injection so the test in Phase 3 can substitute fakes without `vi.mock`.

The single-threaded supervisor must ensure: after `runAccountLoop` returns EXHAUSTED, rotator marks the account exhausted and the outer loop picks the next one. After every account returns EXHAUSTED, current TEMP-DISABLE-STOP branch fires (notify + cool-off + rotator.reset).

## Related Code Files

- Modify: `src/index.js`
- Read-only: `src/rotator.js`, `src/akash.js`, `src/notify.js`, `src/logger.js`, `src/bidder.js`

## Implementation Steps

1. **Read `src/index.js`** end-to-end. Map every branch of current cycle body to its EXHAUSTED-vs-CONTINUE outcome.
2. **Extract `runAccountLoop(account, deps)`**:
   - Move the cycle body (balance check → create → owner → pollAndLease → lease-success-or-no-match) into the function.
   - Lift `noMatchStreak` from the module-level Map to a loop-local `let`.
   - Replace `cycleLog = logger.child({ account: account.name })` with `cycleLog = deps.logger.child({ account: account.name })`.
   - Every `rotator.markExhausted(account, reason); continue` becomes `return { reason }` (caller does the mark).
   - Every `await sleep(...); continue` stays as in-function loop continuation.
3. **Update `main()`**:
   - Keep `while (true)` outer loop.
   - On each iteration call `runAccountLoop(account, deps)`; when it returns, call `rotator.markExhausted(account, result.reason)`.
   - Preserve `AllExhaustedError` catch branch verbatim (TEMP-DISABLE-STOP semantics).
   - Move signal handlers + crash handlers unchanged.
4. **Export** `runAccountLoop` as named export from `src/index.js` for Phase 3 tests.
5. **Run `npm test`** — must pass without modification. If any test fails, the refactor broke behavior — fix or revert.
6. **Smoke run** — `npm start` locally with `accounts.json` of 1 fake account + short `BID_WAIT_MS` override; observe log events match pre-refactor baseline (same event names in same order: `daemon.start`, `accounts.loaded`, `cycle.start`, `account.healthy` or `auth.fail`, etc.).
7. `ck plan check 2`.

## Success Criteria

- [ ] `runAccountLoop` is a named export of `src/index.js` taking `(account, deps)` and returning `{ reason }` on exhaustion
- [ ] Module-level `noMatchStreak` Map removed; lives loop-local
- [ ] `main()` calls `runAccountLoop` once per iteration; rotator still picks one at a time
- [ ] All TEMP-DISABLE-STOP branch behavior preserved
- [ ] `npm test` exits 0 with no test file modified from Phase 1
- [ ] Smoke log diff vs baseline: zero changes in event order/names

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Hidden state in module scope missed during extraction | Grep `src/index.js` for `let `/`const ` at module scope after refactor; only allowed: `sleep`, `randomBetween`, `tgCfg`, `pollAndLease`, `runAccountLoop`, `main`, `shutdown` |
| `pollAndLease` helper accidentally captures stale logger | Pass `cycleLog` explicitly as before; verify by reading the function signature |
| Behavior drift via subtle reorder | Run smoke test against fake accounts.json and diff first 200 log lines vs main-branch baseline |
| Export breaks something on startup | `main()` only auto-runs at end of file; importing `runAccountLoop` from tests must NOT trigger `main()`. Wrap `main().catch(...)` in `if (import.meta.url === \`file://\${process.argv[1]}\`)` guard |
