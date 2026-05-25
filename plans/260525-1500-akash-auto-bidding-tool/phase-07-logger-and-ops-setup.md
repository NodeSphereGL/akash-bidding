---
phase: 7
title: "Logger and ops setup"
status: pending
priority: P2
effort: "2h"
dependencies: [5]
---

# Phase 7: Logger and ops setup

## Overview

Implement `src/logger.js` — minimal file + stdout logger with structured fields (timestamp, level, account, event). No external deps. Plus operator-facing setup: README run instructions, optional PM2/systemd notes, log rotation guidance.

## Requirements

- Functional: `logger.info/warn/error(event, fields)` writes one line to stdout AND appends to `LOG_FILE`.
- Functional: every log line includes ISO timestamp + level + event + optional fields.
- Functional: account name in every log line emitted from inside a cycle (passed via per-cycle child logger).
- Non-functional: zero dependencies; file write must be async but ordered (use append + small write queue); no log loss on graceful shutdown.

## Architecture

```
logger.js
  ├── createLogger(filePath) → Logger
  │     uses fs.createWriteStream(filePath, { flags: "a" })
  │
  └── Logger methods:
        info(event, fields)
        warn(event, fields)
        error(event, fields)
        child(extraFields) → Logger  // for per-account scoping

Line format (one JSON object per line, JSONL):
{ "ts": "2026-05-25T14:30:12.345Z", "level": "info", "event": "cycle.start",
  "account": "trial-1", "dseq": "123456", ... }
```

## Related Code Files

- Create: `src/logger.js`
- Create: `tests/logger.test.js`
- Modify: `README.md` — add Run / Setup / Troubleshooting sections.
- Create: `docs/run-and-ops.md` (PM2 + systemd snippets, log rotation)

## Implementation Steps

1. Write `src/logger.js`:
   - `createLogger(filePath)` opens append stream.
   - Each method builds JSON object, stringifies, writes to stream + console.
   - `child(extraFields)` returns wrapper that merges fields into each call.
   - Handle stream errors: log to console, do not throw upstream.
   - On `process.exit` (via `beforeExit`), drain stream.
2. Inject logger via param into modules that need it (`akash.js`, `bidder.js`, orchestrator). Avoid module-level singleton to keep modules testable.
3. Write unit test: log line is valid JSON, includes expected fields.
4. Update `src/index.js` to create logger at startup and pass `.child({ account: account.name })` into per-cycle code paths.
5. Write `docs/run-and-ops.md`:
   - PM2 sample: `pm2 start src/index.js --name akash-bidder --log ./logs/pm2.log`.
   - systemd unit sample (user-level).
   - Log rotation suggestion: `logrotate` config sample, or `pm2-logrotate`.
   - Restart-after-crash policy and what state is/isn't restored.
6. Update `README.md`:
   - Prereqs: Node 20+, accounts.json, .env, akash-deploy.yaml.
   - `npm install`, `npm run probe` (one-time), `npm start`.
   - Telegram setup.
   - Where logs live, how to tail.
   - Known limitations (no persistence, no auto-close of leases).

## Success Criteria

- [ ] Each log line is valid JSON (verified by `jq < logs/akash-bidding.log | tail -10`).
- [ ] Account name present on every cycle-scoped log line.
- [ ] No log loss on SIGINT (verified by appending until shutdown and counting lines).
- [ ] `docs/run-and-ops.md` includes both PM2 and systemd examples.
- [ ] `README.md` is enough for a new operator to run the daemon end-to-end.

## Risk Assessment

- **Sync stdout vs async file write** can re-order events under load → use same string for both; write file then console (atomic-ish for single-process daemon).
- **Logs growing unbounded** → covered by ops doc (logrotate / pm2-logrotate); not enforced in code.
- **Rolling our own logger** vs `pino` → chose roll-your-own to match cosmos-rescue's zero-framework style; revisit if structured-log demands grow.
