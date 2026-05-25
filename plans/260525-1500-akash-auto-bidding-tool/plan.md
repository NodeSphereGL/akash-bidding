---
title: "Akash GPU Auto-Bidding Tool"
description: "Long-running Node.js daemon that auto-creates Akash deployments, polls bids, leases first matching GPU (uact/block price ≤ MAX_UACT_PER_BLOCK, blacklist excluded), and notifies Telegram. Multi-account rotation with per-account HTTP proxy. Exits when all accounts have balance < $5."
status: in-progress
priority: P2
branch: "main"
tags: [akash, gpu, bidding, automation, nodejs]
blockedBy: []
blocks: []
created: "2026-05-25T08:00:00.000Z"
createdBy: "ck:plan"
source: skill
---

# Akash GPU Auto-Bidding Tool

## Overview

Build long-running daemon that auto-bids on Akash GPU deployments via the Akash Console managed-wallet REST API. Mirrors the cosmos-rescue project structure (Node.js ESM, native fetch, dotenv, modular). Filters bids by GPU model blacklist and USD/hour price ceiling, selects greedy-first, walks fallback list on lease failures, sleeps 1h after each lease success, rotates across multi-account `{apiKey, proxy}` pairs every cycle, and exits when no account can fund the next deployment.

Brainstorm summary: [./brainstorm-summary.md](./brainstorm-summary.md)

## Goals

- Run unattended for days against the Akash Console API.
- Land leases at ≤ `MAX_UACT_PER_BLOCK` uact/block, picking the highest-priced bid within that cap.
- Skip GPU models the free trial cannot lease (`a100`, `pro6000se`, `h100`).
- Spread requests across N accounts with per-account proxy IP isolation.
- Notify Telegram on lease success and on fatal events.

## Non-Goals (v1)

- Tracking / closing leased deployments after the 1h hold.
- Concurrent bidding cycles (sequential only).
- Persistent state across daemon restarts.
- SDL mutation.
- Telegram command interface.

## Hard requirements

| # | Requirement |
|---|---|
| R1 | Read fixed SDL `akash-deploy.yaml`, send raw to `POST /v1/deployments` with `deposit=$5` |
| R2 | Poll `GET /v1/bids?dseq=` every 10s, max 120s |
| R3 | Greedy-first: pick first matching candidate as soon as it appears |
| R4 | Filter: drop GPU blacklist (substring case-insensitive) + drop bids > `MAX_UACT_PER_BLOCK`; sort DESC by uact/block price; lease top, fallback down |
| R5 | On lease success: Telegram notify, sleep 1h, then start next cycle (lease stays running on Akash) |
| R6 | On no-match or all-bids-failed: close deployment, sleep `rand(60..180)s`, continue |
| R7 | Account ring: round-robin `{apiKey, proxy}` pairs per cycle |
| R8 | Per-cycle balance check; skip account if balance < $5; exit daemon when ALL accounts < $5 |
| R9 | Telegram on: lease success, all-accounts-depleted, per-account 401, SDL load failure, uncaught crash |
| R10 | File log `./logs/akash-bidding.log` + stdout, no DB |

## Tech stack

- Node.js 20+ ESM (`"type": "module"`)
- Native `fetch` via `undici` (bundled) + `undici.ProxyAgent` for HTTP proxy
- `dotenv` for env config
- `yaml` (npm) for SDL parsing — only needed if we hand SDL as parsed object; if API accepts raw string we skip
- No framework, no DB

## Module layout

```
src/
  config.js     env + accounts.json loader, constants
  akash.js      API client (per-call {apiKey, proxy} injection)
  bidder.js     filterAndRank — DESC-sorted candidate list
  notify.js     sendTelegram + 5 typed notifiers
  logger.js     file + stdout, account name on every line
  rotator.js    round-robin ring + exhausted-set
  index.js      orchestrator loop
accounts.json   gitignored — [{name, apiKey, proxy}]
akash-deploy.yaml  fixed SDL
.env.example
logs/           gitignored
```

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Scaffold and API probe](./phase-01-scaffold-and-api-probe.md) | Code complete (probe needs live run) |
| 2 | [Akash API client](./phase-02-akash-api-client.md) | Complete |
| 3 | [Bid filtering and ranking](./phase-03-bid-filtering-and-ranking.md) | Complete |
| 4 | [Account rotator and balance gating](./phase-04-account-rotator-and-balance-gating.md) | Complete |
| 5 | [Orchestrator loop and greedy bid poll](./phase-05-orchestrator-loop-and-greedy-bid-poll.md) | Complete |
| 6 | [Telegram notifiers](./phase-06-telegram-notifiers.md) | Complete |
| 7 | [Logger and ops setup](./phase-07-logger-and-ops-setup.md) | Complete |
| 8 | [End-to-end live verification](./phase-08-end-to-end-live-verification.md) | Pending (live run required) |

## Dependencies

