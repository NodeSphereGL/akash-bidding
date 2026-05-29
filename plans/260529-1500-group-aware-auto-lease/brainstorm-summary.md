# Brainstorm — Group-Aware Auto-Lease + Local MySQL + Admin API

**Date:** 2026-05-29
**Project:** akash-bidding
**Status:** Approved design, ready for `/ck:plan`

## Problem

Today after Akash lease, manual workflow:
1. SSH into container
2. `git checkout release/group_XX`
3. Start tmux, run

Free trial limit: 1 instance / 24h per account. After 24h, new trial account
needed. Group assignment tracked manually in Google Sheet — error prone, 2
machines can land on same group.

Goal: zero-touch. Daemon auto-picks free group, auto-injects `GROUP_NAME` env
into the new `toanbk/rpow2:v1` image via SDL PUT, tracks state in MySQL, exposes
admin CRUD API.

## Decisions (all confirmed)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Flow ordering | PUT SDL AFTER lease (not pre-lease group pick) |
| 2 | Storage | Local MySQL |
| 3 | DB scope | Groups + Accounts + Deployments + (skip SSH info) |
| 4 | API surface | Full CRUD, node:http, 127.0.0.1, no auth |
| 5 | Expiry | Background sweeper releases group locks; no Akash close (auto-evicts) |
| 6 | Group pick order | Sequential by name ASC |
| 7 | PUT failure | Keep deployment + group locked, Telegram nag every 30 min |
| 8 | Re-lease policy | New group each lease cycle |
| 9 | Group source | Pre-seeded from `/MINING/rpow2/data/` folder list (all 26 entries) |
| 10 | SSH info storage | Skip — only dseq + provider address |

## Architecture

### Data flow

```
┌─ supervisor (existing)
│  └─ runAccountLoop × N (existing, modified)
│      1. createDeployment(SDL with placeholder)
│      2. pollAndLease
│      3. on lease success:
│         a. groupRepo.lockNextAvailable(account_id, dseq)
│         b. sdl.injectGroupName(template, group_name)
│         c. akash.updateDeployment(dseq, newSdl)
│         d. on PUT ok    → deploymentsRepo.insert(...status=PUT_OK), telegram
│            on PUT fail  → groups.status=PUT_FAILED, telegram, sweeper nags
│      4. sleep LEASE_HOLD_MS
│
├─ sweeper (new) — setInterval 5 min
│  └─ expire groups (expires_at < NOW) → status=AVAILABLE
│  └─ expire deployments
│  └─ nag telegram for PUT_FAILED groups every 30 min
│
└─ admin API (new) — node:http on 127.0.0.1:API_PORT
   └─ /v1/groups, /v1/accounts, /v1/deployments
```

### File layout (new + modified)

```
src/
  index.js                  ← MODIFIED: post-lease hook + DB writes
  akash.js                  ← MODIFIED: + updateDeployment(dseq, sdl)
  config.js                 ← MODIFIED: + MYSQL_*, API_PORT, PUT_NAG_MS
  accounts-loader.js        ← MODIFIED: load from DB
  sdl.js                    ← NEW: load akash-deploy.yaml, inject GROUP_NAME
  sweeper.js                ← NEW: expire + nag
  db/
    pool.js                 ← NEW: mysql2 pool
    migrations/001_init.sql ← NEW: schema
    repo/
      groups.js             ← NEW
      accounts.js           ← NEW
      deployments.js        ← NEW
  api/
    server.js               ← NEW: node:http listener
    routes/
      groups.js
      accounts.js
      deployments.js
scripts/
  db-migrate.js             ← NEW
  db-seed-groups.js         ← NEW: scan rpow2/data folder
  db-import-accounts.js     ← NEW: one-shot accounts.json → DB
akash-deploy.yaml           ← MODIFIED: image rpow2:v1, GROUP_NAME placeholder
package.json                ← +mysql2
```

### DB schema (MySQL)

```sql
CREATE TABLE groups (
  name VARCHAR(64) PRIMARY KEY,
  branch VARCHAR(128) NOT NULL,
  status ENUM('AVAILABLE','LOCKED','PUT_FAILED','DISABLED') NOT NULL DEFAULT 'AVAILABLE',
  locked_by_account_id INT NULL,
  locked_dseq VARCHAR(32) NULL,
  locked_at DATETIME NULL,
  expires_at DATETIME NULL,
  last_nag_at DATETIME NULL,
  notes TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_name (status, name)
);

CREATE TABLE accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) UNIQUE NOT NULL,
  api_key VARCHAR(255) NOT NULL,
  proxy VARCHAR(512) NULL,
  enabled BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE deployments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dseq VARCHAR(32) UNIQUE NOT NULL,
  account_id INT NOT NULL,
  group_name VARCHAR(64) NULL,
  provider VARCHAR(128) NULL,
  uact_per_block INT NULL,
  status ENUM('CREATED','LEASED','PUT_OK','PUT_FAILED','EXPIRED','CLOSED') NOT NULL,
  leased_at DATETIME NULL,
  expires_at DATETIME NULL,
  put_attempts INT DEFAULT 0,
  last_error TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_account_status (account_id, status),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (group_name) REFERENCES groups(name)
);
```

### Atomic group lock (race-safe)

