---
phase: 4
title: Tests + docs
status: completed
priority: P2
effort: 2h
dependencies:
  - 2
  - 3
---

# Phase 4: Tests + docs

## Overview
Cover the new behaviour with tests and update operator-facing docs. Goal: regression-safety + clear go-live workflow.

## Requirements
- Functional: tests prove (a) backward compat when every row stays `'DEFAULT'`, (b) strict-equality at lock-time, (c) API filter + validation.
- Non-functional: docs explain workspace semantics, go-live re-tagging steps, and the `LOCKED` re-tag override.

## Related Code Files
- Modify: `tests/groups-repo-race.int.test.js` (existing integration test)
- Modify: `tests/api-validation.test.js` (existing API validation test)
- Create: `tests/workspace-lock.int.test.js` (new — strict equality coverage)
- Modify: `README.md`
- Modify: `docs/api-examples.md`
- Modify: `docs/group-management.md`
- Modify: `.env.example` (only if any new env var is added — none planned; verify)

## Implementation Steps

### 1. Update `tests/groups-repo-race.int.test.js`
- Existing race test calls `lockNextAvailable(accountId, dseq, lockHours)` — update to pass `'DEFAULT'` as the fourth arg.
- Confirm concurrent lock attempts within `'DEFAULT'` still serialise correctly (no behavioural change expected — just signature update).

### 2. Create `tests/workspace-lock.int.test.js`
Three scenarios at minimum:
- **Strict scoping**: seed 3 groups in workspace `A`, 2 in workspace `B`. Account in workspace `A` calls `lockNextAvailable` 5 times — must only ever lock the 3 `A` groups and return null on the 4th call.
- **Isolation under concurrency**: two accounts (`A`, `B`) call `lockNextAvailable` concurrently. Each only sees its workspace; no cross-contamination; no deadlock.
- **Empty workspace**: account in workspace `validator247` calls `lockNextAvailable` with zero v247 groups AVAILABLE → returns `null` (triggers `group.none-available` branch in loop).

### 3. Update `tests/api-validation.test.js`
- `POST /v1/groups` with valid workspace → 201, row has workspace.
- `POST /v1/groups` with workspace `"bad value!"` → 400.
- `GET /v1/groups?workspace=foo` → only foo rows.
- `PUT /v1/accounts/:id {"workspace": "validator247"}` → 200, persisted.

### 4. Docs

**`README.md`** — new "Workspace scoping" section after "Post-lease automation":
```
Each account belongs to exactly one workspace; each group belongs to exactly one
workspace. At lock-time the daemon picks only groups whose `workspace` equals
the account's `workspace`. Fresh installs land on `workspace='DEFAULT'` for
everything (single-pool behaviour). To partition (e.g. `validator247`):

  PUT /v1/accounts/<id>      {"workspace":"validator247"}
  PUT /v1/groups/v247_group_1 {"workspace":"validator247"}
  ...

Workspace values: 1-64 chars, `[a-z0-9_-]+`, case-insensitive.
```

**`docs/api-examples.md`** — add curl examples for:
- `GET /v1/groups?workspace=validator247`
- `PUT /v1/groups/v247_group_1` with workspace body
- `PUT /v1/accounts/3` with workspace body
- `POST /v1/accounts` with workspace body

**`docs/group-management.md`** — add "Workspace re-tagging" section explaining:
- Default `'DEFAULT'` semantics
- Operator workflow at go-live
- Note: re-tagging a LOCKED group is allowed and takes effect on next cycle
- Footgun: re-tag account without re-tagging matching groups → `group.none-available` → Telegram nag

## Success Criteria
- [ ] `npm test` passes including new `workspace-lock.int.test.js`
- [ ] No regression in existing tests (signature update only)
- [ ] README documents workspace concept + go-live workflow
- [ ] `docs/api-examples.md` covers all 4 new admin operations
- [ ] `docs/group-management.md` covers the re-tag override semantics + footgun

## Risk Assessment
- **Test DB pollution** — workspace integration test must clean its rows in `afterEach`/`afterAll` to avoid interfering with race test. Follow the pattern already in `groups-repo-race.int.test.js`.
- **Doc drift** — keep the workspace regex in exactly one place per layer (route file). Docs reference it textually, not by import. Acceptable trade-off; promote to shared constant if it bites.
- **Forgotten signature update** — risk that `lockNextAvailable` is called in a place not grepped during Phase 2. Mitigation: run `grep -rn lockNextAvailable` after Phase 2 and again at the start of Phase 4.
