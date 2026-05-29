# Phase 3 — Disable auto-topup after PUT (always on) + sweeper retry

Priority: P1  •  Risk: low-medium  •  Reversible: feature is additive

## Context

Akash console-api keeps auto-topup ON by default — when a deployment's escrow drains, console auto-refills it from the managed wallet, accruing cost. For the trial-credit bidder, we want a one-way trip: lease → run → drain → auto-evict. **Always disable auto-topup right after the SDL PUT.**

Spec from user (https://akash.network/docs/api-documentation/console-api/api-reference/):
```
PATCH /v2/deployment-settings/{dseq}
data.autoTopUpEnabled = false
```

Body shape mirrors existing console-api convention (`{data:{...}}`); verify against live API in step 3e before merging.

## Files

### New
- `scripts/ops/test-auto-topup.js` — one-shot smoke test against one account
- `src/db/migrations/004_auto_topup.sql`
- `tests/akash-disable-autotopup.test.js`

### Modified
- `src/akash.js` — add `disableAutoTopUp(ctx, dseq)`
- `src/index.js` — call after `updateDeployment` success, before `PUT_OK` mark
- `src/sweeper.js` — retry tick for `status='PUT_OK' AND auto_topup_disabled=0`
- `src/db/repo/deployments.js` — `markAutoTopUpDisabled(dseq, accountId)` + `listPendingAutoTopUp()`
- `src/notify.js` — optional channel for repeated PATCH failures (only after sweeper N retries)

## Migration `004_auto_topup.sql`

```sql
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'deployments'
    AND column_name = 'auto_topup_disabled'
);
SET @sql := IF(@has_col = 0,
  'ALTER TABLE deployments ADD COLUMN auto_topup_disabled BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
```

## Client method

```js
// src/akash.js
export async function disableAutoTopUp(ctx, dseq) {
  const body = await request(
    ctx, "PATCH",
    `/v2/deployment-settings/${encodeURIComponent(dseq)}`,
    { data: { autoTopUpEnabled: false } },
  );
  return unwrap(body);
}
```

## Call site in `src/index.js`

Inside the PUT_OK branch (Phase 2's restructured block):

```js
await akash.updateDeployment(ctx, dseq, newSdl);

try {
  await akash.disableAutoTopUp(ctx, dseq);
  await deploymentsRepoDep.markAutoTopUpDisabled(dseq, account.id);
  cycleLog.info("deployment.auto_topup.disabled", { dseq });
} catch (err) {
  // Non-fatal: lease+group are good; sweeper will retry.
  cycleLog.warn("deployment.auto_topup.disable.failed", { dseq, error: err.message });
}

await deploymentsRepoDep.updateStatus(dseq, account.id, "PUT_OK", { group_name: group.name, put_attempts: 1 });
```

## Sweeper retry

In `src/sweeper.js`, add a tick:

```js
async function retryAutoTopUp(deps) {
  const rows = await deps.deploymentsRepo.listPendingAutoTopUp(); // status=PUT_OK AND auto_topup_disabled=FALSE LIMIT 20
  for (const row of rows) {
    const account = deps.accountsByName.get(row.accountName);
    if (!account) continue;
    try {
      await akash.disableAutoTopUp({ account, config: deps.config }, row.dseq);
      await deps.deploymentsRepo.markAutoTopUpDisabled(row.dseq, row.account_id);
      deps.logger.info("sweeper.auto_topup.retry.ok", { dseq: row.dseq });
    } catch (err) {
      deps.logger.warn("sweeper.auto_topup.retry.failed", { dseq: row.dseq, error: err.message });
    }
  }
}
```

Cap retries via existing sweeper interval (`SWEEP_INTERVAL_MS=300000` → ~288 attempts/day; that's fine).

## Smoke test — `scripts/ops/test-auto-topup.js`

One-shot: pick `account_id=1` (or first enabled), create a tiny deployment, attempt PATCH, log response, close. Run **once** before merging Phase 3 to verify the body shape.

```js
// Expected outcomes:
//  - 200 / 204 with {data:{...autoTopUpEnabled:false}} → body shape confirmed
//  - 400 "invalid field" → swap to flat {autoTopUpEnabled:false}
//  - 404 → endpoint path wrong (need /v1/ instead of /v2/?)
```

## Tests

- `tests/akash-disable-autotopup.test.js`:
  - mock fetch → assert method=PATCH, url ends with `/v2/deployment-settings/${dseq}`, headers include x-api-key, body matches `{data:{autoTopUpEnabled:false}}`.
- Sweeper unit test: `listPendingAutoTopUp` returns rows → each gets PATCH attempt; mark only successful.
- Integration: simulate PATCH 500 → row stays `auto_topup_disabled=0`; next sweeper tick retries.

## Success criteria

- Live cycle: lease → PUT → `deployment.auto_topup.disabled` log within 1s.
- DB column `auto_topup_disabled=1` for that row.
- Console UI shows auto-topup is OFF for that dseq.
- On PATCH 5xx: row remains `=0`, sweeper retries, eventually succeeds. No infinite alert spam (notify only after N consecutive failures, e.g. 12 ticks = 1h).

## Rollback

- Remove `disableAutoTopUp` call from `src/index.js`.
- Migration: `ALTER TABLE deployments DROP COLUMN auto_topup_disabled;`
- Existing deployments unaffected; auto-topup just stays ON.

## Risks

- API path/body shape unverified — smoke test before merge.
- PATCH timing: if escrow is already being drawn, disabling mid-flight may behave differently than expected. Disable should happen within seconds of PUT, before any meaningful drain.
- If managed-wallet account is later disabled, auto-topup PATCH may return 401 — sweeper logs but doesn't loop forever (capped retries).

## Open questions

- After N sweeper failures, do we mark the deployment in a terminal `AUTO_TOPUP_FAILED` status? Recommend yes after 24h (288 ticks @ 5min) — operator visibility.
