---
phase: 3
title: "Bid filtering and ranking"
status: pending
priority: P1
effort: "3h"
dependencies: [1, 2]
---

# Phase 3: Bid filtering and ranking

<!-- Updated: Validation Session 1 — dropped USD conversion; ceiling is MAX_UACT_PER_BLOCK; blacklist is substring case-insensitive -->

## Overview

Implement `src/bidder.js` — pure functions converting raw bid array into a DESC-sorted candidate list ready for greedy selection and fallback walking. All business rules from R4 (filter blacklist by substring match, drop bids over `MAX_UACT_PER_BLOCK`, sort DESC by uact/block price).

## Requirements

- Functional: `filterAndRank(rawBids, config)` returns `BidCandidate[]` sorted DESC by `uactPerBlock`.
- Functional: `extractGpuModel(bid)` returns normalized model string lowercase (e.g. `"a100"`, `"nvidia-a100-sxm4"`).
- Functional: `isBlacklisted(model, blacklist)` does case-insensitive substring match — true if `model` contains any blacklist entry.
- Non-functional: pure (no I/O), fully unit-testable with fixture JSON from Phase 1 probe output. No USD conversion anywhere.

## Architecture

```
filterAndRank(rawBids, { gpuBlacklist, maxUactPerBlock })
   │
   ├ 1. drop bids where state != "open"
   ├ 2. for each bid: extractGpuModel + lowercase
   ├ 3. drop bids whose model contains any blacklist entry (substring, case-insensitive)
   ├ 4. parse bid.price.amount → uactPerBlock = parseInt(amount, 10)
   ├ 5. drop bids with uactPerBlock > maxUactPerBlock
   ├ 6. sort DESC by uactPerBlock
   └ → BidCandidate[] { bid, model, uactPerBlock, provider, compositeId }
```

No blocktime constant, no rate, no conversion. The ceiling is in the same unit as `bid.price.amount`.

## Related Code Files

- Create: `src/bidder.js`
- Create: `tests/bidder.test.js` (Node `node:test` runner)
- Create: `tests/fixtures/bids-sample.json` (copy from Phase 1 probe output, anonymized)
- Read: `scripts/probe-output/findings.md` for exact field paths

## Implementation Steps

1. Write `extractGpuModel(bid)`:
   - Walk `bid.resources_offer[].resources.gpu.attributes[]` using path from `findings.md`.
   - Return lowercase model string or `null` if not GPU bid.
2. Write `isBlacklisted(model, blacklist)`:
   - `model` already lowercase. `blacklist` is array of lowercase substrings (parsed from `GPU_BLACKLIST` env, comma-separated).
   - Return `blacklist.some(b => model.includes(b))`.
3. Write `filterAndRank(rawBids, config)`:
   - Pipeline as in Architecture.
   - Each stage logs (via injected logger) count before/after for observability.
4. Define `BidCandidate` JSDoc typedef.
5. Write unit tests using `node:test`:
   - Fixture: 6+ realistic bid objects (mix of allowed/blacklisted/over-cap).
   - Assert substring match drops `nvidia-a100-sxm4` when blacklist contains `a100`.
   - Assert substring match drops `nvidia-h100-pcie` when blacklist contains `h100`.
   - Assert cap drops bid with `uactPerBlock > MAX_UACT_PER_BLOCK`.
   - Assert sort DESC order by `uactPerBlock`.
   - Assert empty input → empty output.
   - Assert `null` gpu model bid is dropped.
   - Assert boundary: bid at exactly `MAX_UACT_PER_BLOCK` is INCLUDED; `+1` is excluded.
6. Run `node --test tests/bidder.test.js`.

## Success Criteria

- [ ] `filterAndRank` is pure (no I/O, no globals).
- [ ] Unit tests cover: empty input, all-filtered, mixed input, sort order, cap boundary (MAX_UACT_PER_BLOCK inclusive).
- [ ] Fixture-driven: at least one test uses real probe output JSON.
- [ ] `extractGpuModel` handles missing/malformed bids without throwing.
- [ ] Substring blacklist: `nvidia-a100-sxm4` dropped when `a100` in list; non-blacklisted model containing letters of blacklist substring is documented as known limitation.

## Risk Assessment

- **GPU attribute path drift across providers** → tolerate either `attributes` as array of `{key,value}` or as map; document which Phase 1 found.
- **`MAX_UACT_PER_BLOCK` of 0 or NaN** → guard at config-load time; throw with clear message rather than silently filtering all bids.
- **Substring false positives** → e.g. a blacklist entry `a10` would match `a100`. Operator controls blacklist; document the pitfall in `.env.example` comment.
- **Bid state enum unknown beyond "open"** → log + drop unknown states; revisit if probe surfaces other states.
