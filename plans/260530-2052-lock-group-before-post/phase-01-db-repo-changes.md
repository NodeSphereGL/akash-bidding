# Phase 1: DB repo — pending lock + bind-on-lease

## Context

Lock-before-POST needs a group locked WITHOUT a dseq (POST hasn't happened yet). On lease success, promote that lock to the full 24h with dseq bound. No schema changes — `groups.locked_dseq` is already `NULL`able (`src/db/migrations/001_init.sql:9`).

## Files

- Modify: `src/db/repo/groups.js`
- Modify: `tests/groups-repo-race.int.test.js` (add coverage for new methods)
- Add: nothing (no new files, no migration)

## New repo methods

### `lockNextAvailablePending(accountId, workspace, pendingMinutes, conn?)`

Picks lowest-ASC `AVAILABLE` group in workspace, flips to `LOCKED`, sets `locked_by_account_id`, leaves `locked_dseq = NULL`, sets `expires_at = NOW() + pendingMinutes`. Returns the locked row or `null` if none available.

Differs from existing `lockNextAvailable`:
- No `dseq` parameter (NULL during pending phase)
- `expires_at` uses minutes (short TTL), not hours
- Same atomic `SELECT … FOR UPDATE` semantics

### `bindLockToDseq(name, dseq, lockHours, conn?)`

Updates the already-LOCKED row: sets `locked_dseq = dseq`, extends `expires_at = NOW() + lockHours`. Returns the updated row.

Guard: throw `DbError` if the row's `status != 'LOCKED'` or `locked_dseq IS NOT NULL` (caller bug — promoting a non-pending lock).

## Behaviour

- Pending TTL default: 10 minutes (covers `BID_WAIT_MS=120000` + lease attempts + margin)
- Promotion extends to `GROUP_LOCK_HOURS` (existing config, default 24h)
- Existing `lockNextAvailable` left intact (used by no caller after phase 2, but kept for ops/tests until phase 3 deletes it)

## Tests

In `tests/groups-repo-race.int.test.js`:

1. `lockNextAvailablePending` returns a locked row, `locked_dseq IS NULL`, `expires_at` within pendingMinutes window
2. `lockNextAvailablePending` returns `null` when no AVAILABLE group exists
3. `lockNextAvailablePending` respects workspace scoping
4. Two concurrent `lockNextAvailablePending` calls return different rows (FOR UPDATE serializes)
5. `bindLockToDseq` extends expires_at and sets dseq
6. `bindLockToDseq` throws if row is not in pending state

Tests gated by `MYSQL_TEST_*` env (matches existing integration test pattern).

## Done when

- Both methods exported from `src/db/repo/groups.js`
- All 6 tests pass against local MySQL
- `npm test` green
- No changes to `lockNextAvailable` signature (back-compat for phase 2 work-in-progress and phase 3 deletion)

## Risk

- Low. Purely additive. No callers yet, no schema change.

## Next

Phase 2 wires these into `runAccountLoop`.
