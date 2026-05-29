---
phase: 7
title: "Config and Tests"
status: implemented
priority: P2
effort: "3h"
dependencies: [1, 2, 3, 4, 5, 6]
---

# Phase 7: Config and Tests

## Overview

Finalize `.env.example`, README updates, and add focused tests. Two test
categories: pure-function unit tests (no infra) and one integration test
that requires a real MySQL.

## Requirements

- Functional:
  - `.env.example` documents all new env vars with sensible defaults.
  - README adds a "Group management" section and quickstart.
  - `docs/api-examples.md` lists curl examples for every API route.
  - Tests cover: SDL injection, group lock race, sweeper expiry, API route validation.
- Non-functional:
  - Test suite still runs via `npm test` (no new test framework).
  - Integration tests gated by `MYSQL_TEST_*` env — skip if unset.

## Architecture

```
.env.example             ← MODIFIED
README.md                ← MODIFIED
docs/
  api-examples.md        ← NEW
  group-management.md    ← NEW (operator guide)
tests/
  sdl.test.js                       ← NEW
  groups-repo-race.int.test.js      ← NEW (integration, gated)
  sweeper.test.js                   ← NEW (unit, mocked repos)
  api-validation.test.js            ← NEW (unit, in-memory server)
  notify-put-failed.test.js         ← NEW
```

## Related Code Files

- Create:
  - `.env.example` (if missing) or extend
  - `docs/api-examples.md`
  - `docs/group-management.md`
  - 5 test files above
- Modify:
  - `README.md` — add Group management section, link to docs
  - `package.json` — keep `test` script; add `test:int` if integration gated separately
- Delete: none

## Implementation Steps

1. Extend `.env.example`:
   ```
   # MySQL
   MYSQL_HOST=127.0.0.1
   MYSQL_PORT=3306
   MYSQL_USER=akashbid
   MYSQL_PASSWORD=
   MYSQL_DATABASE=akash_bidding

   # Group management
   GROUP_LOCK_HOURS=24
   SWEEP_INTERVAL_MS=300000
   PUT_NAG_INTERVAL_MS=1800000
   RPOW2_DATA_DIR=/Users/ductoanbk/Working/Project/BLOCKCHAIN/NODESPHERE/MINING/rpow2/data

   # Admin API
   API_HOST=127.0.0.1
   API_PORT=8088
   ```

2. Update README.md:
   - Add prereq: MySQL running locally.
   - Add quickstart:
     ```
     npm run db:migrate
     npm run db:seed-groups
     npm run db:import-accounts
     npm start
     ```
   - Add API quickref: `curl http://127.0.0.1:8088/v1/groups`.
   - Update "Known limitations" — remove persistence note (now persists).
   - Add new section: "Post-lease automation" describing GROUP_NAME flow.

3. Write `docs/group-management.md`:
   - Daily ops (check API for status, force-release).
   - PUT_FAILED runbook (what to investigate, when to release).
   - Adding a new group / disabling v247_*.

4. Write `docs/api-examples.md` — curl per endpoint (list, get, create, update, delete, release).

5. Tests:
   - `sdl.test.js`: load template fixture, inject 3 different group names, assert exact substring + immutability of input.
   - `groups-repo-race.int.test.js`: against real MySQL (or skipped if env missing). Seed 5 groups, launch 5 concurrent `lockNextAvailable` calls via Promise.all, assert 5 distinct group names returned, no errors.
   - `sweeper.test.js`: mock repos returning fake `expireDue`/`listPutFailedNagDue`. Drive sweeper via injected fake timer (or directly call its sweep function). Assert: nag fires once when listPutFailedNagDue returns row, markNagged called.
   - `api-validation.test.js`: spin up server on random port, hit endpoints with bad bodies, assert 400/415/413/404 codes.
   - `notify-put-failed.test.js`: stub fetch, assert message body contains group name + dseq + error.

6. Verify existing tests still pass:
   - `bidder.test.js` — unchanged.
   - `logger.test.js` — unchanged.
   - `orchestrator-invariants.test.js` / `orchestrator-concurrency.test.js` — may need updates because `runAccountLoop` signature/deps changed (now needs `sdlTemplate`, accounts repo). Update mocks accordingly.

## Success Criteria

- [ ] `npm test` exits 0 with at least 5 new test files contributing assertions.
- [ ] Race test verifies no two loops can grab the same group under concurrency.
- [ ] README quickstart followed end-to-end on a clean MySQL produces a working daemon.
- [ ] `.env.example` is complete; daemon refuses to start with clear messages if `MYSQL_*` missing.
- [ ] `docs/group-management.md` covers PUT_FAILED runbook + ops basics.

## Risk Assessment

- **Integration test brittleness** — MySQL test DB must exist. Gate via `MYSQL_TEST_HOST` etc.; skip with logged message if unset.
- **Test/prod env confusion** — integration tests should use a SEPARATE `MYSQL_TEST_DATABASE` (e.g., `akash_bidding_test`). Truncate tables before each test.
- **Race test flakiness** — use `Promise.all` with small N (5). If flaky, raise to 10 and accept slower test.
- **Existing orchestrator tests break** — expected, update mocks to provide DB stubs.

## Notes

- Don't add Jest / mocha — keep using node:test runner.
- Don't ship a docker-compose for MySQL — operator runs their own. Mention `brew services start mysql` in README.