None — greenfield project. No cross-plan blockers.

## Risks (high-level)

1. **GPU model JSON path in bid response** assumed but not documented. Phase 1 probes a real bid.
2. **Balance endpoint** existence unverified. Phase 1 probes; fallback is insufficient-credit error detection at create time.
3. **Parallel leases burn deposit** — up to ~5/account in steady state. Confirm trial credits cover.
4. **Bad proxy stalls cycle** — mitigated by 30s per-request timeout + retry-without-proxy on connection failure.
5. **`MAX_UACT_PER_BLOCK` calibration** — operator must check real bid prices on Akash Console once to pick a sensible cap; daemon does not normalize to USD.

## Validation Log

### Session 1 — 2026-05-25

| Topic | Decision | Affects |
|---|---|---|
| SDL location | `akash-deploy.yaml` placed at project root by operator. Verified present. | All phases |
| GPU blacklist match | Substring, case-insensitive against bid model string. | Phase 3 |
| Filter ceiling unit | **Drop USD conversion.** Use `MAX_UACT_PER_BLOCK` env var directly. Drop `UACT_USD_RATE` and `MAX_USD_PER_HOUR` from config. Operator calibrates by checking real bid prices on Akash Console. | Phases 1, 3, 5 + config |
| Proxy-fail behavior | On proxy error (timeout/ECONNREFUSED/etc.), retry the SAME request once with NO proxy. Account stays in rotation. Log warning. No exhaustion threshold. | Phase 2 |

### Session 2 — 2026-05-25 (post-implementation calibration)

| Topic | Decision | Affects |
|---|---|---|
| API base URL | `https://console-api.akash.network` (not `api.cloudmos.io` — DNS reachable but TLS reset). | Config + probe |
| Request envelope | All console-api requests/responses wrap in `{ data: ... }`. POST /v1/deployments body is `{ data: { sdl, deposit } }`. | Phase 2 client |
| Bid response | Items are `{ bid: { id, state, price, resources_offer }, escrow_account }`. `bid.id.{provider,dseq,gseq,oseq}` (not `bid_id`). akash.js unwraps `.bid` so bidder sees the bare object. | Phases 2, 3 |
| Lease body | `{ manifest, leases: [{ dseq, gseq, oseq, provider }] }`. Manifest comes from createDeployment response (NOT SDL). | Phase 5 |
| Balance endpoint | No dedicated endpoint exists on console-api. Daemon uses `GET /v1/deployments?limit=1` as a key+credit health check; falls back to insufficient-credit error at create time per plan risk #2. | Phase 4 |
| Pricing unit | **Reversed Session 1 decision.** 1 uact = $0.000001 (confirmed: `deposit:5` → `5,000,000 uact` in escrow). averageBlockTime = 6.098s (from Akash Console source). USD/hour = price.amount × 590.36 / 1e6. | Phase 3 + config |
| Cap config | Added `MAX_USD_PER_HOUR` (preferred). Daemon converts to uact/block internally. `MAX_UACT_PER_BLOCK` kept as override. Default cap = $1.00/hr → 1694 uact/block. | Config |
| Bid listing endpoint | console-api `/v1/bids?dseq=` returns `[]` even when chain has live bids — verified empirically with dseq 26969839 (chain had 4 bids, console-api returned 0). Switched bid polling to chain REST `GET /rest/akash/market/v1beta5/bids/list?filters.owner=...&filters.dseq=...`. This is the same endpoint the Console UI uses. Added `AKASH_RPC_BASE=https://rpc.akt.dev` env. Probe now lands 4 bids in 14s. | Phases 2, 5, probe |
| Owner address resolution | Chain REST requires `filters.owner` (cosmos address). Console-api create response has no owner field. Daemon lazy-caches owner per account via `GET /v1/deployments?limit=1`, falls back to `/v1/deployments/{dseq}` after first create. | Phases 2, 5 |

### Verification Results
- Claims checked: 3
- Verified: 2 (`cosmos-rescue/src/notify.js` exists, Node v24.9.0 ≥ 20)
- Failed: 1 → resolved (`akash-deploy.yaml` was missing; operator added during validation)
- Unverified: 0
- Tier: Full (8 phases)

### Whole-Plan Consistency Sweep
- Removed all `UACT_USD_RATE` / `MAX_USD_PER_HOUR` / uact→USD references from phase files.
- Replaced with `MAX_UACT_PER_BLOCK` end-to-end.
- Phase 3 filter pipeline simplified (no conversion step).
- Phase 2 `request()` updated with retry-without-proxy fallback.
- No remaining contradictions.

## Success criteria (overall)

- Daemon runs ≥ 24h without uncaught crash.
- ≥ 1 successful lease per healthy account per hour on average when bids match the filter.
- Telegram messages arrive within 10s of event.
- Proxy verification: outbound IP per account matches configured proxy.
- Clean shutdown with "all depleted" Telegram message when accounts drained.
