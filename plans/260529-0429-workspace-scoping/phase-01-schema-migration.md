---
phase: 1
title: Schema migration
status: completed
priority: P2
effort: 1h
dependencies: []
---

# Phase 1: Schema migration

## Overview
Add `workspace` column to `groups` and `accounts` via a new idempotent migration. Replace the `idx_status_name` index on `groups` with a composite index that fronts the new lock-time filter.

## Requirements
- Functional: every row gets `workspace='DEFAULT'` by default; column is `NOT NULL VARCHAR(64)`.
- Non-functional: migration is idempotent (uses `IF NOT EXISTS` / guards) so it re-runs cleanly. No data loss. Composite index supports `WHERE workspace = ? AND status = 'AVAILABLE' ORDER BY name`.

## Architecture
Denormalized column on both tables. No `workspaces` registry table. Index choice optimised for the dominant query — `lockNextAvailable` — which filters by workspace + status and sorts by name.

## Related Code Files
- Create: `src/db/migrations/002_workspace.sql`
- Modify: `scripts/db-migrate.js` (only if it doesn't already auto-discover `00X_*.sql` files; verify first)

## Implementation Steps
1. Read `scripts/db-migrate.js` to confirm it auto-runs every `NNN_*.sql` in `src/db/migrations/` in lexical order. If it does, no script change needed.
2. Create `src/db/migrations/002_workspace.sql` with the SQL below.
3. Run `npm run db:migrate` against a dev DB. Confirm both columns exist with default `'DEFAULT'` and the new index is present.
4. Re-run the migration — verify it is a no-op (idempotent).

### SQL
```sql
-- 002_workspace.sql — workspace scoping. Idempotent.

-- groups: add workspace + composite index
ALTER TABLE `groups`
  ADD COLUMN IF NOT EXISTS workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT' AFTER branch;

-- Drop the legacy single-column index if present, then add composite.
-- MySQL 8 supports `DROP INDEX IF EXISTS`; if the target is MariaDB / MySQL 5.7,
-- the migration runner must tolerate "index not found" — wrap in IF EXISTS check
-- via INFORMATION_SCHEMA on first run if needed.
ALTER TABLE `groups` DROP INDEX idx_status_name;
ALTER TABLE `groups` ADD INDEX idx_workspace_status_name (workspace, status, name);

-- accounts: add workspace
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT' AFTER proxy;
```

> If the runner already in use does not support `IF NOT EXISTS` on `ADD COLUMN` (older MySQL), use an `INFORMATION_SCHEMA.COLUMNS` guarded `IF` block instead. Verify by inspecting `scripts/db-migrate.js`.

## Success Criteria
- [ ] `DESCRIBE groups;` shows `workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT'`
- [ ] `DESCRIBE accounts;` shows `workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT'`
- [ ] `SHOW INDEX FROM groups;` shows `idx_workspace_status_name` and no longer shows `idx_status_name`
- [ ] All existing rows have `workspace = 'DEFAULT'`
- [ ] Re-running migration produces no errors and no changes

## Risk Assessment
- **Index swap on non-empty `groups`** — fast at current scale; document in commit message. Mitigation: composite index covers the legacy single-column lookup pattern too (leftmost prefix on `workspace` matches DEFAULT for all current rows).
- **Older MySQL `IF NOT EXISTS` on ADD COLUMN** — verify runner compatibility before writing the migration. Fallback: guard via `INFORMATION_SCHEMA` lookup.
