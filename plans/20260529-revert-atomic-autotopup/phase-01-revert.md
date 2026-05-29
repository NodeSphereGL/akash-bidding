# Phase 1 — Revert QA bypass + housekeeping

Priority: P0  •  Risk: none  •  Reversible: trivial

## Files

- `src/bidder.js` — restore `if (!model) continue` (remove `?? ""` QA-TEMP)
- `akash-deploy.yaml` — `git checkout` to bring GPU block back
- `scripts/close-test-leases.js` → `scripts/ops/close-test-leases.js` (git mv)
- Delete untracked: `akash-deploy.ssh.yaml.bak`, `rpow2-deploy.yaml`, `scripts/diagnose-account.js`
- `tests/bidder.test.js:65` — already correct, will start passing again

## Steps

1. Revert `src/bidder.js` bypass.
2. `git checkout -- akash-deploy.yaml`.
3. `git mv scripts/close-test-leases.js scripts/ops/close-test-leases.js`; update its import paths (`../../src/...`).
4. Delete the 3 untracked stale files.
5. `npm test` → expect 61 pass / 0 fail / 4 skipped.

## Success criteria

- `git status` shows only the intentional Phase 1 changes.
- All unit tests pass.
- `node -e "require('./src/bidder.js')"` and `node -c scripts/ops/close-test-leases.js` parse cleanly.

## Done = check before Phase 2 begins.
