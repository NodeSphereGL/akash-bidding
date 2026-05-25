---
phase: 2
title: "Akash API client"
status: pending
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 2: Akash API client

<!-- Updated: Validation Session 1 — request() retries without proxy on proxy-side errors -->

## Overview

Implement `src/akash.js` — a stateless API client wrapping the Akash Console managed-wallet endpoints. Per-call `{apiKey, proxy}` injection (no module-level account state). Proxy handled via memoized `undici.ProxyAgent` instances. Per-request 30s timeout. **On proxy-side errors (connect refused, timeout via proxy, DNS), the request is retried ONCE with no proxy.** Schema fields locked from Phase 1 `findings.md`.

## Requirements

- Functional: 6 exported async functions — `createDeployment`, `getBids`, `createLease`, `closeDeployment`, `getBalance`, plus a private `request` helper.
- Non-functional: zero shared state, fully unit-testable with mocked `fetch`, 30s timeout per request, structured error class `AkashApiError` with `status`, `code`, `body`.

## Architecture

```
akash.request(account, method, path, body) → Response | throws AkashApiError
   │ builds URL from AKASH_API_BASE + path
   │ injects x-api-key header
   │ injects dispatcher (memoized ProxyAgent) when account.proxy set
   │ wraps fetch in AbortController with REQUEST_TIMEOUT_MS
   │ on non-2xx → throw AkashApiError(status, body)
   │
   ├── createDeployment(account, sdlString, depositUsd) → { dseq, txHash }
   ├── getBids(account, dseq) → BidArray
   ├── createLease(account, bidComposite, manifestString) → LeaseObject
   ├── closeDeployment(account, dseq) → void
   └── getBalance(account) → { balanceUsd: number }
```

Module-level `agentCache: Map<string, ProxyAgent>` memoizes by proxy URL.

## Related Code Files

- Create: `src/akash.js`
- Create: `src/errors.js` (defines `AkashApiError`)
- Read for context: `scripts/probe-output/findings.md`, `akash-deploy.yaml`

## Implementation Steps

1. Create `src/errors.js`:
   ```js
   export class AkashApiError extends Error {
     constructor(status, code, body) {
       super(`Akash API ${status}: ${code ?? "unknown"}`);
       this.status = status; this.code = code; this.body = body;
     }
   }
   ```
2. Create `src/akash.js` skeleton importing `fetch, ProxyAgent` from `undici`.
3. Implement `getDispatcher(proxyUrl)` with memoization.
4. Implement private `request(account, method, path, body)`:
   - `AbortController` with `setTimeout(..., REQUEST_TIMEOUT_MS)`.
   - Set `x-api-key`, `Content-Type: application/json`.
   - Pass `dispatcher` if proxy set.
   - On non-2xx: parse body, throw `AkashApiError`.
   - **Proxy-fail fallback:** if the underlying fetch throws a transport error (`UND_ERR_*`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, or AbortError with no response received) AND account had a proxy, retry the exact same request ONCE with `dispatcher: undefined`. Log a warning `proxy.fallback` with account name and original error code. If the no-proxy retry also fails, propagate the error.
   - Distinguish transport errors from `AkashApiError` (which represents server-side non-2xx, NOT eligible for retry).
5. Implement each endpoint function using paths/schemas locked in Phase 1:
   - `createDeployment` → `POST /v1/deployments`, body `{ sdl, deposit }`.
   - `getBids` → `GET /v1/bids?dseq=`.
   - `createLease` → `POST /v1/leases` (body shape from Phase 1).
   - `closeDeployment` → `DELETE /v1/deployments/{dseq}`.
   - `getBalance` → endpoint determined by Phase 1.
6. Add JSDoc typedef comments for the bid and lease objects so callers get IDE hints.
7. Manual smoke: import in a temp script and run each function against the live API once.

## Success Criteria

- [ ] All 5 endpoint functions exported with consistent signatures.
- [ ] `AkashApiError` thrown on every non-2xx with status + body preserved.
- [ ] Proxy verified: a request through configured proxy shows the proxy IP via a separate IP-check.
- [ ] No proxy → direct `fetch` works.
- [ ] 30s timeout aborts a hanging request and throws.
- [ ] Proxy-fail fallback: stubbing a dead proxy URL still completes the request via direct fetch with one warning log line.
- [ ] Smoke run hits all 5 endpoints successfully against a real account.

## Risk Assessment

- **API contract drift** vs Phase 1 findings → keep `findings.md` as the spec; revisit if endpoint behavior changes mid-implementation.
- **ProxyAgent socket exhaustion** under steady load → memoization handles most of it; add max-sockets if observed.
- **AbortController + undici interaction** can leave dangling sockets → ensure `clearTimeout` on every code path (try/finally).
