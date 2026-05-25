# Cook implementation report — 2026-05-25

## Status
Code complete for phases 1-7. Phase 8 (live verification) requires real Akash credentials + provider bids; out of scope for this --auto run. The probe script is ready to execute when the operator has an API key.

## Delivered

### Source modules (`src/`)
- `config.js` — env loader, validates `MAX_UACT_PER_BLOCK > 0`, no USD conversion.
- `errors.js` — `AkashApiError` (with body redaction of `x-api-key` / `authorization` / `token` / `cookie` / `password`, body capped at 2KB) + `AllExhaustedError`.
- `akash.js` — stateless REST client, memoized `ProxyAgent` per proxy URL, 30s `AbortController` timeout, proxy-fallback (transport error via proxy → retry once direct; server-side non-2xx never retried). `getBalance` walks 4 endpoint candidates.
- `bidder.js` — pure `filterAndRank` (open-state → blacklist substring drop → cap → DESC sort). `extractGpuModel` tolerates array `{key,value}`, map `{model}`, and key-encoded forms; ignores non-model attributes.
- `rotator.js` — O(n)-bounded `next()`, `markExhausted`, `isAllExhausted`, `healthy`, `status`.
- `accounts-loader.js` — rejects non-array root, missing/empty `apiKey`, `REPLACE_ME` placeholder, duplicate names; normalizes empty proxy to `null`.
- `notify.js` — 5 typed notifiers + `notifyFatal`, HTML-escaped, crash stack truncated to 1500 chars, message capped at 4000 chars, silent no-op when token/chat missing.
- `logger.js` — JSONL file + stdout, `child()` for cycle scope, `drain()` self-triggers (no `beforeExit` race).
- `index.js` — orchestrator with greedy poll + fallback walk; SIGINT/SIGTERM await drain; `uncaughtException` + `unhandledRejection` → `notifyCrash` + exit 1; per-account `noMatchStreak` exhausts after `NO_MATCH_EXHAUST_THRESHOLD` cycles; insufficient-credit detection via error body keyword scan.

### Scripts
- `scripts/probe.js` — one-shot live probe; dumps create / bids / balance / close + writes findings.md.
- `scripts/check-proxy-ip.js` — outbound IP per account through ipify, password-redacted.

### Tests (32 passing)
- `tests/bidder.test.js` (14) — boundary cap inclusive, sort DESC, blacklist substring case-insensitive, all 3 attribute forms, non-model attr rejection, invalid maxUactPerBlock.
- `tests/rotator.test.js` (11) — round-robin, skip exhausted, all-exhausted throws, loader rejections, proxy normalization.
- `tests/logger.test.js` (4) — JSONL validity, child fields, no-file mode, drain flushes.
- `tests/errors.test.js` (3) — redaction, truncation, null body.

### Docs
- `README.md` — full setup + run + Telegram + limitations.
- `docs/run-and-ops.md` — PM2, systemd, logrotate templates.

## Fixes applied during code-reviewer cycle
- **C1+C2 logger drain race** — `drain()` now self-triggers and is idempotent; `shutdown()` awaits it. No more dependency on `beforeExit`.
- **C3 secret-in-error-body leak** — `AkashApiError` deep-redacts sensitive header-shaped keys and caps body to 2KB before storing.
- **H1 wrong notifier on accounts-load failure** — added `notifyFatal(title, error, cfg)`; orchestrator now uses it for accounts load. Plan R9 SDL message remains for SDL failures.
- **M7 GPU model array-fallback over-match** — tightened to require `/model/i` in `attrs.key`. Added negative test.

## Plan conformance (R1-R10)
All addressed; spot-check matrix in code-reviewer report. No requirement deviations.

## Out of scope this session
- Live Akash probe (Phase 1's `findings.md`) — needs operator API key.
- Phase 8 11-scenario verification matrix — needs live providers + Telegram bot.
- Per-account "insufficient-credit" Telegram notification — current behavior is silent log + rotator exhaust; matches plan R8/R9 wording but worth confirming with operator.
- MockAgent-based test for `akash.request()` proxy fallback — covered by code-path inspection but not by direct test (test gap noted in review).

## Unresolved questions
1. **Non-401 balance errors** today proceed to `createDeployment` regardless. If proxy is broken, balance call retries direct, but `createDeployment` will hit proxy first again — minor double-fail per cycle. Acceptable per plan; flag if operator wants a per-cycle proxy circuit-breaker.
2. **Confirm `MAX_UACT_PER_BLOCK=100000` default** — chosen to match the SDL's `amount: 100000`. Operator should re-calibrate after running `npm run probe`.
3. **Live verification (Phase 8)** to be scheduled by operator with real credits.
