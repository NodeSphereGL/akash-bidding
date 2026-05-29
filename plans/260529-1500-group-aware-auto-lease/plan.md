---
title: "Group-Aware Auto-Lease with MySQL + Admin API"
description: >-
  Replace Google-Sheet group management with local MySQL. After Akash lease,
  daemon picks next available group (sequential), PUTs new SDL with
  GROUP_NAME env into deployment, writes audit row. Background sweeper
  releases 24h-expired group locks. Local CRUD HTTP API on 127.0.0.1 for
  groups/accounts/deployments admin. Eliminates manual SSH+git+tmux post-lease.
status: implemented
priority: P2
branch: "main"
tags: [akash, mysql, group-management, sdl, automation]
blockedBy: []
blocks: []
created: "2026-05-29T08:00:00.000Z"
createdBy: "ck:plan"
source: skill
---

# Group-Aware Auto-Lease with MySQL + Admin API

## Overview

Today the daemon leases an Akash GPU and stops — operator must SSH into the
container, `git checkout release/group_XX`, start tmux, run the miner.
Group assignments tracked in a Google Sheet — error-prone, two machines can
collide on the same group.

This plan adds a state layer (MySQL) and post-lease automation:

1. After lease success → daemon locks next AVAILABLE group via `SELECT … FOR UPDATE`.
2. Builds new SDL from template with `GROUP_NAME=<picked>` env.
3. PUTs `/v1/deployments/{dseq}` so `toanbk/rpow2:v1` boots with the right group.
4. Writes a deployments audit row.
5. Sweeper releases locks 24h after lease (deposit drains, Akash auto-evicts).
6. Local CRUD HTTP API (127.0.0.1, no auth) for groups + accounts + deployments.

Brainstorm summary: [./brainstorm-summary.md](./brainstorm-summary.md)

## Goals

- Zero-touch post-lease: no SSH, no git checkout, no tmux.
- Concurrency-safe group lock — N account loops cannot collide.
- Persist state across daemon restarts (groups, accounts, deployments).
- Replace `accounts.json` with `accounts` table; keep JSON as backup.
- Admin via curl/UI without editing files or restarting daemon.
- Telegram visibility on lease, PUT failure (with 30-min nag), sweeper releases.

## Non-Goals

- Closing deployments via Akash API on expiry (auto-evicts when deposit drains).
- SSH info storage / port mapping.
- Web UI dashboard.
- API authentication (loopback only).
- Multi-host deployment of the daemon.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [DB Foundation](./phase-01-db-foundation.md) | Implemented |
| 2 | [Seed Scripts](./phase-02-seed-scripts.md) | Implemented |
| 3 | [Akash PUT and SDL Injection](./phase-03-akash-put-and-sdl-injection.md) | Implemented |
| 4 | [Loop Integration](./phase-04-loop-integration.md) | Implemented |
| 5 | [Sweeper and Telegram Nag](./phase-05-sweeper-and-telegram-nag.md) | Implemented |
| 6 | [Admin HTTP API](./phase-06-admin-http-api.md) | Implemented |
| 7 | [Config and Tests](./phase-07-config-and-tests.md) | Implemented |

## Phase Dependencies

```
1 (DB Foundation)
├── 2 (Seed Scripts)            ← needs repos + migrations
├── 3 (Akash PUT + SDL)         ← independent of DB; can run parallel to 1/2
├── 4 (Loop Integration)        ← needs 1 + 3
├── 5 (Sweeper + Nag)           ← needs 1 + 4 (deployments rows exist)
├── 6 (Admin HTTP API)          ← needs 1
└── 7 (Config + Tests)          ← needs all
```

## Dependencies

None across plans. Parent plan `260525-1500-akash-auto-bidding-tool` shipped
the base daemon; this extends it. `260525-1700-per-account-concurrent-loops`
completed — `runAccountLoop` is the integration point.

## Key Decisions (from brainstorm)

