---
phase: 4
title: Docs Cleanup and E2E Validation
status: completed
priority: P2
effort: 1-2h
dependencies:
  - 3
---

# Phase 4: Docs Cleanup and E2E Validation

## Overview

Documentation sync + live 2-account smoke test against the real Akash console-api. Confirm acceptance criteria 1-6 in production conditions before merging.

## Requirements

- Functional: docs reflect new concurrent architecture; live run demonstrates concurrent cycles.
- Non-functional: `README.md` "Known limitations" no longer lists "No concurrent bidding cycles."; `docs/run-and-ops.md` includes log-filtering tip for `.account` field.

## Architecture

No code change in this phase except minor logger event additions if smoke surfaces gaps.

## Related Code Files

- Modify: `README.md`
- Modify: `docs/run-and-ops.md`
- Read-only: `src/index.js`, `logs/akash-bidding.log` (smoke artifact)

## Implementation Steps

1. **README.md**:
   - Remove the "No concurrent bidding cycles." bullet from "Known limitations (v1)".
   - Update the "What it does (per cycle)" section to clarify it now runs PER ACCOUNT concurrently. Reword step 1 from "Round-robin pick the next account" to "Each account runs an independent async loop in the same process".
   - Add a short "Concurrency" subsection: N async loops in same process, per-account proxy + apiKey, startup jitter, supervisor respawns all when every account exhausted.
2. **docs/run-and-ops.md**:
   - Add log-filtering tip: `tail -f logs/akash-bidding.log | jq 'select(.account=="alpha")'`.
   - Note that lease.success no longer pauses the daemon — only pauses that account.
3. **Live smoke test** (real Akash, 2 accounts, low USD/hour cap to provoke no-match path quickly):
   - Set `MAX_USD_PER_HOUR` low enough that bids will be filtered out (forces no-match path).
   - Run `npm start`.
   - In another terminal: `tail -f logs/akash-bidding.log | jq -c '{ts, account, event}'`.
   - Verify acceptance criteria:
     - [ ] AC1: events from both accounts interleave within 5min window.
     - [ ] AC2: while account A is in `cycle.hold` (lease success), account B emits `cycle.start` within seconds.
     - [ ] AC3: invalidate one account's apiKey mid-run; only that account exhausts.
     - [ ] AC4: invalidate both → `all.accounts.exhausted` + Telegram + respawn after cool-off.
     - [ ] AC5: Ctrl-C → both loops exit, process exits 0 within `BID_POLL_INTERVAL_MS`.
4. **Update plan.md table** statuses to Completed for phases 1-3.
5. `ck plan check 4`.
6. **Hand off** to `/ck:journal` to write retrospective.

## Success Criteria

- [ ] `README.md` updated (limitations + per-cycle description + concurrency subsection)
- [ ] `docs/run-and-ops.md` updated (log filter + lease behavior note)
- [ ] Live 2-account smoke run captures evidence for AC1-AC5 in journal
- [ ] All 4 phases marked completed in `plan.md`
- [ ] `/ck:journal` entry written

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Live smoke costs USD (creates real deployments) | Use low `MAX_USD_PER_HOUR` so no leases are taken — only no-match path exercised; close deployments verified |
| Live console-api rate-limits when both accounts hit simultaneously | Each account has own apiKey + proxy → independent quotas. If rate-limit observed, capture in journal as a Phase 5 follow-up |
| Smoke run reveals concurrency bug not caught by tests | Roll back to Phase 2 commit; add failing test case; iterate Phase 3 |
| Documentation drift between README and code | Cross-check: README per-cycle description matches actual log event sequence emitted by `runAccountLoop` |
