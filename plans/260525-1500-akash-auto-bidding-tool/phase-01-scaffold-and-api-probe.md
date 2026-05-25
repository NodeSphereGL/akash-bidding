---
phase: 1
title: "Scaffold and API probe"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Scaffold and API probe

<!-- Updated: Validation Session 1 — uact→USD probe removed; ceiling is MAX_UACT_PER_BLOCK -->

## Overview

Bootstrap the Node.js ESM project and run live probes against the Akash Console API to resolve the two open schema questions before any client code is written: (a) GPU model field path in bid response, (b) balance endpoint existence and shape. Operator also uses bid output to calibrate `MAX_UACT_PER_BLOCK`.

## Requirements

- Functional: package.json + folder skeleton + 1 throwaway probe script.
- Non-functional: probe script must not commit secrets, must support a single test account via env.

## Architecture

Probe script lives in `scripts/probe.js` (gitignored output to `scripts/probe-output/`). It:

1. Creates a real $5 deployment using `akash-deploy.yaml`.
2. Polls bids for 60s, dumps first bid JSON to file.
3. Calls candidate balance endpoints (`/v1/balance`, `/v1/account`, `/v1/me`) — log which returns 200.
4. Calls `DELETE /v1/deployments/{dseq}` to clean up.
5. Documents findings in `scripts/probe-output/findings.md`.

## Related Code Files

- Create: `package.json`
- Create: `.gitignore` (logs/, accounts.json, .env, scripts/probe-output/)
- Create: `.env.example`
- Create: `scripts/probe.js`
- Create: `scripts/probe-output/.gitkeep`
- Create: `src/` (empty dir, gitkeep)
- Create: `logs/.gitkeep`
- Modify: `README.md` (run instructions + setup steps)

## Implementation Steps

1. `npm init -y`, set `"type": "module"`, add `dependencies: { dotenv: ^16, undici: ^6, yaml: ^2 }`.
2. Add `engines.node: ">=20"`.
3. Add scripts: `"probe": "node scripts/probe.js"`, `"start": "node src/index.js"`.
4. Write `.gitignore` to exclude `node_modules/`, `.env`, `accounts.json`, `logs/`, `scripts/probe-output/`.
5. Write `.env.example` with all variables from brainstorm summary.
6. Write `scripts/probe.js`:
   - Load `AKASH_API_KEY` + optional `AKASH_PROXY` from env.
   - Read `akash-deploy.yaml` as raw string.
   - `POST /v1/deployments` with `{ sdl: <raw>, deposit: 5 }`, log full response.
   - Poll `GET /v1/bids?dseq=...` every 5s for 60s, dump every bid JSON to `scripts/probe-output/bids-<ts>.json`.
   - Try balance endpoints in order: `/v1/balance`, `/v1/account`, `/v1/me`; log status + body.
   - `DELETE /v1/deployments/{dseq}` and confirm 2xx.
   - Write `scripts/probe-output/findings.md` summarizing: GPU field path, balance endpoint URL + JSON path to USD value, sample bid price range observed (to inform MAX_UACT_PER_BLOCK calibration).
7. Run probe manually with one account.
8. Commit findings.md.

## Success Criteria

- [ ] `npm install` completes cleanly.
- [ ] `npm run probe` creates a deployment, collects ≥ 1 bid, fetches balance, and closes the deployment.
- [ ] `findings.md` documents: exact bid JSON path to GPU model, working balance endpoint + path to USD value, observed bid price range (uact/block) to inform MAX_UACT_PER_BLOCK choice.
- [ ] `findings.md` lists actual `state` enum values seen on bids (e.g. `open`, `matched`, `closed`).
- [ ] `akash-deploy.yaml` present at project root (operator-supplied, already verified during validation).
- [ ] No real secrets in `.env.example` or committed files.

## Risk Assessment

- **Probe may fail if API key invalid** → script must surface 401 clearly and exit; reuse this same handling in production client.
- **Bids may not appear within 60s** → extend probe to 180s if first run sees zero bids; document min observed latency.
- **Balance endpoint may not exist** → if all candidates return 404, fall back to insufficient-credit error detection at create time (document and adjust Phase 4 plan).
- **Cleanup may fail** → script must log dseq even on error so user can close manually via Console UI.
