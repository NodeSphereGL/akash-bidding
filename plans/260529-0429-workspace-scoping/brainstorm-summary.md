---
title: Workspace scoping for groups & accounts
date: 2026-05-29
status: approved-pending-plan
---

# Workspace Scoping — Brainstorm Summary

## Problem
1 workspace : N accounts (1 account → 1 workspace).
1 workspace : N groups (1 group → 1 workspace).
Lock-time selection must enforce `account.workspace = group.workspace`, preventing e.g. a `DEFAULT` account from grabbing `v247_*` groups intended for `validator247`.

## Final Decisions
| # | Decision |
|---|---|
| Storage shape | Denormalized `workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT'` on both `groups` and `accounts`. No registry table. |
| Matching rule | **Strict equality** — workspace value must match exactly. No wildcards. |
| Backfill | None — all existing rows land on `'DEFAULT'`. Operator re-tags via admin API when ready to go live. |
| Default value | `'DEFAULT'` for now. User will rename to real workspace names at go-live; design is not affected. |
| Account workspace source | Optional `workspace` field in `accounts.json` + `POST/PUT /v1/accounts` body. Defaults to `'DEFAULT'`. |
| Admin API | Optional `?workspace=X` filter on `GET /v1/groups`. Field exposed in JSON. Settable on POST/PUT for both groups & accounts. |

## Schema Change (Migration 002)
```sql
ALTER TABLE `groups`
  ADD COLUMN workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT' AFTER branch,
  DROP INDEX idx_status_name,
  ADD INDEX idx_workspace_status_name (workspace, status, name);

ALTER TABLE accounts
  ADD COLUMN workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT' AFTER proxy;
```

## Code Touch-Points
| File | Change |
|---|---|
| `src/db/migrations/002_workspace.sql` | NEW — schema migration above |
| `src/db/repo/groups.js` | `lockNextAvailable(accountId, dseq, lockHours, workspace)` — add `AND workspace = ?`. `listAll({status, workspace})` — optional filter. `COLS`, `insert`, `update` include `workspace`. |
| `src/db/repo/accounts.js` | `COLS`, `toCamel`, `insert`, `update` include `workspace`. |
| `src/accounts-loader.js` | Carry `workspace` through to the account object consumed by the loop. |
| `src/index.js` (`runAccountLoop`) | Pass `account.workspace` into `lockNextAvailable`. |
| `src/api/routes/groups.js` | `toJson` exposes `workspace`. `list` reads `?workspace=`. `create/update` accept `workspace` (regex `/^[a-z0-9_-]+$/i`, max 64). |
| `src/api/routes/accounts.js` | Same workspace handling on POST/PUT body + GET response. |
| `scripts/db-import-accounts.js` | Read optional `workspace` field from accounts.json rows; default `'DEFAULT'`. |
| `scripts/db-seed-groups.js` | Keep `v247_*` warning; do NOT auto-tag (operator's choice). |
| `accounts.example.json` | Document optional `workspace` field. |
| `.env.example`, `README.md`, `docs/api-examples.md`, `docs/group-management.md` | Doc updates explaining workspace semantics + admin workflow. |
| Tests | `tests/groups-repo-race.int.test.js`, `tests/api-validation.test.js` — extend. NEW test: `lockNextAvailable` skips foreign-workspace groups. |

## Strict-Matching Behaviour
- After migration: every account + group on `'DEFAULT'`. System behaves identically to today (single pool).
- Operator workflow to scope `validator247`:
  1. `PUT /v1/groups/v247_group_1 {"workspace": "validator247"}` … each v247 group.
  2. `PUT /v1/accounts/<id> {"workspace": "validator247"}` for the dedicated account.
- `DEFAULT` account never sees v247 groups; `validator247` account only sees v247 groups.

## Risks / Trade-offs
1. **Operator footgun** — re-tag account but forget groups (or vice-versa) → `group.none-available` → Telegram nag. Acceptable: visible failure mode.
2. **Index migration cost** — drop/recreate `idx_status_name` on `groups`. Fast at current scale.
3. **No workspace registry** — typos silently create new workspaces. Trade KISS for typing discipline. Promote to FK table later if it bites.
4. **`LOCKED` group re-tagging** — `PUT /v1/groups/:name {workspace}` allowed even when LOCKED; takes effect next cycle. Operator-override semantics.

## Success Criteria
- Migration applies cleanly on fresh DB and existing prod (idempotent).
- All existing tests pass unchanged when every row stays `'DEFAULT'` (proves backward compatibility).
- New test: account in workspace A never locks a group in workspace B even when only B-groups are AVAILABLE.
- `GET /v1/groups?workspace=validator247` returns only v247-tagged rows; response JSON exposes `workspace`.
- Race-safety unchanged: `SELECT ... FOR UPDATE` still atomic; workspace narrows candidate set inside the transaction.

## Out of Scope
- `workspaces` registry table (defer until typos become a problem).
- Auto-inference of workspace from group-name pattern.
- Workspace column on `deployments` (inherits via FK to accounts).
- Per-workspace concurrency limits / quotas.

## Open Questions
None.
