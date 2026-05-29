---
phase: 2
title: Repo + loop wiring
status: completed
priority: P1
effort: 2h
dependencies:
  - 1
---

# Phase 2: Repo + loop wiring

## Overview
Carry `workspace` through the repo layer, accounts loader, and the per-account loop so `lockNextAvailable` filters by `account.workspace`. This is the core behavioural change.

## Requirements
- Functional: `lockNextAvailable(accountId, dseq, lockHours, workspace)` must select only AVAILABLE groups where `workspace = ?`. Account object loaded from DB must expose `workspace` to the loop.
- Non-functional: race-safety preserved (`SELECT ... FOR UPDATE` still atomic, workspace just narrows the candidate set inside the same transaction). Backward-compatible for callers passing no workspace? **No** — workspace becomes a required arg. Loop is the only caller in src/.

## Architecture
Strict equality match enforced in SQL. Workspace flows: DB row → `accountsRepo.toCamel` → `accounts-loader` → `runAccountLoop` deps → `lockNextAvailable` call.

## Related Code Files
- Modify: `src/db/repo/groups.js`
- Modify: `src/db/repo/accounts.js`
- Modify: `src/accounts-loader.js`
- Modify: `src/index.js` (call site of `lockNextAvailable`)

## Implementation Steps

### 1. `src/db/repo/groups.js`
- Add `workspace` to `COLS`.
- `listAll({ status, workspace, limit })` — add optional `workspace` filter when supplied.
- `insert({ name, branch, status, notes, workspace })` — INSERT includes workspace; default `'DEFAULT'` if undefined (relies on column default anyway, but pass through for clarity).
- `update(name, patch)` — add `workspace` to `allowed` keys.
- `lockNextAvailable(accountId, dseq, lockHours, workspace)` — change SELECT to:
  ```sql
  SELECT name FROM `groups`
   WHERE status = 'AVAILABLE' AND workspace = ?
   ORDER BY name ASC LIMIT 1 FOR UPDATE
  ```

### 2. `src/db/repo/accounts.js`
- Add `workspace` to `COLS`.
- `toCamel`: include `workspace: row.workspace`.
- `insert({ name, apiKey, proxy, enabled, workspace })` — INSERT includes workspace.
- `update(id, patch)` — add `workspace` to the `map`.

### 3. `src/accounts-loader.js`
- Pass `workspace` through whatever shape it returns (likely already a spread of the camelCase row — verify nothing strips it).

### 4. `src/index.js`
At the existing call site (`runAccountLoop`, around the LEASE-SUCCESS branch):
```js
group = await groupsRepoDep.lockNextAvailable(
  account.id,
  dseq,
  config.GROUP_LOCK_HOURS,
  account.workspace,
);
```
Add `workspace: account.workspace` to relevant log lines (`account.loop.start`, `group.none-available`) for observability.

## Success Criteria
- [ ] `lockNextAvailable` rejects groups in foreign workspaces (verified via integration test in Phase 4)
- [ ] `account.workspace` is `'DEFAULT'` for all existing accounts after migration with no code change
- [ ] No regression: all current tests pass when both rows stay `'DEFAULT'`
- [ ] `runAccountLoop` logs `workspace` for trace observability

## Risk Assessment
- **Signature change on `lockNextAvailable`** — only one production caller (`src/index.js`) and the existing integration test. Both updated in this phase + Phase 4. Mitigation: grep the repo before edit to confirm no third caller (`grep -rn lockNextAvailable src tests scripts`).
- **`accounts-loader` silently drops field** — if loader manually picks fields rather than spreading, `workspace` would be lost. Verification: read the loader before edit; add explicit `workspace` if it whitelists fields.
- **Race-safety regression** — none expected; workspace clause is inside the same transaction as `FOR UPDATE`. Phase 4 integration test confirms concurrent lock attempts within the same workspace still serialise.
