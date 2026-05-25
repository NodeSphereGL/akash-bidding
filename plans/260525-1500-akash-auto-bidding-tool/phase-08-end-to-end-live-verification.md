---
phase: 8
title: "End-to-end live verification"
status: pending
priority: P1
effort: "3h"
dependencies: [5, 6, 7]
---

# Phase 8: End-to-end live verification

## Overview

Run the daemon live against real Akash with all wired modules. Verify every R requirement empirically: lease acquisition, fallback walk, no-match close, account rotation, balance exhaustion, proxy IP isolation, Telegram delivery. Document any deviations and lock the v1 baseline.

## Requirements

- Functional: at least 1 successful cycle per scenario in the matrix below.
- Functional: Telegram messages observed for each notification event.
- Non-functional: 1h continuous run with no crashes.

## Architecture

Test matrix (each row = one observation to record in `verification-report.md`):

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Greedy lease success | 1 account with healthy balance | First matching bid leased; Telegram success message; 1h sleep |
| 2 | No match → close → retry | Set `MAX_UACT_PER_BLOCK=1` temporarily | All bids filtered out; deployment closed at 120s; sleep 60-180s; new cycle |
| 3 | Lease fallback walk | Pick a known-failing GPU model NOT in blacklist (if any) | Primary lease attempt fails; secondary succeeds; success Telegram |
| 4 | Account rotation | 2+ accounts | Cycle N uses account A, cycle N+1 uses account B (verified via logs) |
| 5 | Balance < $5 detection | Use a near-empty account | Account marked exhausted; rotator skips it |
| 6 | All accounts depleted | All accounts < $5 | "All depleted" Telegram; daemon exits 0 |
| 7 | Proxy IP isolation | 2 accounts with different proxies | curl through each proxy from logs shows distinct outbound IP |
| 8 | 401 handling | Use deliberately-invalid API key on one account | `notifyAuthFail`; account marked exhausted; daemon continues with others |
| 9 | SDL load failure | Temporarily rename `akash-deploy.yaml` | `notifySdlFail`; daemon exits before loop |
| 10 | SIGINT clean shutdown | Send SIGINT mid-cycle | "shutdown" log line; no crash; exit 0 |
| 11 | 1h continuous run | Default config, all accounts healthy | ≥ 1 cycle/account/hour; no memory growth > 50MB |

## Related Code Files

- Create: `plans/260525-1500-akash-auto-bidding-tool/verification-report.md`
- Create: `scripts/check-proxy-ip.js` — small helper that fetches `https://api.ipify.org` through configured proxy
- Read: all `src/*.js`

## Implementation Steps

1. Pre-flight checks:
   - `npm install` clean.
   - `.env` and `accounts.json` populated with at least 2 accounts (1 healthy, 1 depleted/near-empty if available).
   - `akash-deploy.yaml` present.
2. Run scenarios 1–6 sequentially with the daemon, capturing log excerpts + Telegram screenshots for each.
3. For scenario 7, run `scripts/check-proxy-ip.js` once per account and record IPs.
4. For scenarios 8–10, modify env/files temporarily, run, observe, revert.
5. For scenario 11, start daemon with all healthy accounts, leave running for 1h. Capture:
   - Cycle count per account.
   - Total leases acquired.
   - Memory `process.memoryUsage().rss` at t=0 and t=60min.
   - Any error log lines.
6. Write `verification-report.md` summarizing each scenario: pass/fail, log excerpts, deviations from plan, follow-up items.
7. If deviations exist that change behavior contract (not just bugs), update `plan.md` + relevant phase files BEFORE marking phase complete.

## Success Criteria

- [ ] All 11 scenarios documented in `verification-report.md` with pass/fail.
- [ ] Telegram delivery confirmed for at least: lease success, all-depleted, auth-fail, SDL-fail, crash (use a deliberate `throw` in test build to trigger crash notifier).
- [ ] Proxy IP isolation visually confirmed (curl/ipify outputs in report).
- [ ] 1h continuous run: no uncaught exceptions, no memory growth > 50MB.
- [ ] All scenarios that fail have either a fix or an explicit "deferred" note with reason.

## Risk Assessment

- **Live verification consumes real credits** → budget ≤ $10 across scenarios; document spend in report.
- **Provider availability** outside our control → if no bids appear repeatedly, raise `MAX_UACT_PER_BLOCK` for one scenario to confirm code path then revert.
- **Crash notifier test** requires temporarily injecting a `throw` → use a feature-flagged `--simulate-crash` arg rather than committed unconditional code.
- **Verification artifacts** may contain account names / dseqs → safe to commit; redact any real provider addresses or Telegram chat IDs before commit.
