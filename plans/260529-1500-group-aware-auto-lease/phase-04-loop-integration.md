---
phase: 4
title: "Loop Integration"
status: implemented
priority: P1
effort: "6h"
dependencies: [1, 3]
---

# Phase 4: Loop Integration

## Overview

Wire DB + SDL injection + PUT into `runAccountLoop` so the post-lease handoff
is fully automatic. Account loader switches from `accounts.json` to DB.
On lease success: write `deployments` row (CREATED → LEASED), lock next
group, PUT new SDL, update row (PUT_OK or PUT_FAILED). On PUT failure:
keep group locked at status `PUT_FAILED`, deployment row at `PUT_FAILED`,
Telegram once (sweeper handles 30-min nag in Phase 5).

This is the highest-risk phase — touches the live orchestrator.

## Requirements

- Functional:
  - Daemon boots: loads `accounts` from DB (enabled=true), loads SDL template once.
  - Per account lease success path:
    1. Insert `deployments` row with status=LEASED, leased_at=NOW, expires_at=NOW+24h.
    2. `groupsRepo.lockNextAvailable(account.id, dseq, 24)`. If returns null → no free group → status=PUT_FAILED on the deployment (with `last_error: "no available group"`), Telegram alert, skip PUT.
    3. Build SDL via `sdl.injectGroupName(template, lockedGroup.name)`.
    4. `akash.updateDeployment(ctx, dseq, newSdl)`.
    5. On success → `deploymentsRepo.updateStatus(dseq, "PUT_OK", { group_name: <name> })`.
       Telegram `notifyLeaseSuccess` includes group_name.
    6. On PUT failure → `deploymentsRepo.updateStatus(dseq, "PUT_FAILED", { last_error, put_attempts: 1 })`. Group flipped from `LOCKED` → `PUT_FAILED` (lock metadata preserved: `locked_by_account_id`, `locked_dseq`, `locked_at`, `expires_at` stay set so sweeper can nag with context). Telegram alert.
  - Lease hold sleep is unchanged (LEASE_HOLD_MS).
  - On loop exit (exhausted), no extra DB writes needed.
- Non-functional:
  - All new DB writes wrapped in try/catch with `cycleLog.error` on failure.
  - DB errors don't crash the loop — log + continue (the lease is still alive on Akash; operator can fix manually).

## Architecture

### Modified runAccountLoop

```js
// pseudocode after pollAndLease returns leased=true
if (result.leased) {
  let groupName = null;
  let putStatus = "PENDING";

  // 1. record deployment
  try {
    await deploymentsRepo.insert({
      dseq,
      accountId: account.id,
      provider: result.bid.provider,
      uactPerBlock: result.bid.uactPerBlock,
      status: "LEASED",
      leasedAt: new Date(),
      expiresAt: addHours(new Date(), config.GROUP_LOCK_HOURS),
    });
  } catch (e) { cycleLog.error("db.deployment.insert.failed", { error: e.message }); }

  // 2. lock group
  let group;
  try {
    group = await groupsRepo.lockNextAvailable(account.id, dseq, config.GROUP_LOCK_HOURS);
  } catch (e) { cycleLog.error("db.group.lock.failed", { error: e.message }); }

  if (!group) {
    cycleLog.warn("group.none-available", { dseq });
    await deploymentsRepo.updateStatus(dseq, "PUT_FAILED", {
      last_error: "no available group",
    }).catch(() => {});
    await notify.notifyPutFailed({ dseq, reason: "no available group", account }, tgCfg(config, cycleLog));
  } else {
    groupName = group.name;
    // 3. inject + PUT
    try {
      const newSdl = sdl.injectGroupName(sdlTemplate, groupName);
      await akash.updateDeployment(ctx, dseq, newSdl);
      await deploymentsRepo.updateStatus(dseq, "PUT_OK", { group_name: groupName, put_attempts: 1 });
      putStatus = "PUT_OK";
      cycleLog.info("deployment.put.ok", { dseq, group: groupName });
    } catch (e) {
      cycleLog.error("deployment.put.failed", { dseq, group: groupName, error: e.message });
      await deploymentsRepo.updateStatus(dseq, "PUT_FAILED", {
        group_name: groupName, last_error: e.message, put_attempts: 1,
      }).catch(() => {});
      await groupsRepo.update(groupName, { status: "PUT_FAILED" }).catch(() => {});
      await notify.notifyPutFailed({ dseq, reason: e.message, group: groupName, account }, tgCfg(config, cycleLog));
      putStatus = "PUT_FAILED";
    }
  }

  await notify.notifyLeaseSuccess({ bid: result.bid, lease: result.lease, account, group: groupName, putStatus },
    tgCfg(config, cycleLog));
  await sleep(config.LEASE_HOLD_MS, abortSignal);
  continue;
}
```