| # | Decision |
|---|----------|
| 1 | Pick group AFTER lease via PUT (not pre-create) |
| 2 | MySQL (not SQLite) |
| 3 | DB stores: groups + accounts + deployments (skip SSH info) |
| 4 | Sequential group pick (group_01 → group_NN) |
| 5 | Sweeper releases locks at 24h; no Akash close |
| 6 | PUT failure → keep locked, Telegram every 30 min |
| 7 | New group each lease cycle |
| 8 | Seed all 26 folders from `/MINING/rpow2/data` |
| 9 | API: node:http, 127.0.0.1, no auth |
| 10 | New lease cycle picks new group (old released by sweeper) |

## Risks (carried from brainstorm)

1. PUT failure burns 24h trial silently → 30-min Telegram nag (mitigates, doesn't fix).
2. MySQL infra requirement → operator runs local mysqld.
3. Some v247_group_* folders may not be runnable → operator disables via API.
4. Loopback API + no auth → safe only on non-shared host.

## Validation Log

### Session 1 — 2026-05-29

Verification pass (Full tier — 7 phases):

- Claims checked: 12 (file existence, exports, folder contents, test names, config keys)
- Verified: 11 | Failed: 0 | Unverified: 1 (Akash PUT response shape — no live API call this session)
- Note: tests folder also has `config.test.js` + `errors.test.js` (plan didn't claim them missing; informational only).
- All file paths, module exports, and rpow2/data folder count (26) confirmed.

Interview decisions (6 questions):

| # | Question | Decision |
|---|----------|----------|
| 1 | Empty accounts DB on boot | Hard-fail with hint (no JSON fallback) |
| 2 | Group pick order | Keep sequential (operator disables bad groups manually) |
| 3 | `proxy` column width | Bump to `VARCHAR(512)` (was 255) |
| 4 | PUT_FAILED cleanup | Leave to expire (Akash auto-evicts) — confirms earlier decision |
| 5 | Integration test in CI | Skip if `MYSQL_TEST_*` unset; local-only by default |
| 6 | snake_case/camelCase boundary | Keep asymmetry: accounts repo maps internally; groups+deployments map only at API |

### Propagated changes

- `brainstorm-summary.md` — accounts.proxy VARCHAR(255) → VARCHAR(512). Phase 1's migrations/001_init.sql must reflect this (Phase 1 already references the brainstorm schema verbatim — implementer reads the updated schema).

### Whole-Plan Consistency Sweep

- Re-read plan.md + all 7 phase files after validation edits.
- Schema for `proxy` column now consistent (only in brainstorm-summary.md; Phase 1 references "schema in brainstorm summary §DB schema").
- All other 5 decisions only confirmed existing plan content — no propagation needed.
- No contradictions remaining.
- Status: clean. Plan is ready for `/ck:cook`.

### Session 2 — 2026-05-29 (implementation)

All 7 phases implemented via `/ck:cook` in auto mode.

- 62 tests run, 61 pass, 1 skipped (integration race test gated on `MYSQL_TEST_*`).
- Existing orchestrator/concurrency/invariants tests still pass (loop guards behind `if (groupsRepoDep)` so legacy test fakes don't need the new deps).
- Code review (code-reviewer subagent) returned DONE_WITH_CONCERNS, no blockers. Applied 3 follow-ups:
  - `routes/accounts.js`: duplicate name → 409 (was 500).
  - `sendTelegram`: 10s `AbortController` timeout so sweeper can't stall on Telegram.
  - `sdl.js`: comment that `injectGroupName` replaces the full env array.
- One reviewer concern parked: deployments status starts at `LEASED` (not `CREATED → LEASED`). Plan phase-04 line 28 explicitly says `status=LEASED` at insert time — matches implementation. Enum keeps `CREATED` for forward use only.

### Outstanding (not blockers)

- MySQL not running on this machine at cook time → migrations + race integration test deferred to operator.
- `npm run db:migrate && npm run db:seed-groups && npm run db:import-accounts` must run before first `npm start`.
