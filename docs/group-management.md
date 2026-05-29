# Group management — operator guide

State machine for a group row:

```
AVAILABLE ──lockNextAvailable──► LOCKED ──sweeper(expires_at<NOW)──► AVAILABLE
                                   │
                                   └──PUT failure──► PUT_FAILED ──manual release──► AVAILABLE

PUT_FAILED: locked metadata preserved (locked_dseq, locked_at, expires_at),
            last_nag_at advances every 30 min (Telegram).
DISABLED:   manual — sweeper and lockNextAvailable both skip these.
```

## Daily ops

```bash
# what's in flight
curl -s 'http://127.0.0.1:8088/v1/groups?status=LOCKED' | jq '.[] | {name, locked_dseq:.lockedDseq, expiresAt}'

# anything broken
curl -s 'http://127.0.0.1:8088/v1/groups?status=PUT_FAILED' | jq

# audit trail
curl -s 'http://127.0.0.1:8088/v1/deployments?status=PUT_FAILED' | jq
```

## PUT_FAILED runbook

Telegram message format (every 30 min until status changes):

```
⚠️ PUT FAILED — manual action required
Group: <name>
dseq: <locked_dseq>
Account ID: <id>
Locked at: <ts>
Expires at: <ts>
Last error: <msg>
Resolve via: POST /v1/groups/<name>/release  OR  PUT /v1/groups/<name> {status:"AVAILABLE"}
```

Triage steps:

1. **Read `last_error`** — common causes:
   - Akash 4xx (e.g. dseq closed already): release the group, the deployment is dead anyway.
   - Network/transport: retry by manually PUTting again via Akash CLI, then release.
   - Bad SDL: fix `akash-deploy.yaml` then release.
2. **Inspect Akash console** for the dseq:
   - Is the deployment still active? If `closed`, just release.
   - Is the container running? If yes but stuck on placeholder, you can retry the PUT manually.
3. **Decide:**
   - Container failed → release the group, accept the burned 24h trial credit.
   - Container can be salvaged → fix and PUT manually, then release.
4. **Release:**
   ```bash
   curl -s -X POST http://127.0.0.1:8088/v1/groups/<name>/release
   # → status=AVAILABLE, locked_* cleared
   ```

## Disabling a non-runnable group

If a `v247_group_*` folder isn't runnable on `toanbk/rpow2:v1`:

```bash
curl -s -X PUT http://127.0.0.1:8088/v1/groups/v247_group_05 \
  -H 'Content-Type: application/json' \
  -d '{"status":"DISABLED","notes":"folder lacks XYZ"}'
```

Sweeper + `lockNextAvailable` skip DISABLED rows; safe to leave indefinitely.

## Adding a new group

After dropping a new folder into your groups source dir, you can either:

```bash
# rescan all entries (idempotent — existing rows skipped)
npm run db:seed-groups -- --dir=/path/to/rpow2/data
# or: RPOW2_DATA_DIR=/path npm run db:seed-groups

# or add one explicitly
curl -s -X POST http://127.0.0.1:8088/v1/groups \
  -H 'Content-Type: application/json' \
  -d '{"name":"group_27_new","branch":"release/group_27_new"}'
```

## Sweeper behaviour

- Runs every `SWEEP_INTERVAL_MS` (default 300_000 = 5 min).
- Releases LOCKED rows whose `expires_at < NOW()`.
- Marks deployments LEASED/PUT_OK → EXPIRED when their `expires_at < NOW()`.
- Telegram-nags PUT_FAILED rows every `PUT_NAG_INTERVAL_MS` (default 30 min).
- One sweeper exception does not kill the timer — next tick proceeds.
- `notifySweepRelease` only fires when 3+ groups are released in a single tick (avoids nightly-mass-release spam).

## Workspace scoping

Each account and each group has a `workspace` column (`VARCHAR(64)`, default
`'DEFAULT'`). At lock-time `lockNextAvailable` requires strict equality:
`account.workspace = group.workspace`. A `DEFAULT` account will never pick up
a `validator247` group and vice versa.

Fresh installs land entirely on `'DEFAULT'` → single-pool behaviour. To
partition (e.g. dedicate v247 groups to one account):

```bash
# tag the account
curl -s -X PUT http://127.0.0.1:8088/v1/accounts/<id> \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"validator247"}'

# tag each v247 group
for g in v247_group_01 v247_group_02 v247_group_03; do
  curl -s -X PUT http://127.0.0.1:8088/v1/groups/$g \
    -H 'Content-Type: application/json' \
    -d '{"workspace":"validator247"}'
done

# verify partitioning
curl -s 'http://127.0.0.1:8088/v1/groups?workspace=validator247' | jq '.[].name'
```

Notes:
- Workspace values: 1-64 chars, regex `/^[a-z0-9_-]+$/i`. Empty or invalid → 400.
- Re-tagging a `LOCKED` group is allowed; it takes effect on the next lock cycle.
- **Footgun**: if you re-tag the account but forget the matching groups (or vice
  versa), the loop hits `group.none-available` and Telegram nags. Always re-tag
  both sides in the same change window.

## Backups

`accounts.json` is kept as a backup even after `db:import-accounts`. The DB is
the source of truth — if you change an account via the admin API and want to
mirror to JSON, do it by hand. The daemon does not write back to JSON.
