# Brainstorm Summary — Akash GPU Auto-Bidding Tool

**Date:** 2026-05-25
**Status:** Design approved, ready for `/ck:plan`
**Project root:** `/Users/ductoanbk/Working/Project/BLOCKCHAIN/NODESPHERE/akash-bidding`

---

## Problem statement

Build long-running daemon that auto-bids on Akash GPU deployments using the Akash Console managed-wallet API. Multi-account rotation with optional per-account HTTP proxies. Notify Telegram on lease success and fatal events. No DB — file logs only.

## Hard requirements (locked)

| # | Requirement |
|---|---|
| R1 | Auto-create deployments using fixed SDL `akash-deploy.yaml` (unchanged) |
| R2 | Poll bids, filter by GPU model + uact/block cap, greedy-first selection |
| R3 | Wait up to 120s for matching bid; if none → close deployment, sleep `rand(60..180)s`, retry |
| R4 | On lease success → Telegram notify, sleep 1h, then start next cycle (lease keeps running on Akash, auto-evicted when deposit drained) |
| R5 | If lease API fails → try next bid in sorted candidate list (no retry on same bid) |
| R6 | Multi-account: 1:1 paired `{apiKey, proxy}`, round-robin every cycle |
| R7 | Per-cycle balance check; account skipped if balance < $5; daemon exits when ALL accounts < $5 |
| R8 | Telegram fires on: lease-success, all-accounts-depleted, auth-fail per account, SDL-load-fail, uncaught crash |
| R9 | File logs only (`./logs/akash-bidding.log`), no DB |
| R10 | Stack: Node.js ESM + native fetch + undici ProxyAgent + dotenv |

## Filter & selection rules

> Validation Session 1 (2026-05-25) replaced USD/hour ceiling with chain-denom cap; see `## Validation Log` in `plan.md`.

- **GPU model blacklist:** `a100`, `pro6000se`, `h100` (free trial cannot lease). Match mode: substring, case-insensitive.
- **Price cap:** ≤ `MAX_UACT_PER_BLOCK` (env var, set by operator after inspecting real bid prices on Akash Console). No USD conversion in code.
- **Selection:** sort remaining candidates DESC by uact/block → pick top (greedy).
- **Lease failure fallback:** walk DESC list top-down; on every failure, try next.

## Architecture

Single-process sequential daemon. Bid cycle = `create → poll → lease|close → sleep`. Daemon does NOT track leased deployments after success (Akash handles eviction).

```
loop forever:
   account = rotator.next()
   if all accounts exhausted: telegram fatal + exit(0)

   bal = akash.getBalance(account)
   if bal < $5:
      mark account exhausted
      continue

   dseq = akash.createDeployment(account, sdl, deposit=$5)

   candidate = pollBidsGreedy(account, dseq, maxWaitMs=120_000)
     # returns first bid matching filter as soon as it appears
     # OR null after 120s

   if candidate is null:
      akash.closeDeployment(account, dseq)
      sleep( rand(60..180) seconds )
      continue

   # try greedy candidate + fallback list
   leased = null
   for bid in [candidate, ...remainingCandidates]:
      try:
         leased = akash.createLease(account, bid)
         break
      except: log + continue

   if leased:
      telegram.notifyLeaseSuccess(leased, bid, account)
      sleep(3600)   # 1h hold
   else:
      akash.closeDeployment(account, dseq)
      sleep( rand(60..180) seconds )
```

## Module layout

```
src/
  config.js     env + accounts.json loader, constants
  akash.js      API client (per-call {apiKey, proxy} injection)
  bidder.js     filterAndRank — returns DESC-sorted candidate list
  notify.js     sendTelegram + 5 typed notifiers
  logger.js     file + stdout, account name in every line
  rotator.js    round-robin ring + exhausted-set
  index.js      orchestrator loop
accounts.json   (gitignored)
akash-deploy.yaml
.env.example
logs/           (gitignored)
```

## Proxy implementation

- `undici.ProxyAgent` (bundled with Node 18+).
- One agent per unique proxy URL, memoized.
- `null` proxy → direct fetch.
- Per-request timeout 30s — dead proxy fails fast, rotator moves on.

```js
import { fetch, ProxyAgent } from "undici";
const agents = new Map();
function dispatcher(proxy) {
  if (!proxy) return undefined;
  if (!agents.has(proxy)) agents.set(proxy, new ProxyAgent(proxy));
  return agents.get(proxy);
}
```

## Account file format

`accounts.json` (gitignored):

```json
[
  { "name": "trial-1", "apiKey": "ak_...", "proxy": "http://u:p@1.2.3.4:8080" },
  { "name": "trial-2", "apiKey": "ak_...", "proxy": null }
]
```

## Telegram notifications

