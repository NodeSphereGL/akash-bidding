---
phase: 3
title: Admin API + scripts
status: completed
priority: P2
effort: 2h
dependencies:
  - 2
---

# Phase 3: Admin API + scripts

## Overview
Expose `workspace` on the admin HTTP API (filter + body + response field) and let the accounts import script honour an optional `workspace` field in `accounts.json`.

## Requirements
- Functional:
  - `GET /v1/groups?workspace=X` filters by workspace.
  - `POST /v1/groups` and `PUT /v1/groups/:name` accept `workspace` in body.
  - `POST /v1/accounts` and `PUT /v1/accounts/:id` accept `workspace` in body.
  - Response JSON of both resources exposes `workspace`.
  - `scripts/db-import-accounts.js` reads optional `workspace` per row.
- Non-functional:
  - Validation regex `/^[a-z0-9_-]+$/i`, max 64 chars, non-empty.
  - Backward compatibility: body without `workspace` → column default applies.
  - Loopback-only API (existing constraint), no auth required.

## Architecture
Validation at the JSON boundary in route handlers. `toJson` adds `workspace`. Seeder script untouched (still warns for `v247_*`, no auto-tag).

## Related Code Files
- Modify: `src/api/routes/groups.js`
- Modify: `src/api/routes/accounts.js`
- Modify: `scripts/db-import-accounts.js`
- Modify: `accounts.example.json`
- (No changes: `scripts/db-seed-groups.js` — keeps warning, no auto-tag)

## Implementation Steps

### 1. `src/api/routes/groups.js`
- Add `const WORKSPACE_RE = /^[a-z0-9_-]+$/i;`
- `toJson(row)` — include `workspace: row.workspace`.
- `list(req, res, { query })` — read `query.get("workspace")`; if present, validate with regex and pass to `groupsRepo.listAll({ status, workspace })`.
- `create(...)` — if `body.workspace != null`, validate and pass to `insert`.
- `update(...)` — if `body.workspace != null`, validate and add to `patch`.
- Validation errors: throw `HttpError(400, "VALIDATION", "invalid workspace")`.

### 2. `src/api/routes/accounts.js`
- Add `const WORKSPACE_RE = /^[a-z0-9_-]+$/i;`
- `toJson(a, …)` — include `workspace: a.workspace`.
- `create(...)` and `update(...)` — if `body.workspace != null`, validate and pass through.
- `update` patch loop: extend the for-of allowlist to include `workspace`.

### 3. `scripts/db-import-accounts.js`
- When iterating `accounts.json`, if a row has `workspace`, pass it to `accountsRepo.insert`. Default omitted → column default applies.
- No schema validation here; the API regex is the canonical gate (script is operator-trusted).

### 4. `accounts.example.json`
- Add an example showing the optional field, e.g.:
  ```json
  {
    "name": "acct1",
    "apiKey": "...",
    "proxy": "http://...",
    "workspace": "DEFAULT"
  }
  ```
  with a comment in the README that the field is optional.

## Success Criteria
- [ ] `GET /v1/groups` returns `workspace` in every row's JSON
- [ ] `GET /v1/groups?workspace=validator247` returns only matching rows
- [ ] `GET /v1/groups?workspace=` (empty) or invalid chars → HTTP 400
- [ ] `PUT /v1/groups/:name {"workspace": "validator247"}` updates the row and the value persists
- [ ] `POST /v1/accounts {…, "workspace": "validator247"}` creates row with that workspace
- [ ] `npm run db:import-accounts` honours `workspace` field; rows without it default to `'DEFAULT'`
- [ ] `docs/api-examples.md` still works for existing curl examples (no workspace) — no breaking change

## Risk Assessment
- **Validation drift** — regex must match repo layer (no DB-level CHECK). Mitigated by single constant per route file; if it drifts, the strictest gate wins (the API). Acceptable.
- **Empty-string workspace** — explicit reject via regex (no `^$` match). Documented as 400.
- **Re-tagging a LOCKED group** — allowed by design (operator override). Document this behaviour in `docs/group-management.md` so operator understands the take-effect-next-cycle semantics. Doc update in Phase 4.
