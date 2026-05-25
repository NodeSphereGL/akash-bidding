---
title: Per-Account Concurrent Bidding Loops
description: >-
  Replace single sequential orchestrator with N independent per-account async
  loops. Account A's 1h lease hold no longer blocks accounts B..N. TDD mode
  locks current behavior before restructuring.
status: completed
priority: P2
branch: main
tags:
  - akash
  - concurrency
  - refactor
  - bidding-daemon
blockedBy: []
blocks: []
created: '2026-05-25T03:14:20.081Z'
createdBy: 'ck:plan'
source: skill
---

# Per-Account Concurrent Bidding Loops

## Overview

Today `src/index.js:134` runs ONE `while(true)` loop. Every `rotator.next()` picks one account; `lease.success` sleeps `LEASE_HOLD_MS` (1h) blocking all other accounts. This plan refactors the orchestrator so each account runs an independent async loop coordinated by a tiny supervisor — Promise.all over N per-account loops, in-process, no worker_threads.

Brainstorm summary: [./reports/brainstorm-summary.md](./reports/brainstorm-summary.md)

## Goals

- Per-account cycles run concurrently. Account A's 1h hold does NOT block B's bidding.
- Delete `src/rotator.js` + `tests/rotator.test.js`. Per-loop owns its own state.
- All-exhausted: notify + cool-off `RETRY_MAX_MS` + respawn all loops (match current TEMP-DISABLE-STOP semantics).
- SIGINT/SIGTERM gracefully aborts all loops via shared `AbortController`.
- No regression: `bidder.test.js`, `logger.test.js`, `config.test.js`, `errors.test.js` keep passing.

## Non-Goals

- Worker threads / child processes.
- Persistence of exhausted state across restarts.
- SDL mutation per account.
- Telegram rate-limit throttling.
- Tracking/closing leases after 1h hold (Akash auto-evicts).

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Pin Current Behavior with Tests](./phase-01-pin-current-behavior-with-tests.md) | Completed |
| 2 | [Extract runAccountLoop (Single-Threaded)](./phase-02-extract-runaccountloop-single-threaded.md) | Completed |
| 3 | [Multi-Loop Supervisor and Delete Rotator](./phase-03-multi-loop-supervisor-and-delete-rotator.md) | Completed |
| 4 | [Docs Cleanup and E2E Validation](./phase-04-docs-cleanup-and-e2e-validation.md) | Completed |

## Key Files

- Modify: `src/index.js`
- Delete: `src/rotator.js`, `tests/rotator.test.js`
- Modify: `src/errors.js` (drop `AllExhaustedError` if no other callers)
- Modify: `README.md`, `docs/run-and-ops.md`
- Add: `tests/orchestrator-invariants.test.js` (Phase 1)
- Add: `tests/orchestrator-concurrency.test.js` (Phase 3)

## Dependencies

Supersedes the "No concurrent bidding cycles" limitation from plan `260525-1500-akash-auto-bidding-tool` (no formal block — that plan's code is already shipped on `main`).

## Acceptance Criteria (whole-plan)

1. With ≥2 healthy accounts, ≥2 deployments can be in-flight simultaneously (verified via log grouping on `.account`).
2. Account A `lease.success` 1h hold does NOT block account B's `cycle.start`.
3. Account A 401 marks A exhausted; B/C continue running.
4. All-exhausted → `all.accounts.exhausted` log + Telegram → cool-off → all loops respawn.
5. SIGINT/SIGTERM aborts all loops; `Promise.allSettled` resolves; process exits 0.
6. Per-iteration exception caught inside the loop; only out-of-band errors crash process.
7. `npm test` passes; new `tests/orchestrator.test.js` covers loop behavior.