| Event | Fires |
|---|---|
| Lease success | yes — GPU model, uact/block price, provider, dseq, leaseId, account name |
| All accounts < $5 balance | yes — daemon exiting |
| 401 on an account | yes — account marked exhausted, daemon continues if others healthy |
| SDL load failure on startup | yes — daemon exits before loop |
| Uncaught exception | yes — exit(1) |
| Cycle close (no match) | no — file log only |
| Lease attempt failure | no — file log only |

## `.env.example`

```
SDL_PATH=./akash-deploy.yaml
ACCOUNTS_PATH=./accounts.json
AKASH_API_BASE=https://console-api.akash.network
DEPOSIT_USD=5
MIN_BALANCE_USD=5
MAX_UACT_PER_BLOCK=100000             # operator calibrates from real bids
GPU_BLACKLIST=a100,pro6000se,h100     # substring match, case-insensitive
BID_WAIT_MS=120000
BID_POLL_INTERVAL_MS=10000
LEASE_HOLD_MS=3600000
RETRY_MIN_MS=60000
RETRY_MAX_MS=180000
REQUEST_TIMEOUT_MS=30000
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
LOG_FILE=./logs/akash-bidding.log
```

## Evaluated approaches

| Approach | Verdict | Why |
|---|---|---|
| A. Single-process sequential daemon (CHOSEN) | ✅ | Matches user flow exactly; no concurrency complexity; Akash handles post-lease lifecycle |
| B. Concurrent cycles + lease-watcher | ❌ | Over-engineered; no need to monitor leases (Akash auto-evicts) |
| C. Two processes (bidder + watcher) via PM2 | ❌ | Same overkill; adds process supervision dependency |
| D. Python/Go | ❌ | Loses cosmos-rescue Telegram code reuse; no benefit for I/O-bound tool |

## Risks

1. ~~**`uact → USD` rate**~~ — superseded by Validation Session 1: filter uses `MAX_UACT_PER_BLOCK` directly, no conversion needed. Operator calibrates by inspecting real bid prices once.
2. **GPU model JSON path in bid** — assumed `bid.resources_offer[].resources.gpu.attributes[].key`. Phase 1 must dump first real bid to lock path.
3. **Balance endpoint existence** — verify in Phase 1. Fallback: detect insufficient-credit error at create time.
4. **Free-trial provider rejections beyond blacklist** — try-next-bid handles; add warn log if cycle exhausts all candidates.
5. **Parallel running leases burn deposit** — up to ~5/account at steady state (1h hold × 5h deposit lifetime). With N accounts → 5N concurrent. Confirm trial credit covers.
6. **Bad proxy stalls cycle** — mitigated by 30s request timeout. Mark account exhausted after consecutive proxy failures (threshold configurable, Phase 2 if needed).
7. **No state persistence across restarts** — daemon restart loses exhausted-set + round-robin pointer. Acceptable for v1; document in README.

## Success metrics

- Lease success rate per cycle ≥ 30% on healthy accounts.
- Mean time to first lease in a cycle < 90s when bids match.
- Zero uncaught crashes over 24h continuous run.
- Telegram notifications reach within 10s of event.
- Proxy rotation verified: each account's outbound IP matches configured proxy.

## Out of scope (v1)

- Tracking / closing leased deployments after 1h hold.
- Concurrent bidding cycles.
- Persistent state / DB.
- Recovery of orphaned deployments after daemon crash (manual via Akash Console).
- Provider reputation / whitelist.
- SDL mutation.
- Dynamic price ceiling adjustment.
- Telegram command interface (e.g., pause/resume via bot).

## Implementation phases (suggested)

| Phase | Focus | Output |
|---|---|---|
| 1 | Scaffold + API probe | package.json, config loader, raw bid/balance dump for schema verification |
| 2 | Akash API client | akash.js with createDeployment, getBids, createLease, closeDeployment, getBalance, proxy dispatcher |
| 3 | Bid filtering + ranking | bidder.js with GPU substring blacklist, MAX_UACT_PER_BLOCK cap, DESC sort by uact/block |
| 4 | Account rotator + balance gating | rotator.js, exhausted-set, all-depleted exit |
| 5 | Orchestrator loop + greedy poll | index.js full daemon |
| 6 | Telegram notifiers | notify.js lifted from cosmos-rescue + 5 typed messages |
| 7 | Logger + ops | logger.js, .env.example, README run instructions |
| 8 | End-to-end live test on Akash | one full cycle with real account, verify telemetry |

## Unresolved questions

None blocking. Phase 1 must produce empirical answers for:
- exact `GET /v1/bids` JSON schema (GPU model field path)
- balance endpoint URL + response shape
- uact→USD conversion source (endpoint vs hardcoded)
