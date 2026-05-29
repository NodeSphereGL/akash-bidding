---
phase: 6
title: "Admin HTTP API"
status: implemented
priority: P2
effort: "4h"
dependencies: [1]
---

# Phase 6: Admin HTTP API

## Overview

Local CRUD HTTP API on `127.0.0.1:API_PORT` (default 8088), no auth, built on
`node:http`. Three resources: `/v1/groups`, `/v1/accounts`, `/v1/deployments`.
Wraps Phase 1 repos. JSON in/out.

Used by operator via curl/Postman or a future UI. Daemon does NOT depend on
the API — sweeper and loops talk directly to repos.

## Requirements

- Functional endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/v1/groups?status=AVAILABLE` | list groups, filter by status |
| GET    | `/v1/groups/:name` | single group |
| POST   | `/v1/groups` | `{name, branch, notes?}` |
| PUT    | `/v1/groups/:name` | `{status?, branch?, notes?}` |
| DELETE | `/v1/groups/:name` | delete |
| POST   | `/v1/groups/:name/release` | force-release lock |
| GET    | `/v1/accounts` | list (optionally filter `enabled=true`) |
| GET    | `/v1/accounts/:id` | single |
| POST   | `/v1/accounts` | `{name, apiKey, proxy?, enabled?}` |
| PUT    | `/v1/accounts/:id` | patch |
| DELETE | `/v1/accounts/:id` | delete |
| GET    | `/v1/deployments?account_id=&status=` | list (paginated) |
| GET    | `/v1/deployments/:dseq` | single |
| GET    | `/health` | `{ok:true, db:"connected"}` |

- Non-functional:
  - Bind explicitly to `127.0.0.1` (never `0.0.0.0`).
  - No auth, no rate limit.
  - All bodies JSON; non-JSON → 415.
  - Errors: `{error: "msg", code: "NAME"}` with proper HTTP status.
  - camelCase in JSON I/O. Repos return snake_case → convert at boundary.

## Architecture

```
src/api/
  server.js              ← NEW: createServer(deps).listen(port, host)
  router.js              ← NEW: tiny method+path matcher (no Express)
  json-body.js           ← NEW: parse request body with size limit
  routes/
    groups.js            ← NEW
    accounts.js          ← NEW
    deployments.js       ← NEW
    health.js            ← NEW
src/index.js             ← MODIFIED: start API server alongside sweeper + loops
```

### Router (minimal)

No Express dep. Use a tiny matcher:

```js
const routes = [
  { method: "GET",    pattern: /^\/v1\/groups$/,             handler: groups.list },
  { method: "GET",    pattern: /^\/v1\/groups\/([^/]+)$/,    handler: groups.get },
  { method: "POST",   pattern: /^\/v1\/groups$/,             handler: groups.create },
  { method: "PUT",    pattern: /^\/v1\/groups\/([^/]+)$/,    handler: groups.update },
  { method: "DELETE", pattern: /^\/v1\/groups\/([^/]+)$/,    handler: groups.remove },
  { method: "POST",   pattern: /^\/v1\/groups\/([^/]+)\/release$/, handler: groups.release },
  // ... accounts, deployments, health
];

function match(req) { for (const r of routes) if (r.method===req.method) {
  const m = req.url.split("?")[0].match(r.pattern);
  if (m) return { handler: r.handler, params: m.slice(1) };
}}
```

### Handler signature

```js
async function handler(req, res, { params, query, body, deps }) {
  // ...
  sendJson(res, 200, { ... });
}
```

### Naming map (snake_case → camelCase)

```js
// at boundary
function toJson(row) {
  if (!row) return row;
  return {
    name: row.name,
    branch: row.branch,
    status: row.status,
    lockedByAccountId: row.locked_by_account_id,
    lockedDseq: row.locked_dseq,
    lockedAt: row.locked_at,
    expiresAt: row.expires_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

Per-resource toJson; deployments has `groupName`, `accountId`, etc.

### Validation

Hand-rolled minimal validators per route (no zod/ajv — KISS):

```js
function validateGroupCreate(body) {
  if (!body || typeof body !== "object") return "body required";
  if (!body.name || !/^[a-z0-9_]+$/i.test(body.name)) return "invalid name";
  if (!body.branch || typeof body.branch !== "string") return "branch required";
  return null;
}
```

Return 400 with `{error: msg, code: "VALIDATION"}` on failure.

### Health endpoint

```js
GET /health → 200 { ok: true, db: "connected" }
            → 503 { ok: false, db: "down", error: "..." } if pool query fails
```

## Related Code Files

- Create:
  - `src/api/server.js`
  - `src/api/router.js`
  - `src/api/json-body.js`
  - `src/api/routes/groups.js`
  - `src/api/routes/accounts.js`
  - `src/api/routes/deployments.js`
  - `src/api/routes/health.js`
- Modify:
  - `src/index.js` — start server with `createServer(deps).listen(API_PORT, API_HOST)`
  - `src/config.js` — add `API_PORT` (default 8088), `API_HOST` (default "127.0.0.1")
  - `package.json` — no new deps
- Delete: none

## Implementation Steps

1. Write `json-body.js` — async `parseJsonBody(req, {limit: 100*1024})`. Reject >100KB with 413.
2. Write `router.js` per pattern above. Export `dispatch(req, res, deps)`.
3. Write per-resource route modules. Each route: validate → call repo → toJson → respond.
4. Write `health.js` — `SELECT 1` via pool.
5. Write `server.js` — create http server with single request handler that delegates to `dispatch`, with top-level try/catch that returns 500 + logged error.
6. Wire into `main()`: start after sweeper, before supervisor while-loop. Log `api.listen` with host+port.
7. On SIGINT, close server gracefully.
8. Add curl smoke tests in `docs/api-examples.md` for each endpoint.

## Success Criteria

- [ ] `curl http://127.0.0.1:8088/v1/groups` returns 26 rows after seed.
- [ ] `curl -X POST http://127.0.0.1:8088/v1/groups -d '{"name":"test_group","branch":"release/test_group"}'` → 201 + body.
- [ ] `curl -X PUT http://127.0.0.1:8088/v1/groups/test_group -d '{"status":"DISABLED"}'` → 200 + updated row.
- [ ] `curl -X POST http://127.0.0.1:8088/v1/groups/test_group/release` clears lock fields.
- [ ] Binding non-loopback IP → daemon refuses or warns (verify by checking `netstat -an | grep 8088` shows `127.0.0.1`).
- [ ] `GET /health` returns 200 when DB up; 503 when MySQL stopped.
- [ ] Bodies > 100KB → 413.
- [ ] SIGINT closes server with no in-flight requests pending.

## Risk Assessment

- **No auth on a sensitive admin surface** — fully owned: bound to loopback. SSH tunnel for remote use. Doc this explicitly.
- **JSON parse DoS via huge body** — mitigated by 100KB cap in `json-body.js`.
- **Concurrent writes via API + sweeper + loops** — DB FOR UPDATE handles group locks. Other tables are single-row updates by PK; conflicts are rare and either operation wins cleanly.
- **API server crash kills daemon** — server runs in same process; an uncaught exception in a handler must be caught at the request level. Top-level `try/catch` per request mandatory.
- **camelCase / snake_case drift** — fix by centralizing `toJson` per resource. Lint with a smoke test.

## Notes

- Path param parsing: use `URL` API for query parsing — `new URL(req.url, "http://x")`.
- Don't add CORS — local-only.
- Don't add CSRF — no browser auth.
