---
title: Workspace scoping for groups and accounts
description: >-
  Add a denormalized `workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT'` column
  to both `groups` and `accounts`. Enforce strict workspace equality at
  lock-time so an account only ever locks groups in its own workspace. Expose
  workspace on admin API (filter + body) and accounts.json import. No registry
  table — KISS. Operator re-tags rows via admin API at go-live.
status: completed
priority: P2
branch: main
tags:
  - akash
  - mysql
  - workspace
  - group-management
  - feature
blockedBy: []
blocks: []
created: '2026-05-29T04:29:00.000Z'
createdBy: 'ck:plan'
source: skill
---

# Workspace scoping for groups and accounts

## Overview

Introduce workspace partitioning between accounts and groups. 1 workspace → N accounts; 1 workspace → N groups; account.workspace must equal group.workspace at lock-time. Existing rows default to `'DEFAULT'` so behaviour is unchanged until operator re-tags. Brainstorm summary: `./brainstorm-summary.md`.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Schema migration](./phase-01-schema-migration.md) | Completed |
| 2 | [Repo + loop wiring](./phase-02-repo-loop-wiring.md) | Completed |
| 3 | [Admin API + scripts](./phase-03-admin-api-scripts.md) | Completed |
| 4 | [Tests + docs](./phase-04-tests-docs.md) | Completed |

## Dependencies

Builds on `260529-1500-group-aware-auto-lease` (status: implemented) — the MySQL groups/accounts schema and `lockNextAvailable` flow. No blocking plans.

## Context Links

- Brainstorm summary: `./brainstorm-summary.md`
- Prior plan: `../260529-1500-group-aware-auto-lease/plan.md`
- Existing migration: `src/db/migrations/001_init.sql`
- Lock function: `src/db/repo/groups.js:62` (`lockNextAvailable`)
- Admin routes: `src/api/routes/groups.js`, `src/api/routes/accounts.js`
