---
phase: 4
title: "Account rotator and balance gating"
status: pending
priority: P1
effort: "2h"
dependencies: [2]
---

# Phase 4: Account rotator and balance gating

## Overview

Implement `src/rotator.js` — a round-robin account ring with an in-memory exhausted-set. Loader reads `accounts.json`, validates schema, builds the ring. Orchestrator calls `rotator.next()` per cycle. Balance gating lives inline in the orchestrator but uses rotator state to mark exhausted accounts and detect the all-exhausted condition.

## Requirements

- Functional: `loadAccounts(path)` returns validated `Account[]`.
- Functional: `createRotator(accounts)` returns `{ next, markExhausted, isAllExhausted, healthy }`.
- Functional: round-robin skips exhausted accounts in O(N).
- Non-functional: in-memory only (no persistence); reset on daemon restart by design.

## Architecture

```
accounts.json
    │
    ▼
loadAccounts(path) ──► validates each entry: name(str), apiKey(str), proxy(str|null)
                       throws if duplicate name or missing apiKey
    │
    ▼
createRotator(accounts)
    │
    ├── state: { ring: Account[], exhausted: Set<string>, cursor: number }
    │
    ├── next() → Account
    │     advances cursor; skips exhausted; throws AllExhaustedError if loop completes empty
    │
    ├── markExhausted(account, reason) → void
    │     adds account.name to exhausted set; logs reason
    │
    ├── isAllExhausted() → boolean
    │
    └── healthy() → Account[]   // for diagnostics
```

Balance gating integrated in orchestrator:
```
account = rotator.next()
bal = akash.getBalance(account)
if (bal < MIN_BALANCE_USD):
   rotator.markExhausted(account, `balance ${bal} < ${MIN_BALANCE_USD}`)
   if (rotator.isAllExhausted()): notifyAllDepleted() + process.exit(0)
   continue
```

## Related Code Files

- Create: `src/rotator.js`
- Create: `src/accounts-loader.js` (separate validator)
- Create: `tests/rotator.test.js`
- Create: `accounts.example.json` (template, NO real keys)
- Modify: `.gitignore` (already excludes accounts.json — verify)

## Implementation Steps

1. Write `src/accounts-loader.js`:
   - `loadAccounts(path)` reads file, parses JSON, validates each entry.
   - Throw on: missing `name`, missing `apiKey`, duplicate names, non-array root.
   - Normalize: `proxy: null` if empty string/missing.
2. Write `src/rotator.js`:
   - `createRotator(accounts)` returns the 4 methods above.
   - `next()` uses while-loop bounded to `accounts.length` to avoid infinite loop.
   - `AllExhaustedError` class (re-export from `src/errors.js`).
3. Write `accounts.example.json`:
   ```json
   [
     { "name": "trial-1", "apiKey": "REPLACE_ME", "proxy": "http://user:pass@1.2.3.4:8080" },
     { "name": "trial-2", "apiKey": "REPLACE_ME", "proxy": null }
   ]
   ```
4. Write unit tests:
   - 3 accounts: round-robin order matches insertion.
   - Mark account #2 exhausted → next() skips it.
   - Mark all exhausted → next() throws AllExhaustedError; `isAllExhausted()` returns true.
   - Loader rejects duplicate names.
   - Loader rejects missing apiKey.
5. Run tests.

## Success Criteria

- [ ] Loader rejects malformed `accounts.json` with clear error messages.
- [ ] Round-robin verified across 3+ accounts.
- [ ] Exhausted-set persists within process; survives many `next()` calls.
- [ ] `isAllExhausted()` flips at the right moment.
- [ ] Unit tests pass.
- [ ] `accounts.example.json` committed; real `accounts.json` git-ignored.

## Risk Assessment

- **In-memory exhausted state lost on restart** → daemon will re-query balance for previously-depleted accounts on startup. Acceptable; getBalance is one cheap call per account at startup.
- **Account name collision** → loader rejects at load time. Documented in error message.
- **Single-account config** → ring of size 1 works; exhausted → immediate all-depleted exit.
