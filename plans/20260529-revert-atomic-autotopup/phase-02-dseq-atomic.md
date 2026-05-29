# Phase 2 — Fix B1 (dseq UNIQUE scope) + B2 (atomic post-lease)

Priority: P0  •  Risk: medium (schema + tx refactor)  •  Reversible: reverse ALTER

## Context

Live QA exposed two production-blocking bugs in `src/index.js:229-305`:
- **B1** `deployments.dseq UNIQUE` is global; Akash dseqs are unique per owner only. Two accounts received the same dseq `27041241` → second insert errored.
- **B2** When insert fails, daemon still proceeds to `lockNextAvailable` + `updateDeployment` → orphan locked group with no audit row. Sweeper does not auto-release because it joins on `deployments.status`.

## Files

### New
- `src/db/migrations/003_dseq_per_account.sql`
- `tests/orchestrator-postlease-atomic.test.js`

### Modified
- `src/db/repo/deployments.js` — insert/update accept optional `conn`
- `src/db/repo/groups.js` — `lockNextAvailable` accept optional `conn`
- `src/db/pool.js` — verify `withTx` exposes the connection to inner callback
- `src/index.js` — extract `postLeaseAtomic()` helper; wrap insert + lock in `withTx`
- `src/errors.js` — add `NoGroupAvailableError`
- `src/notify.js` — add `notifyLeaseOrphan({ account, dseq, error })`

## Migration

```sql
-- 003_dseq_per_account.sql
-- B1 fix: Akash dseqs are unique per owner, not globally. Allow same dseq
-- across different accounts.
SET @has_uniq := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'deployments'
    AND index_name = 'dseq' AND non_unique = 0
);
SET @sql := IF(@has_uniq > 0, 'ALTER TABLE deployments DROP INDEX dseq', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_new := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'deployments'
    AND index_name = 'uniq_account_dseq'
);
SET @sql := IF(@has_new = 0,
  'ALTER TABLE deployments ADD UNIQUE KEY uniq_account_dseq (account_id, dseq)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
```

## Code changes

### `src/index.js` — replace lines 229-305 (~75 lines) with:

```js
let group = null, putStatus = null;
try {
  const result = await postLeaseAtomic({
    db: { deploymentsRepo: deploymentsRepoDep, groupsRepo: groupsRepoDep },
    dseq, account, leaseResult, hours: config.GROUP_LOCK_HOURS, now, expiresAt,
  });
  group = result.group;
  putStatus = "LOCKED";
} catch (err) {
  if (err instanceof NoGroupAvailableError) {
    cycleLog.warn("group.none-available", { dseq, workspace: account.workspace });
    putStatus = "NO_GROUP";
  } else {
    // Lease succeeded on-chain but DB tx failed → orphan on-chain deployment.
    cycleLog.error("lease.orphan", { dseq, account: account.name, error: err.message });
    await notify.notifyLeaseOrphan({ account, dseq, error: err.message }, tg);
    putStatus = "ORPHAN";
  }
}

if (group && sdlTemplate && sdlInjector) {
  try {
    const newSdl = sdlInjector.injectGroupName(sdlTemplate, group.name);
    await akash.updateDeployment(ctx, dseq, newSdl);
    // Phase 3 hook: disableAutoTopUp goes here.
    await deploymentsRepoDep.updateStatus(dseq, account.id, "PUT_OK", { group_name: group.name, put_attempts: 1 });
    putStatus = "PUT_OK";
    cycleLog.info("deployment.put.ok", { dseq, group: group.name });
  } catch (err) {
    // existing PUT_FAILED handling, unchanged
  }
}
```

### `postLeaseAtomic()` (new private helper in index.js or new file `src/post-lease.js`):

```js
export async function postLeaseAtomic({ db, dseq, account, leaseResult, hours, now, expiresAt }) {
  if (!db.deploymentsRepo || !db.groupsRepo) {
    return { group: null }; // DB-disabled mode, mirror current behavior
  }
  return await withTx(async (conn) => {
    await db.deploymentsRepo.insert(conn, {
      dseq, accountId: account.id,
      provider: leaseResult.bid?.provider ?? null,
      uactPerBlock: leaseResult.bid?.uactPerBlock ?? null,
      status: "LEASED", leasedAt: now, expiresAt,
    });
    const group = await db.groupsRepo.lockNextAvailable(conn, account.id, dseq, hours, account.workspace);
    if (!group) throw new NoGroupAvailableError(`no available group in workspace ${account.workspace}`);
    return { group };
  });
}
```

### Repo signatures

```js
// src/db/repo/deployments.js
export async function insert(conn, fields) { return (conn ?? getPool()).query(...); }
// All callers must now pass conn first; non-tx callers pass null.
```

### `src/notify.js`
```js
export async function notifyLeaseOrphan({ account, dseq, error }, tg) {
  if (!tg) return false;
  return await send(tg, [
    `🛑 LEASE ORPHAN — chain lease succeeded but DB tx failed`,
    `Account: ${account.name}`,
    `dseq: ${dseq}`,
    `Error: ${error}`,
    `Action: manually close via console UI or scripts/ops/close-test-leases.js`,
  ].join("\n"));
}
```

## Tests

- `tests/orchestrator-postlease-atomic.test.js`:
  - insert throws → `lockNextAvailable` NOT called, function rejects.
  - lock returns null → `NoGroupAvailableError` thrown, no PUT.
  - happy path → both called once in order; tx commits.
- Update `tests/groups-repo-race.int.test.js` to pass connection arg.
- Re-run all: `MYSQL_TEST_HOST=… MYSQL_TEST_DATABASE=… npm test`.

## Success criteria

- Two accounts can lease same dseq value (different account_id) without DB error.
- If `deployments.insert` fails → no group is locked; `lease.orphan` event + Telegram fires.
- If `lockNextAvailable` returns null → `deployments` row is rolled back (no LEASED row left behind).
- All existing unit + int tests pass.

## Rollback

```sql
ALTER TABLE deployments DROP INDEX uniq_account_dseq;
ALTER TABLE deployments ADD UNIQUE KEY dseq (dseq);
```
Restore old `src/index.js` post-lease block from git history.

## Risks

- `withTx` already in `pool.js` — verify it passes the connection to the callback; if not, small extension needed.
- Existing `updateStatus(dseq, ...)` calls assume globally-unique dseq. After B1, must pass `(dseq, account_id)`. Audit all call sites.
- `deployments_repo.updateStatus` is used by sweeper too; signature change ripples.

## Decisions locked

- `lease.orphan` is alert-only — NO auto-close. Operator must see the alert,
  diagnose the cause (DB outage? schema drift? race?), then close manually via
  console UI or `scripts/ops/close-test-leases.js`. Reason: an on-chain lease
  is real cost; auto-closing masks the bug that produced the orphan in the
  first place. Confirmed 2026-05-29.