```sql
START TRANSACTION;
SELECT name FROM groups
  WHERE status='AVAILABLE'
  ORDER BY name ASC
  LIMIT 1 FOR UPDATE;
UPDATE groups
  SET status='LOCKED', locked_by_account_id=?, locked_dseq=?,
      locked_at=NOW(), expires_at=DATE_ADD(NOW(), INTERVAL 24 HOUR)
  WHERE name=?;
COMMIT;
```

`FOR UPDATE` ensures concurrent loops don't double-pick.

### Akash PUT call

`akash.updateDeployment(ctx, dseq, sdl)` →

```
PUT /v1/deployments/{dseq}
Headers: x-api-key, Content-Type: application/json
Body: { "data": { "sdl": "<yaml string>" } }
```

Reuses existing `request()` transport (proxy + timeout + retry).

### SDL template (post-change)

```yaml
# akash-deploy.yaml
version: "2.0"
services:
  service-rpow:
    image: toanbk/rpow2:v1
    expose:
      - port: 80
        as: 80
        to: [{ global: true }]
    env:
      - GROUP_NAME=__PLACEHOLDER__   # daemon overwrites post-lease
profiles: ...
```

`src/sdl.js` parses YAML, replaces `env[0]` with `GROUP_NAME=<picked>`, returns
serialized string for PUT.

### Admin API endpoints (127.0.0.1)

```
GET    /v1/groups                  ?status=AVAILABLE|LOCKED|...
GET    /v1/groups/:name
POST   /v1/groups                  { name, branch, notes? }
PUT    /v1/groups/:name            { status?, branch?, notes? }
DELETE /v1/groups/:name
POST   /v1/groups/:name/release    force release lock

GET    /v1/accounts                ?enabled=true
GET    /v1/accounts/:id
POST   /v1/accounts                { name, api_key, proxy?, enabled? }
PUT    /v1/accounts/:id
DELETE /v1/accounts/:id

GET    /v1/deployments             ?account_id=&status=
GET    /v1/deployments/:dseq
```

JSON in / JSON out. Errors: `{ error: "msg", code: "..." }` with HTTP status.

### Sweeper

```
setInterval(SWEEP_INTERVAL_MS, async () => {
  // 1. release expired locks
  UPDATE groups SET status='AVAILABLE', locked_*=NULL, expires_at=NULL
    WHERE status='LOCKED' AND expires_at < NOW();
  // 2. expire deployments
  UPDATE deployments SET status='EXPIRED'
    WHERE status IN ('LEASED','PUT_OK') AND expires_at < NOW();
  // 3. nag PUT_FAILED every 30 min
  SELECT * FROM groups WHERE status='PUT_FAILED'
    AND (last_nag_at IS NULL OR last_nag_at < NOW() - INTERVAL 30 MINUTE);
  → telegram + UPDATE last_nag_at=NOW();
});
```

## Config (.env additions)

```
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=akashbid
MYSQL_PASSWORD=...
MYSQL_DATABASE=akash_bidding

API_PORT=8088
API_HOST=127.0.0.1

GROUP_LOCK_HOURS=24
SWEEP_INTERVAL_MS=300000
PUT_NAG_INTERVAL_MS=1800000
```

## Rollout / migration

1. User starts MySQL locally, creates DB+user.
2. `npm run db:migrate` — applies `001_init.sql`.
3. `npm run db:seed-groups` — scans `/Users/ductoanbk/Working/Project/BLOCKCHAIN/NODESPHERE/MINING/rpow2/data`, INSERTs 26 rows.
4. `npm run db:import-accounts` — reads existing `accounts.json`, INSERTs.
5. `accounts.json` kept as backup; daemon now reads from DB.
6. `npm start` boots: supervisor + API server + sweeper.

## Risks / open items

1. **Silent 24h burn on PUT failure** — mitigated by 30-min Telegram nag (per decision).
   You still must act manually. Consider adding `PUT_MAX_RETRIES=3` later if nags get noisy.
2. **MySQL infra requirement** — local mysqld must be running. Service won't start without it. (Trade-off you accepted vs. SQLite simplicity.)
3. **rpow2:v1 group_NAME validity** — seed dumps all 26 folder names. If any folder isn't a runnable group, daemon will lock it and the container will fail. Mitigation: manual `PUT /v1/groups/:name {status:DISABLED}` on bad ones.
4. **Bind 127.0.0.1 with no auth** — safe only on a non-shared host. SSH-tunnel from outside if remote admin needed.
5. **`accounts.json` becomes stale** — keep as backup but state of truth = DB. Document this.
6. **Existing `noMatchStreak` exhaustion** — still works; just irrelevant once trial credit gone.

## Success criteria

- After `npm start`, no manual SSH/git/tmux required to run a group.
- DB shows AVAILABLE → LOCKED → AVAILABLE transitions per group within ~24h.
- Concurrent N accounts never lock the same group (`FOR UPDATE` test).
- Admin API CRUD round-trips work for groups + accounts + deployments.
- Telegram fires on: lease success (with group name), PUT failure, 30-min PUT nag, sweeper releases.
- Sweeper releases locks within 5 min of expiry without Akash close call.

## Out of scope (this round)

- Closing deployments on Akash via API after expiry (auto-evicts).
- SSH info storage / parsing.
- UI dashboard (CLI + API only).
- Multi-host deployment of the daemon.
- Auth on admin API.
- Per-account group preference / pinning.

## Next step

`/ck:plan` (default mode) — moderate-scope new feature with multiple new
modules. TDD not strictly needed; existing tests cover orchestrator
invariants and bidder logic, no critical-behavior refactor.
