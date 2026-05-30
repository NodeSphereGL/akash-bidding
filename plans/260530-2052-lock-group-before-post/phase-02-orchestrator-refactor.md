# Phase 2: orchestrator — lock-before-POST flow

## Context

Refactor `runAccountLoop` in `src/index.js` to lock a group BEFORE creating the Akash deployment, bake the real `GROUP_NAME` into the SDL at POST time, eliminate the PUT step, and insert the deployments row with `status='PUT_OK'` directly post-lease.

Depends on Phase 1 (`lockNextAvailablePending` + `bindLockToDseq` repo methods).

## Files

- Modify: `src/index.js` — `runAccountLoop` body
- Modify: `src/sdl.js` — verify `injectGroupName` works correctly when called for POST (already pure; should be no change)
- Modify: `src/post-lease.js` — simplify or delete (no longer needs to be atomic)
- Modify: `src/config.js` — add `GROUP_LOCK_PENDING_MINUTES` (default 10)

## New cycle (replaces current `runAccountLoop` body)

```
loop while !aborted:
  cycle.start
  health check (existing — unchanged)

  # ── Pre-flight gate ──
  group = await groupsRepo.lockNextAvailablePending(account.id, workspace, PENDING_MINUTES)
  if !group:
    log "no_group.skip_cycle"
    sleep(RETRY_MIN_MS..RETRY_MAX_MS)
    continue

  # ── POST with real GROUP_NAME baked in ──
  try:
    sdl = sdlMod.injectGroupName(sdlTemplate, group.name)
    created = await akash.createDeployment(ctx, sdl, DEPOSIT_USD)
    dseq = created.dseq
    manifest = created.manifest
  except err:
    await groupsRepo.release(group.name)   # release immediately, group is reusable
    handle 401/insufficient/transient as today
    continue

  # ── Promote pending lock to full TTL with dseq ──
  await groupsRepo.bindLockToDseq(group.name, dseq, GROUP_LOCK_HOURS)

  # ── Owner + bid poll + lease (existing logic) ──
  owner = await akash.getOwnerAddress(...)
  result = await pollAndLease(...)

  if !result.leased:
    await akash.closeDeployment(ctx, dseq).catch(...)
    await groupsRepo.release(group.name)
    noMatchStreak++
    handle exhaustion (existing)
    continue

  # ── Lease success: insert deployments row directly as PUT_OK ──
  try:
    await deploymentsRepo.insert({
      dseq,
      accountId: account.id,
      groupName: group.name,
      provider: result.bid.provider,
      uactPerBlock: result.bid.uactPerBlock,
      status: 'PUT_OK',     # SDL already has real GROUP_NAME from POST
      leasedAt: now,
      expiresAt: now + GROUP_LOCK_HOURS,
    })
  except err:
    # Orphan: lease succeeded on-chain, DB insert failed.
    containment = containLeasedDeployment(...)
    await groupsRepo.release(group.name).catch(...)
    await notify.notifyLeaseOrphan(...)
    continue

  # ── Disable auto-topup (non-fatal, sweeper retries) ──
  try { await akash.disableAutoTopUp(ctx, dseq); deploymentsRepo.markAutoTopUpDisabled(...) }
  catch { log; sweeper picks up }

  # ── Notify + 1h hold ──
  await notify.notifyLeaseSuccess({ ..., putStatus: 'PUT_OK' })
  await sleep(LEASE_HOLD_MS)
```

## Failure-mode matrix

| Failure point | Group state after handler | Deployment state after handler |
| --- | --- | --- |
| `lockNextAvailablePending` returns null | n/a | n/a — cycle skipped |
| POST throws (401, network, insufficient credit) | RELEASED | n/a — no dseq |
| `bindLockToDseq` throws (should not happen — caller bug) | LOCKED pending TTL → sweeper expires | dseq exists on Akash; auto-evicts on escrow drain |
| `getOwnerAddress` throws | LOCKED pending TTL | dseq closed by best-effort `closeDeployment` |
| `pollAndLease` returns `leased: false` | RELEASED | dseq closed |
| `createLease` succeeds, `deploymentsRepo.insert` throws | RELEASED + containment log | on-chain lease — containment closes if possible, else `notifyLeaseOrphan` |
| `disableAutoTopUp` throws | LOCKED (full TTL) | inserted PUT_OK — sweeper retries PATCH |

## Config additions

In `src/config.js`:

```
GROUP_LOCK_PENDING_MINUTES: int, default 10, min 2, max 60
```

Document in `.env.example`.

## Removed code paths

- The `1+2. Atomic: insert deployments row AND lock next group` block (`src/index.js:260-301`)
- The `3. inject GROUP_NAME and PUT new SDL` block (`src/index.js:303-344`) — PUT branch entirely
- The `putStatus='PUT_FAILED'` / `notifyPutFailed` from-orchestrator paths (sweeper's `PUT_FAILED` nag stays for historical rows; that's phase 3)

## Done when

- `runAccountLoop` matches the flow above
- `npm test` passes (some tests updated in phase 3)
- Live smoke test: one full cycle on a real provider produces exactly one ReplicaSet (verify in provider event log)
- DB row post-lease has `status='PUT_OK'`, `group_name` set, `put_attempts=0`, `auto_topup_disabled=1`

## Risks

| Risk | Mitigation |
| --- | --- |
| `bindLockToDseq` throws unexpectedly → orphan lock + orphan deployment | Wrap in try/catch; on failure, close deployment + release group + log + alert |
| Stale `sdlTemplate` import — current code passes both `sdl` (raw string with placeholder) and `sdlTemplate` (parsed object) | Stop passing `sdl` to `runAccountLoop`; only `sdlTemplate` is needed since injection happens per-cycle |
| Test `post-lease-atomic.test.js` becomes meaningless | Delete in phase 3 |

## Next

Phase 3 cleans up dead code, deletes obsolete tests, updates docs.
