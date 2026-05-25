---
phase: 1
title: Pin Current Behavior with Tests
status: completed
priority: P2
effort: 2-3h
dependencies: []
---

# Phase 1: Pin Current Behavior with Tests

## Overview

TDD lock-step. Before touching `src/index.js`, write characterization tests that pin the orchestration invariants we must preserve through the refactor: bidder filter/rank, rotator round-robin semantics (still in use this phase), logger child propagation, notify-side-effects on lease success / auth fail / depleted. No production code change in this phase — tests must pass on current code.

## Requirements

- Functional: every test added asserts an observable behavior the refactor MUST preserve.
- Non-functional: zero changes to `src/index.js`, `src/rotator.js`, or any other production source.
- Run-time: `npm test` exits 0.

## Architecture

Two new pieces:
1. A minimal **orchestrator test harness** that wires fake `akash.*` + fake `notify.*` + in-memory logger to drive ONE iteration of the current cycle body. Because the current cycle body is inlined in `main()`, we cannot import it directly — so this phase only locks behavior at the COMPONENT boundary (bidder, rotator, logger, notify shape).
2. Augmented existing test files with edge cases discovered during scout that were not previously covered (e.g., `rotator.next()` ring wrap-around when middle of ring is exhausted; logger child key precedence).

The runAccountLoop extraction happens in Phase 2 — at that point, full cycle-level integration tests become possible. This phase deliberately does NOT extract code; it only fortifies the unit-level safety net.

## Related Code Files

- Create: `tests/orchestrator-invariants.test.js`
- Modify: `tests/rotator.test.js` (add ring wrap-around edge cases if missing)
- Modify: `tests/logger.test.js` (add child-context concurrency case — two child loggers, interleaved writes, both lines present and parseable)
- Read-only: `src/index.js`, `src/rotator.js`, `src/logger.js`, `src/bidder.js`, `src/notify.js`

## Implementation Steps

1. **Inventory current tests** — read each `tests/*.test.js`, list which behaviors are asserted. Note gaps relevant to the refactor.
2. **Add `tests/orchestrator-invariants.test.js`** — assertions:
   - `filterAndRank` + `rotator.next` combined dataflow: rotator returns A → bidder returns [bid1, bid2] sorted DESC → top of fallback list matches manual sort.
   - Notify event shape: importing `notify.notifyLeaseSuccess` with a fake `botToken=""` / `chatId=""` returns without throwing (silent disable path).
   - `AllExhaustedError` is thrown by `rotator.next()` when all accounts exhausted (regression guard before deletion in Phase 3).
3. **Augment `tests/logger.test.js`** — concurrent-writer case: create two child loggers (`logger.child({account:"a"})`, `logger.child({account:"b"})`), fire 50 interleaved `.info()` calls each, drain, read the log file, assert all 100 lines parse as JSON and the `.account` field round-trips correctly.
4. **Augment `tests/rotator.test.js`** — add: with ring `[A,B,C]`, after `markExhausted(B)`, calling `next()` 4 times yields `A, C, A, C` (skip B forever).
5. **Run `npm test`** — all green on current code.
6. `ck plan check 1` when all assertions pass.

## Success Criteria

- [ ] `tests/orchestrator-invariants.test.js` exists and passes
- [ ] `tests/logger.test.js` covers concurrent child writers
- [ ] `tests/rotator.test.js` covers mid-ring exhaustion skip
- [ ] `npm test` exits 0
- [ ] No production file modified

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Tests over-pin implementation details that the refactor needs to change | Pin OUTPUTS / event shapes / notify-call-counts, never internal call order |
| `AllExhaustedError` test becomes a Phase 3 deletion blocker | Mark the assertion `// guard: remove with Phase 3 rotator deletion` so the future delete is obvious |
| Logger concurrency test is flaky on slow CI | Use `await logger.drain()` before reading the file; no setTimeout-based assertions |
