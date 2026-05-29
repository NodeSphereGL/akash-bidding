# Plan — revert QA bypass + atomic post-lease + disable auto-topup

Created: 2026-05-29
Trigger: QA E2E found B1 (dseq UNIQUE too narrow) + B2 (orphan group lock on insert failure) + missing cost guard (auto-topup remains ON post-lease).

## Phases

| Phase | File | Status |
|---|---|---|
| 1 | phase-01-revert.md | pending |
| 2 | phase-02-dseq-atomic.md | pending |
| 3 | phase-03-autotopup-orphan.md | pending |

## Key dependencies

- Phase 1 unblocks correct test baseline for 2/3.
- Phase 2's tx refactor changes the post-lease control flow; Phase 3 hooks into the new control flow, so Phase 2 must land first.
- Migrations are forward-only via `scripts/db-migrate.js`; rollback is a reverse `ALTER`.

## Decisions locked

- `scripts/close-test-leases.js` → `scripts/ops/close-test-leases.js`
- Clean up untracked: `akash-deploy.ssh.yaml.bak`, `rpow2-deploy.yaml`, `scripts/diagnose-account.js`
- Auto-topup disable is **always on** (no env flag)
- `lease.orphan` Telegram notify added when chain lease succeeds but post-lease tx fails
