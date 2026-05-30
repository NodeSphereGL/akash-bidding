# Plan: lock group BEFORE POST (eliminate PUT + 2nd ReplicaSet)

## Problem

Current cycle does POST(placeholder SDL) → wait bid → lease → lock group → PUT(real SDL). The PUT mutates `Deployment.spec.template.env` on the provider's K8s cluster, which triggers a rolling update: K8s spins up a 2nd ReplicaSet, schedules a fresh pod, kills the old one. This is wasteful (extra pod schedule round-trip) and noisy in provider event logs. On healthy providers it is harmless; on saturated providers it doubles the FailedScheduling exposure.

## Approach

1. **Lock group BEFORE POST.** Pre-flight gate: if no AVAILABLE group, skip the cycle (no POST, no escrow at risk).
2. **Inject real `GROUP_NAME` into SDL at POST time** (not via PUT). Single ReplicaSet, single rollout.
3. **Operational mitigation for group supply**: seed `N_groups ≥ N_accounts × concurrency_factor` to avoid contention.

## Phases

| # | File | Status |
| --- | --- | --- |
| 1 | [phase-01-db-repo-changes.md](phase-01-db-repo-changes.md) | TODO |
| 2 | [phase-02-orchestrator-refactor.md](phase-02-orchestrator-refactor.md) | TODO |
| 3 | [phase-03-cleanup-tests-docs.md](phase-03-cleanup-tests-docs.md) | TODO |

## Key trade-offs

- ✅ Eliminates 2-RS rolling restart
- ✅ Smaller crash exposure (10min orphan vs 24h)
- ✅ No POST if no group available — no wasted API calls / escrow
- ⚠️ Group locked during bid wait (~2-5min) instead of only after lease — mitigated by seeding more groups
- ❌ Does NOT fix bad-provider `FailedScheduling` (separate session)

## Out of scope

- Post-lease pod-health probe / `notifyDeadProvider` Telegram alert (separate plan)
- Removing `PUT_FAILED` enum value from migration (handled in a future cleanup migration)
- Changing `groups.expires_at` semantics (sweeper continues to use it as-is)

## Dependencies

None. Code-only refactor, no schema changes, no image rebuild, no API contract changes for ops scripts.

## Success criteria

- New leases produce exactly **one** ReplicaSet on the provider (verifiable via provider event log)
- `deployments.put_attempts` always = 0 for new rows
- Tests pass; orchestrator-invariants still hold
- Sweeper correctly expires pending-locked groups whose POST/bid failed silently
- No regression in `sync-live` reconciliation

## Risks

| Risk | Mitigation |
| --- | --- |
| Daemon crashes between lock and POST → group orphaned | Short TTL (10min) on pending lock; sweeper auto-releases |
| Pending TTL too short → live cycle's lock expires mid-bid | Configurable; default 10min covers BID_WAIT_MS (120s default) + lease attempts with margin |
| Group supply < demand → cycles spin idle | Operator runs `npm run db:seed-groups` to add capacity |
| Existing `PUT_OK` / `PUT_FAILED` historical rows confuse ops scripts | Sweeper + sync-live continue to handle them; new rows just skip those states |
| `postLeaseAtomic` test deletion breaks CI | Replace with simpler insert + bind-lock test in phase 3 |
