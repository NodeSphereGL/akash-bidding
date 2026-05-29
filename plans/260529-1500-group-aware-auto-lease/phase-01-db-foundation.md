---
phase: 1
title: "DB Foundation"
status: implemented
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: DB Foundation

## Overview

Install MySQL client lib, create connection pool, ship `001_init.sql` schema,
add a `db-migrate` script, and build three repositories: `groups`,
`accounts`, `deployments`. No business logic yet — just storage primitives.

## Requirements

- Functional:
  - `mysql2` dep added; pool reads `MYSQL_*` from `.env`.
  - `npm run db:migrate` applies `src/db/migrations/001_init.sql` idempotently.
  - Three repo modules expose async functions returning plain JS objects.
  - `groupsRepo.lockNextAvailable(accountId, dseq, lockHours)` runs inside a
    transaction with `SELECT … FOR UPDATE` for race safety.
- Non-functional:
  - Pool size 5 (enough for N≤20 accounts + sweeper + API).
  - Connection errors throw `DbError` (new) with original cause attached.
  - All queries use parameterized placeholders — no string concat.

## Architecture

```
src/
  config.js                ← MODIFIED: + MYSQL_* + GROUP_LOCK_HOURS
  errors.js                ← MODIFIED: + DbError class
  db/
    pool.js                ← NEW: mysql2/promise createPool, exports query+tx helpers
    migrations/
      001_init.sql         ← NEW: 3 tables + indices
    repo/
      groups.js            ← NEW
      accounts.js          ← NEW
      deployments.js       ← NEW
scripts/
  db-migrate.js            ← NEW: applies all *.sql in migrations/ in order
```

### Pool helpers (pool.js)

```js
// pseudocode
export const pool = mysql.createPool({ ...MYSQL_*, connectionLimit: 5 });
export async function query(sql, params) { ... }
export async function withTx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) { await conn.rollback(); throw new DbError(e.message, e); }
  finally { conn.release(); }
}
```

### Repo API shapes

```js
// groups.js
listAll({ status?, limit? })
get(name)
insert({ name, branch, status?, notes? })
update(name, patch)        // status, branch, notes, locked_*
remove(name)
lockNextAvailable(accountId, dseq, lockHours)  // tx + FOR UPDATE
release(name)                                  // status=AVAILABLE, clear locked_*
expireDue(now)                                  // batch release expired
listPutFailedNagDue(intervalMs, now)            // for sweeper
markNagged(name, now)

// accounts.js
listEnabled()
get(id)
getByName(name)
insert({ name, apiKey, proxy?, enabled? })
update(id, patch)
remove(id)

// deployments.js
insert({ dseq, accountId, groupName?, provider?, uactPerBlock?, status, leasedAt?, expiresAt? })
updateStatus(dseq, status, patch?)             // patch can set last_error, put_attempts, group_name
get(dseq)
list({ accountId?, status?, limit? })
expireDue(now)                                  // bulk set EXPIRED
```

## Related Code Files

- Create:
  - `src/db/pool.js`
  - `src/db/migrations/001_init.sql`
  - `src/db/repo/groups.js`
  - `src/db/repo/accounts.js`
  - `src/db/repo/deployments.js`
  - `scripts/db-migrate.js`
- Modify:
  - `src/config.js` — add `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE`, `GROUP_LOCK_HOURS=24`
  - `src/errors.js` — add `class DbError extends Error { cause }`
  - `package.json` — add `mysql2`, add scripts `db:migrate`
- Delete: none

## Implementation Steps

1. `npm i mysql2@^3`
2. Add `MYSQL_*` validation in `config.js` — required keys: HOST, PORT, USER, DATABASE; PASSWORD optional. `GROUP_LOCK_HOURS` defaults 24.
3. Create `src/errors.js` `DbError`.
4. Write `src/db/migrations/001_init.sql` per schema in brainstorm summary §DB schema (groups, accounts, deployments + indices + FKs). Use `CREATE TABLE IF NOT EXISTS` for idempotency.
5. Write `src/db/pool.js` — exports `pool`, `query(sql, params)`, `withTx(fn)`. Wrap mysql errors in `DbError`.
6. Write `scripts/db-migrate.js` — reads all `migrations/*.sql` sorted ASC, splits on `;`, executes each statement. Logs each file applied.
7. Write `src/db/repo/groups.js` per repo API above. Implement `lockNextAvailable` with `withTx`:
   ```sql
   SELECT name FROM groups WHERE status='AVAILABLE' ORDER BY name ASC LIMIT 1 FOR UPDATE;
   UPDATE groups SET status='LOCKED', locked_by_account_id=?, locked_dseq=?,
     locked_at=NOW(), expires_at=DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE name=?;
   ```
   Return the locked row (re-SELECT after UPDATE).
8. Write `src/db/repo/accounts.js` and `src/db/repo/deployments.js`.
9. Add `package.json` scripts: `"db:migrate": "node scripts/db-migrate.js"`.

## Success Criteria

- [ ] `npm run db:migrate` runs against fresh MySQL DB, creates 3 tables.
- [ ] Re-running migrate is a no-op (IF NOT EXISTS).
- [ ] Unit test: `lockNextAvailable` called concurrently × 5 returns 5 distinct group names from a 5-row fixture, no duplicates, no errors. (Test added in Phase 7 — placeholder behavior must already be correct.)
- [ ] `accountsRepo.insert` rejects duplicate name with clear `DbError`.
- [ ] All repo methods return plain objects (snake_case from DB → JS keeps snake_case for simplicity, or converted — pick one and document).

## Risk Assessment

- **MySQL not running** → migrate fails fast with clear error. Doc the prereq.
- **Schema drift** → migrations are append-only (001, 002, …). Don't edit 001 after merge; add 002.
- **Race condition in lock** → mitigated by `FOR UPDATE` + serializable isolation default. Verified by concurrency test (Phase 7).
- **snake_case vs camelCase** — DB returns snake_case columns. Decision: keep snake_case in repo return values (less mapping); convert only at API boundary (Phase 6).

## Notes

- Convention: repos throw `DbError` on infra failures, return `null` on not-found, return `[]` on empty list.
- Don't add ORM (Sequelize/TypeORM). KISS — raw mysql2 with parameterized queries is enough.
