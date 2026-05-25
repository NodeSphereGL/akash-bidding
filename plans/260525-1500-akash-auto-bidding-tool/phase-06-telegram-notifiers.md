---
phase: 6
title: "Telegram notifiers"
status: pending
priority: P2
effort: "1.5h"
dependencies: []
---

# Phase 6: Telegram notifiers

## Overview

Implement `src/notify.js` — Telegram Bot API client (REST, HTML parse mode) lifted from `cosmos-rescue/src/notify.js`. Adds 5 typed notifier functions for the events specified in R9.

## Requirements

- Functional: `sendTelegram(text)` low-level sender.
- Functional: 5 typed notifiers — `notifyLeaseSuccess`, `notifyAllDepleted`, `notifyAuthFail`, `notifySdlFail`, `notifyCrash`.
- Non-functional: never throw to caller; failures log to file and resolve `false`. Notification disabled (returns false silently) when bot token / chat id not configured.

## Architecture

```
notify.js
  ├── sendTelegram(html) → Promise<boolean>
  │     POST https://api.telegram.org/bot{TOKEN}/sendMessage
  │     body { chat_id, text, parse_mode: "HTML" }
  │     log + return false on any error
  │
  ├── notifyLeaseSuccess({ bid, lease, account })
  ├── notifyAllDepleted(accountsCount)
  ├── notifyAuthFail(account)
  ├── notifySdlFail(error)
  └── notifyCrash(error)
```

All notifiers compose an HTML message string then call `sendTelegram`.

## Related Code Files

- Create: `src/notify.js`
- Read for context: `/Users/ductoanbk/Working/Project/BLOCKCHAIN/NODESPHERE/cosmos-rescue/src/notify.js`

## Implementation Steps

1. Port `sendTelegram` from cosmos-rescue (HTML parse mode, fetch-based).
2. Add early-return: if `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` unset → return false silently.
3. Implement `notifyLeaseSuccess({ bid, lease, account })` with format:
   ```
   🎯 <b>Akash Lease Acquired</b>
   <code>{ISO timestamp}</code>

   Account: <b>{account.name}</b>
   GPU: <b>{bid.model}</b>
   Price: <b>{bid.uactPerBlock} uact/block</b>
   Provider: <code>{bid.provider}</code>
   dseq: <code>{lease.dseq}</code>
   Lease: <code>{lease.id}</code>

   Deposit: $5.00
   Next cycle in 1h.
   ```
   <!-- Updated: Validation Session 1 — price field is uact/block (chain denom), not USD/hr -->
   
4. Implement `notifyAllDepleted(accountsCount)`:
   ```
   🛑 <b>Akash Bidder Stopping</b>
   All {accountsCount} accounts have balance < $5.
   Top up and restart.
   ```
5. Implement `notifyAuthFail(account)`:
   ```
   ⚠️ <b>Account Auth Failed</b>
   {account.name} returned 401. Marked exhausted.
   ```
6. Implement `notifySdlFail(error)`:
   ```
   ❌ <b>SDL Load Failed</b>
   {error.message}
   Daemon exiting before loop.
   ```
7. Implement `notifyCrash(error)`:
   ```
   💥 <b>Akash Bidder Crashed</b>
   <code>{error.stack first 5 lines}</code>
   Exiting with code 1.
   ```
8. Manual smoke test: temporarily call each notifier from a script with real bot token.

## Success Criteria

- [ ] All 5 notifiers render correctly in Telegram (verified by manual smoke test).
- [ ] Missing token/chat id → notifiers return false without throwing.
- [ ] Failures inside `sendTelegram` (e.g. 401 from Telegram) log to file but never reject upstream.
- [ ] HTML entities in error messages (e.g. `<`, `&`) are escaped to avoid Telegram parse errors.

## Risk Assessment

- **Unescaped HTML in error messages** could break parse mode → escape `<`, `>`, `&` in any user-supplied or error-derived string before formatting.
- **Telegram rate limits** (20 msgs/min/chat) → not a real concern at our event frequency, but log if `sendTelegram` returns 429.
- **Long error stacks** could exceed 4096 char Telegram limit → truncate `error.stack` to 1500 chars in `notifyCrash`.
