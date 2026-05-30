# Phase 3: cleanup — dead code, tests, docs

## Context

Phase 2 lands the new flow; phase 3 removes the now-dead PUT branch, deletes obsolete tests, updates docs.

Depends on phase 2.

## Files to delete

- `src/post-lease.js` — atomic insert+lock is no longer needed (group is already locked at lease time; insert is standalone)
- `tests/post-lease-atomic.test.js` — tests deleted module
- `tests/notify-put-failed.test.js` — `notifyPutFailed` from orchestrator path is gone (sweeper nag for legacy `PUT_FAILED` historical rows stays; see "Keep" below)

## Files to modify

### `src/index.js`
- Remove `import { postLeaseAtomic }` and any leftover references
- Remove `import { NoGroupAvailableError }` if unused after phase 2

### `src/db/repo/groups.js`
- Delete `lockNextAvailable` (the old dseq-required version) — no remaining callers after phase 2
- Keep `release`, `expireDue`, `listPutFailedNagDue`, `markNagged` (sweeper still needs these for historical rows)

### `src/notify.js`
- Keep `notifyPutFailed` (callable from ops scripts if ever needed) but mark deprecated in comment
- Keep `notifyPutFailedNag` (sweeper still nags historical `PUT_FAILED` rows)

### `src/akash.js`
- Keep `updateDeployment` (no longer called from orchestrator, but useful for manual SDL refreshes via ops tooling)
- Add comment: `// no longer called by runAccountLoop; retained for ops tooling`

### `akash-deploy.yaml`
- Replace `GROUP_NAME=__PLACEHOLDER__` with a comment explaining `GROUP_NAME` is injected at POST time by the daemon. Keep the env var line so the SDL stays self-documenting; daemon's `injectGroupName` overwrites it.

### `src/config.js`
- (phase 2 already added `GROUP_LOCK_PENDING_MINUTES`) — confirm validation: min 2, max 60, default 10

### `.env.example`
- Add `GROUP_LOCK_PENDING_MINUTES=10` with a one-line comment explaining the short TTL during bid wait

### `README.md`
- Update the "Post-lease automation" section: remove the PUT step, replace with the new "lock-first" wording
- Update the "Layout" tree if `src/post-lease.js` is deleted
- Add one paragraph under a new "Group supply sizing" section explaining `N_groups ≥ N_accounts × concurrency_factor` rule of thumb
- Update the "Known limitations" section: remove "PUT failure burns 24h" entry, add "Pre-flight skips cycle if no available group" entry

### `docs/group-management.md`
- Update lifecycle diagram (lock → POST → bind → lease → insert, vs old lock-after-lease)
- Mention `GROUP_LOCK_PENDING_MINUTES` and the short-TTL behavior
- Document `PUT_FAILED` status as legacy (historical rows only, no new ones produced)

## Files to update (tests)

### `tests/orchestrator-invariants.test.js`
- Existing assertions are about `notify.notifyLeaseSuccess` / `notifyAuthFail` / `notifyAllDepleted` shapes and `filterAndRank` ordering. These should still hold. Skim and confirm.

### `tests/orchestrator-concurrency.test.js`
- Re-verify against new flow. The concurrency invariants (one cycle per account, no shared rotator) are unchanged. Mocks for `groupsRepo` need the two new methods.

### `tests/sdl.test.js`
- `injectGroupName` semantics unchanged; tests should still pass.

### `tests/sweeper.test.js` + `tests/sweeper-auto-topup-retry.test.js`
- Sweeper logic unchanged. Verify still green.

## "Keep" rationale

- **`PUT_FAILED` status enum value**: production DB may have historical rows. Removing it requires a migration that flips them to `EXPIRED` first. Defer to a future cleanup migration.
- **`notifyPutFailedNag` + sweeper nag loop**: same — needed for historical rows.
- **`updateDeployment` Akash client method**: cheap to keep; useful for one-off SDL refreshes from ops scripts.

## Migration / rollout

- No schema migration.
- Restart daemon to pick up new code.
- No backfill needed — historical rows continue to be handled by sweeper.
- Rollback: revert the commits. New rows produced under new code are still valid under old code (status='PUT_OK', group_name set — old sweeper handles them identically).

## Done when

- Files listed above are deleted/updated
- `npm test` green
- `npm run lint` (if defined) green
- README + docs accurately describe the new flow
- Manual smoke test: one cycle on prod (or a staging account) → single ReplicaSet on provider, correct DB row

## Risks

| Risk | Mitigation |
| --- | --- |
| Removing `src/post-lease.js` breaks an unknown caller | `grep -r postLeaseAtomic src/ tests/ scripts/` before deletion |
| README divergence from code | Phase 3 reviewer reads README + diff side-by-side |
| Historical `PUT_FAILED` rows confuse ops scripts | `close-test-leases.js` + `sync-live-deployments.js` already handle them — no change needed |

## Unresolved questions

1. Should `lockNextAvailablePending` log the workspace + count of remaining AVAILABLE groups when it returns null? (Useful operator signal that capacity is tight.) — Suggest yes; small log line in the orchestrator's "no_group.skip_cycle" branch.
2. Should `noGroupStreak` count toward account exhaustion (like `noMatchStreak` today), or stay separate? — Default: do nothing now; let the daemon spin idle on no-group. Revisit if it becomes a problem.
3. Do we want a one-shot ops script `db:seed-groups-bulk N` to add N empty groups in one command? — Out of scope; can use the existing `db:seed-groups` or admin API.
