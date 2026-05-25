# akash-bidding

Long-running Node.js daemon that auto-creates Akash GPU deployments, polls bids, leases the first matching offer (uact/block ≤ `MAX_UACT_PER_BLOCK`, GPU model not in blacklist), and notifies Telegram on success and fatal events. Multi-account rotation with per-account HTTP proxy. Exits when every account has balance < $5.

## What it does (per cycle)

1. Round-robin pick the next `{apiKey, proxy}` account.
2. Check balance — skip account if < `MIN_BALANCE_USD`; exit daemon if every account is < `MIN_BALANCE_USD`.
3. `POST /v1/deployments` (console-api) with raw `akash-deploy.yaml` and `deposit=$5`.
4. Poll chain REST `GET /rest/akash/market/v1beta5/bids/list?filters.owner=...&filters.dseq=...` every 10s for up to 120s — same endpoint the Console UI uses. (Console-api's `/v1/bids` returns `[]` in practice.) The first time at least one bid passes the filter, that bid (and all worse-priced fallbacks) is selected immediately.
5. Filter: drop bids whose GPU model contains any `GPU_BLACKLIST` entry (substring, case-insensitive) or whose `price.amount > MAX_UACT_PER_BLOCK`; sort DESC.
6. Lease the top candidate; on failure walk the fallback list top-down.
7. On lease success → Telegram, sleep 1h (lease keeps running on Akash; auto-evicts when deposit drains).
8. On no-match or all-leases-failed → close deployment, sleep `rand(60..180)s`, next cycle.

## Requirements

- Node.js 20 or later
- An Akash Console managed-wallet account (API key)
- Optional HTTP proxy URL per account
- Optional Telegram bot + chat ID for notifications

## Setup

```bash
git clone <this repo>
cd akash-bidding
npm install

cp .env.example .env             # fill in MAX_UACT_PER_BLOCK, telegram, etc.
cp accounts.example.json accounts.json   # populate name + apiKey + proxy per account
```

Place your SDL at `./akash-deploy.yaml` (a working example is included).

## Calibrate the price cap

Set `MAX_USD_PER_HOUR` in `.env` — that's the unit the Akash Console UI shows. The daemon converts to the uact/block cap internally using:

- `1 uact = $0.000001` (anchored to `deposit:5` USD → 5,000,000 uact in escrow)
- `averageBlockTime = 6.098s` (from Akash Console source)
- `USD/hour = price.amount × 3600 / 6.098 / 1,000,000`
- `uact/block = USD/hour × 1693.74`

Examples (real bids observed on Console):

| GPU | UI price | uact/block |
| --- | --- | --- |
| nvidia-a100 | $1.23/hr | ~2,083 |
| nvidia-pro6000se | $1.86/hr | ~3,150 |
| nvidia-h100 | $2.52/hr | ~4,268 |

For raw chain-unit control, set `MAX_UACT_PER_BLOCK` directly (overrides `MAX_USD_PER_HOUR` when both are set; leave one blank).

Run `npm run probe` to confirm reachability + see a fresh bid screen before launching the daemon.

## Run

```bash
# pre-flight: confirm proxy isolation
npm run check-proxy

# foreground
npm start

# tests
npm test
```

See `docs/run-and-ops.md` for PM2, systemd, and logrotate templates.

## Telegram

Notifications fire on:

| Event | Why |
| --- | --- |
| Lease acquired | Cycle landed a lease — daemon now sleeps 1h |
| All accounts depleted | Daemon is exiting; top up balances and restart |
| Account 401 | API key invalid for that account; rotator skips it |
| SDL load failed | Daemon exits before the loop |
| Uncaught crash | Daemon exits 1 — supervisor should restart |

Leave `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` blank in `.env` to disable Telegram silently.

## Logs

JSONL, appended to `./logs/akash-bidding.log` and printed to stdout. Every cycle-scoped line includes the `account` name.

```bash
tail -f logs/akash-bidding.log | jq 'select(.event=="lease.success")'
```

## Known limitations (v1)

- No persistence — exhausted-set and round-robin cursor reset on restart.
- Does not track / close leases after the 1h hold (Akash handles eviction when the deposit drains).
- No concurrent bidding cycles.
- No SDL mutation; one fixed deployment shape per daemon.
- Substring blacklist can over-match (e.g. `a10` matches `a100`); pick blacklist entries carefully.

## Layout

```
src/
  config.js              env loader, validates required keys
  akash.js               REST client (per-call apiKey+proxy injection)
  bidder.js              pure filter + DESC-rank by uact/block
  rotator.js             round-robin ring + exhausted-set
  accounts-loader.js     accounts.json validator
  notify.js              Telegram bot client + 5 typed notifiers
  logger.js              JSONL file + stdout
  index.js               orchestrator (main loop)
scripts/
  probe.js               one-shot live API probe
  check-proxy-ip.js      outbound IP per account
tests/
  bidder.test.js
  rotator.test.js
  logger.test.js
  fixtures/bids-sample.json
docs/run-and-ops.md
plans/                   design + phase docs
```
