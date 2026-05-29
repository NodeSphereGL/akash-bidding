---
phase: 2
title: "Seed Scripts"
status: implemented
priority: P1
effort: "2h"
dependencies: [1]
---

# Phase 2: Seed Scripts

## Overview

One-shot CLI scripts to populate `groups` from the `rpow2/data/` folder list
and migrate `accounts.json` into the `accounts` table. Idempotent — safe to
re-run; existing rows are skipped (or updated where the operator wants).

## Requirements

- Functional:
  - `npm run db:seed-groups` reads dir entries from path in env (default
    `/Users/ductoanbk/Working/Project/BLOCKCHAIN/NODESPHERE/MINING/rpow2/data`),
    inserts each as `groups.name` with `branch = "release/<name>"` and
    `status='AVAILABLE'`. Existing rows skipped (no overwrite).
  - `npm run db:import-accounts` reads `accounts.json`, INSERTs new accounts,
    skips existing by `name`. Prints a summary (added/skipped).
  - Both scripts print a count of rows touched and exit 0.
- Non-functional:
  - Configurable `RPOW2_DATA_DIR` env override.
  - Dry-run flag (`--dry-run`) prints what WOULD happen without writes.

## Architecture

```
scripts/
  db-seed-groups.js        ← NEW
  db-import-accounts.js    ← NEW
src/config.js              ← MODIFIED: + RPOW2_DATA_DIR
```

### Seed flow (groups)

```
1. readdir(RPOW2_DATA_DIR) with { withFileTypes: true }
2. filter: directory only, name matches /^(group_\d+|v247_group_\d+)/
3. for each: groupsRepo.get(name) → if null, insert({name, branch:`release/${name}`})
4. log summary { found, inserted, skipped }
```

### Import flow (accounts)

```
1. readFile(ACCOUNTS_PATH || "./accounts.json"), JSON.parse
2. accountsLoader.validate(raw)  (reuse existing validator)
3. for each: accountsRepo.getByName(a.name) → if null, insert({...})
4. log summary { found, inserted, skipped }
5. DO NOT delete accounts.json — kept as backup
```

## Related Code Files

- Create:
  - `scripts/db-seed-groups.js`
  - `scripts/db-import-accounts.js`
- Modify:
  - `src/config.js` — add `RPOW2_DATA_DIR` (default `/Users/ductoanbk/Working/Project/BLOCKCHAIN/NODESPHERE/MINING/rpow2/data`)
  - `package.json` — scripts `db:seed-groups`, `db:import-accounts`
- Delete: none

## Implementation Steps

1. Add `RPOW2_DATA_DIR` to `loadConfig()` in `src/config.js`.
2. Write `scripts/db-seed-groups.js`:
   - parse `--dry-run` flag.
   - readdir filtered by regex.
   - for each dir name, check `groupsRepo.get` and `insert` if missing.
   - print summary table.
3. Write `scripts/db-import-accounts.js`:
   - reuse `loadAccounts(resolve(config.ACCOUNTS_PATH))` from `src/accounts-loader.js`.
   - INSERT-IF-MISSING per row.
   - print summary.
4. Add npm scripts.

## Success Criteria

- [ ] `npm run db:seed-groups` against empty DB inserts 26 rows (all entries in `rpow2/data`).
- [ ] Re-running inserts 0 rows; summary shows `skipped: 26`.
- [ ] `--dry-run` writes nothing and prints the plan.
- [ ] `npm run db:import-accounts` migrates `accounts.example.json` (or real `accounts.json`) without duplicates.
- [ ] Seed scripts don't require the daemon to be running.

## Risk Assessment

- **Hardcoded RPOW2 path** → operator on another machine would override via `RPOW2_DATA_DIR`. Document in README.
- **v247_group_* validity** → seeded as AVAILABLE; operator must `PUT /v1/groups/:name {status:DISABLED}` for any non-runnable ones (per brainstorm decision). Print a `WARN` in seed output listing v247_* rows so operator notices.
- **Accidental overwrite of locked group** → seed never UPDATE, only INSERT — locked rows are safe.

## Notes

- Branch naming: `release/<group_name>` — based on the Google Sheet table example
  (`release/group_01_vast_ai`). Confirm with operator if v247_group_* uses a different convention; default same for now.