### Accounts loader switch

```js
// src/index.js main()
const accounts = await accountsRepo.listEnabled();
if (accounts.length === 0) {
  // fall back to accounts.json if DB is empty (transitional safety net)
  logger.warn("accounts.db.empty.fallback", {});
  // or: throw — pick one. Recommendation: throw with hint to run db:import-accounts.
}
```

Recommendation: **throw on empty DB** with message
`accounts table empty — run 'npm run db:import-accounts'`. No silent fallback.

### Notify additions

```js
// src/notify.js
export async function notifyLeaseSuccess({ bid, lease, account, group, putStatus }, cfg) { ... }
// ↑ existing signature extended with group + putStatus

export async function notifyPutFailed({ dseq, reason, group, account }, cfg) { ... }
// ↑ NEW: single fire on PUT failure; sweeper handles 30-min nag
```

### Account shape change

DB row → loop expects `{ id, name, apiKey, proxy, enabled }`. Old code passed
`account.apiKey` to akash request. DB column is `api_key` — repo can map to
camelCase OR loop reads `account.api_key`. **Decision:** repo maps to camelCase
at the accounts boundary only (since accounts cross many existing references).
Groups + deployments keep snake_case (used only by new code).

## Related Code Files

- Modify:
  - `src/index.js` — post-lease block (above), `main()` accounts loader
  - `src/notify.js` — extend `notifyLeaseSuccess`, add `notifyPutFailed`
  - `src/accounts-loader.js` — `loadAccountsFromDb()` wrapper around `accountsRepo.listEnabled` with camelCase map
- Create: none (uses Phase 1 + 3 modules)
- Delete: none (accounts.json kept as backup)

## Implementation Steps

1. Extend `notifyLeaseSuccess` signature to accept `group` and `putStatus`. Include in message body.
2. Add `notifyPutFailed`.
3. Refactor `src/accounts-loader.js`: keep `loadAccounts(path)` (JSON), add `loadAccountsFromDb()` that returns same-shaped objects (`{id, name, apiKey, proxy, enabled}`).
4. In `src/index.js` `main()`, replace `loadAccounts(...)` with `loadAccountsFromDb()`. Throw with hint if empty.
5. Load SDL template ONCE via `sdl.loadTemplate(SDL_PATH)`; pass through `deps`.
6. In `runAccountLoop`, inject post-lease block per architecture pseudocode above.
7. Verify cycle log events: `db.deployment.insert.failed`, `db.group.lock.failed`, `group.none-available`, `deployment.put.ok`, `deployment.put.failed`.
8. Smoke test on a sandbox account (real API but cheap): expect new deployment row appears, group LOCKED, PUT succeeds, Telegram fires once.

## Success Criteria

- [ ] Daemon refuses to start if `accounts` table is empty (clear hint message).
- [ ] On a real lease, DB shows: `deployments` row CREATED→LEASED→PUT_OK with `group_name` set; `groups` row flipped AVAILABLE→LOCKED with `expires_at` ≈ now+24h.
- [ ] Two concurrent loops landing leases within seconds get DIFFERENT groups (verified by row inspection).
- [ ] Simulated PUT failure (set wrong dseq) → `deployments.status=PUT_FAILED`, `groups.status=PUT_FAILED`, Telegram fires once.
- [ ] Existing tests (`orchestrator-invariants`, `orchestrator-concurrency`) still pass after DB mocks added.

## Risk Assessment

- **Breaking the working orchestrator** — biggest risk. Mitigations:
  - All new code wrapped in try/catch.
  - Keep `loadAccounts` JSON path callable for emergency rollback.
  - Smoke test on one account before pointing all at DB.
- **DB write fails mid-sequence** — lease is alive on Akash but DB inconsistent. Acceptable: operator inspects via API, fixes via PUT /v1/groups. Document this scenario.
- **Concurrent lease race** — `FOR UPDATE` covers DB; Akash side independent. Test under load.
- **SDL template load failure at boot** — daemon must exit (`notifySdlFail` already exists). Reuse.
- **No available group at lease time** — operator gets Telegram alert; lease keeps running with placeholder image (will likely crash). They can manually free a group via API or accept the lost deposit.

## Notes

- Don't introduce a transaction across DB + Akash PUT — Akash isn't transactional. Order: insert row → lock group → PUT → update status. Each step independent with idempotent retries possible if needed (out of scope).
- `put_attempts` field exists but only incremented once here (no retry loop). Phase 5 sweeper could later flip to retry if desired.
- **"No available group" alert is one-shot** — sweeper nag only triggers for groups whose `status=PUT_FAILED`. The no-group case has no group row to flip, so only the initial Telegram fires. Operator must check `GET /v1/deployments?status=PUT_FAILED` to find these. If this becomes a frequent gap, consider a `system_alerts` table later (out of scope).
