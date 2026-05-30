# akash-bidding

Long-running Node.js daemon that auto-creates Akash GPU deployments, polls bids, leases the first matching offer (uact/block ≤ `MAX_UACT_PER_BLOCK`, GPU model not in blacklist), and notifies Telegram on success and fatal events. Each account runs its own concurrent async loop with per-account HTTP proxy. Continues running through exhaustion via supervisor respawn.

## What it does (per account, concurrently)

Each `{apiKey, proxy}` account runs an independent async loop inside the same Node process. Loops do not block each other — account A's 1h lease hold does not delay account B's bidding.

Per cycle, per account:

1. Check balance — log `auth.fail` and exit the loop if 401; treat insufficient credit as exhausted.
2. `POST /v1/deployments` (console-api) with raw `akash-deploy.yaml` and `deposit=$5`.
3. Poll chain REST `GET /rest/akash/market/v1beta5/bids/list?filters.owner=...&filters.dseq=...` every 10s for up to 120s — same endpoint the Console UI uses. (Console-api's `/v1/bids` returns `[]` in practice.) The first time at least one bid passes the filter, that bid (and all worse-priced fallbacks) is selected immediately.
4. Filter: drop bids whose GPU model contains any `GPU_BLACKLIST` entry (substring, case-insensitive) or whose `price.amount > MAX_UACT_PER_BLOCK`; sort DESC.
5. Lease the top candidate; on failure walk the fallback list top-down.
6. On lease success → Telegram, this account sleeps 1h (other accounts continue bidding). Lease keeps running on Akash; auto-evicts when deposit drains.
7. On no-match or all-leases-failed → close deployment, sleep `rand(60..180)s`, next cycle.

## Concurrency

- N accounts → N async loops in the same process via `Promise.allSettled`.
- Each loop owns its own `noMatchStreak` and exhaustion state — no shared rotator.
- Startup jitter (random 0–30s) staggers the initial bid burst.
- When every loop has returned EXHAUSTED, the supervisor notifies Telegram, sleeps `RETRY_MAX_MS`, and respawns all loops.
- SIGINT/SIGTERM aborts every loop cleanly via a shared `AbortController`; process exits 0.

## Requirements

- Node.js 20 or later
- A local MySQL (or compatible) running on `MYSQL_HOST:MYSQL_PORT` — state lives in `groups` / `accounts` / `deployments` tables
- An Akash Console managed-wallet account (API key)
- Optional HTTP proxy URL per account
- Optional Telegram bot + chat ID for notifications

## Setup

```bash
git clone <this repo>
cd akash-bidding
npm install

cp .env.example .env             # fill in MAX_UACT_PER_BLOCK, MYSQL_*, telegram, etc.
cp accounts.example.json accounts.json   # populate name + apiKey + proxy per account

# create DB once, then:
npm run db:migrate                                  # applies src/db/migrations/001_init.sql
npm run db:seed-groups -- --dir=/path/to/rpow2/data # scans dir → groups table (also accepts RPOW2_DATA_DIR env)
npm run db:import-accounts                          # accounts.json → accounts table (one-shot, idempotent)
```

Place your SDL at `./akash-deploy.yaml` (a working example with `GROUP_NAME=__PLACEHOLDER__` is included; the daemon overwrites the placeholder at POST time per-cycle — no post-lease PUT, single ReplicaSet on the provider).

## Per-cycle automation

Each cycle, per account:

1. **Pre-flight gate** — atomically lock the next AVAILABLE group in this
   account's workspace via `SELECT ... FOR UPDATE`. The lock starts with
   `locked_dseq=NULL` and a short TTL (`GROUP_LOCK_PENDING_MINUTES`, default
   10). If no group is AVAILABLE, the cycle is skipped — no POST, no escrow
   risk. Add capacity via `npm run db:seed-groups` or the admin API.
2. `POST /v1/deployments` with the SDL template + the locked group's name
   injected into `GROUP_NAME=` BEFORE POST. The provider sees a single
   `spec.template`; one ReplicaSet, one rollout.
3. Promote the pending lock to full state: bind the returned `dseq` and
   extend `expires_at` to `GROUP_LOCK_HOURS` (default 24h).
4. Poll bids, filter, lease the top candidate.
5. On lease success: insert audit row in `deployments` with
   `status=PUT_OK, group_name, leased_at, expires_at`. Then
   `PATCH /v2/deployment-settings/{dseq}` with `data.autoTopUpEnabled=false`
   so console managed-wallet doesn't auto-refill escrow → deployment cleanly
   evicts when deposit drains.
6. On no-bid / all-leases-failed: close the deployment (refunds escrow) and
   release the group lock so another account can take it.
7. Background sweeper (every `SWEEP_INTERVAL_MS`, default 5 min):
   - releases locks whose `expires_at < NOW()` — picks up pending-lock
     orphans within `GROUP_LOCK_PENDING_MINUTES` if the daemon crashes
     between lock and lease
   - retries any PATCH that failed mid-cycle (escrow refill guard)
   - fires `lease.orphan` Telegram alert if any active row stays
     `auto_topup_disabled=false` for more than 1h
   - nags historical `PUT_FAILED` group rows (legacy state — no new ones
     are produced under the lock-before-POST flow)

If the on-chain lease succeeds but the DB insert fails (DB outage etc.),
a `lease.orphan` Telegram alert fires with `account + dseq + error`. The
daemon does **not** auto-close — operator triages via
`scripts/ops/close-test-leases.js` and the console UI.

Zero SSH, zero `git checkout`, zero tmux required post-lease.

### Group supply sizing

The pre-flight gate locks one group per concurrent in-flight cycle. As a
rule of thumb, keep `N_groups ≥ N_accounts × 2` so accounts don't briefly
contend during the bid-wait window (`BID_WAIT_MS`, default 120s) or while
holding a successful lease (`LEASE_HOLD_MS`, default 1h). If `no_group.skip_cycle`
appears regularly in the logs, add more rows to the `groups` table.

### Note on dseq uniqueness

Akash dseqs are unique per owner, not globally. Two managed-wallet accounts
can receive the same numeric dseq from console-api. Local schema reflects
this via `UNIQUE (account_id, dseq)` (migration 003). Admin API
`GET /v1/deployments/:dseq` returns the most recent matching row by default;
add `?account_id=<id>` to disambiguate.

## Workspace scoping

Each account and each group carry a `workspace` column (`VARCHAR(64)`, default
`'DEFAULT'`). At lock-time the daemon picks only groups whose `workspace`
equals the account's `workspace` (strict equality). Fresh installs land on
`'DEFAULT'` everywhere → single-pool behaviour, no change vs. legacy.

To partition (e.g. dedicate `v247_*` groups to one account):

```bash
curl -s -X PUT http://127.0.0.1:8088/v1/accounts/<id> \
  -H 'Content-Type: application/json' -d '{"workspace":"validator247"}'
curl -s -X PUT http://127.0.0.1:8088/v1/groups/v247_group_01 \
  -H 'Content-Type: application/json' -d '{"workspace":"validator247"}'
```

Workspace values: 1-64 chars, regex `/^[a-z0-9_-]+$/i`. See
`docs/group-management.md` for the re-tag workflow and footguns.

## Admin API (loopback only)

```
GET    /health
GET    /v1/groups[?status=AVAILABLE|LOCKED|PUT_FAILED|DISABLED][&workspace=NAME]
GET    /v1/groups/:name
POST   /v1/groups              { name, branch, notes?, workspace? }
PUT    /v1/groups/:name        { status?, branch?, notes?, workspace? }
DELETE /v1/groups/:name
POST   /v1/groups/:name/release    force-release lock
GET    /v1/accounts[?enabled=true]
GET    /v1/accounts/:id
POST   /v1/accounts            { name, apiKey, proxy?, enabled?, workspace? }
PUT    /v1/accounts/:id         { name?, apiKey?, proxy?, enabled?, workspace? }
DELETE /v1/accounts/:id
GET    /v1/deployments[?account_id=&status=&limit=]
GET    /v1/deployments/:dseq
```

Hard-bound to `127.0.0.1` (not configurable). No auth — SSH-tunnel from outside if remote admin is required. See `docs/api-examples.md` for curl examples and `docs/group-management.md` for the PUT_FAILED runbook.

## Calibrate the price cap

Set `MAX_USD_PER_HOUR` in `.env` — that's the unit the Akash Console UI shows. The daemon converts to the uact/block cap internally using:

- `1 uact = $0.000001` (anchored to `deposit:5` USD → 5,000,000 uact in escrow)
- `averageBlockTime = 6.098s` (from Akash Console source)
- `USD/hour = price.amount × 3600 / 6.098 / 1,000,000`
- `uact/block = USD/hour × 1693.74`

Examples (real bids observed on Console):

| GPU | UI price | uact/block |
| --- | --- | --- |
| nvidia-a100 | $1.23/hr | ~2,083 |
| nvidia-pro6000se | $1.86/hr | ~3,150 |
| nvidia-h100 | $2.52/hr | ~4,268 |

For raw chain-unit control, set `MAX_UACT_PER_BLOCK` directly (overrides `MAX_USD_PER_HOUR` when both are set; leave one blank).

Run `npm run probe` to confirm reachability + see a fresh bid screen before launching the daemon.

## Run

```bash
# pre-flight: confirm proxy isolation
npm run check-proxy

# foreground
npm start

# tests
npm test
```

See `docs/run-and-ops.md` for PM2, systemd, and logrotate templates.

## Telegram

Notifications fire on:

| Event | Why |
| --- | --- |
| Lease acquired | Account landed a lease — that loop now sleeps 1h |
| PUT failed | SDL update after lease failed; group is `PUT_FAILED`, nagged every 30 min until released |
| Lease orphan | On-chain lease succeeded but post-lease tx failed — on-chain cost with no local row. Operator must close manually. Also fires if `auto_topup_disabled` stays false > 1h. |
| All accounts depleted | Every per-account loop returned exhausted; supervisor cools off then respawns |
| Account 401 | API key invalid for that account; that account's loop exits |
| SDL load failed | Daemon exits before the loop |
| Uncaught crash | Daemon exits 1 — supervisor should restart |

Leave `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` blank in `.env` to disable Telegram silently.

## Logs

JSONL, appended to `./logs/akash-bidding.log` and printed to stdout. Every cycle-scoped line includes the `account` name.

```bash
tail -f logs/akash-bidding.log | jq 'select(.event=="lease.success")'
```

## Known limitations

- Does not close leases via Akash API on expiry (deposit drains → auto-eviction).
- Admin API is loopback + no auth — SSH-tunnel for remote admin.
- Substring blacklist can over-match (e.g. `a10` matches `a100`); pick blacklist entries carefully.
- No Telegram rate-limit throttling; acceptable at current N but revisit if N > 20 accounts.
- Bad-provider scheduling failures (provider's K8s cluster maxed on pods) burn the 24h lease hold silently — daemon does not health-probe the workload. Operator detects via absent activity and closes manually.
- Pre-flight gate skips the cycle when no group is AVAILABLE — daemon idles cheaply until a group expires or an operator seeds more.

## Layout

```
src/
  config.js              env loader, validates required keys
  akash.js               REST client + createDeployment / updateDeployment / disableAutoTopUp
  bidder.js              pure filter + DESC-rank by uact/block
  accounts-loader.js     JSON validator + loadAccountsFromDb()
  notify.js              Telegram bot client + typed notifiers (incl. notifyLeaseOrphan)
  logger.js              JSONL file + stdout
  index.js               runAccountLoop + supervisor (Promise.allSettled)
  sdl.js                 SDL template loader + GROUP_NAME injector (per-POST)
  sweeper.js             background expiry + PUT_FAILED nag + auto-topup retry
  errors.js              AkashApiError, DbError
  db/
    pool.js              mysql2 pool + query + withTx helpers
    migrations/{001..004}_*.sql
    repo/{groups,accounts,deployments}.js
  api/
    server.js            node:http on 127.0.0.1
    router.js            method+regex matcher
    json-body.js         parser + 100KB limit
    routes/{groups,accounts,deployments,health}.js
scripts/
  probe.js               one-shot live API probe
  check-proxy-ip.js      outbound IP per account
  db-migrate.js          applies migrations/*.sql
  db-seed-groups.js      rpow2/data → groups
  db-import-accounts.js  accounts.json → accounts
  ops/
    close-test-leases.js manually close (account, dseq) pairs + release group locks
    test-auto-topup.js   smoke-test PATCH /v2/deployment-settings/{dseq}
tests/
  bidder.test.js
  logger.test.js
  orchestrator-invariants.test.js
  orchestrator-concurrency.test.js
  sdl.test.js
  sweeper.test.js
  sweeper-auto-topup-retry.test.js
  notify-put-failed.test.js
  api-validation.test.js
  akash-disable-autotopup.test.js
  groups-repo-race.int.test.js   (gated by MYSQL_TEST_*)
  fixtures/bids-sample.json
docs/
  run-and-ops.md
  api-examples.md
  group-management.md
plans/                   design + phase docs
```
