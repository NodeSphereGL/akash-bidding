// Round-robin account ring with in-memory exhausted-set. State resets on
// daemon restart by design; getBalance is cheap enough to re-query on
// startup. next() walks the ring at most accounts.length times to avoid
// infinite loops when every account is exhausted.

import { AllExhaustedError } from "./errors.js";

export function createRotator(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("rotator: accounts must be non-empty array");
  }
  const ring = accounts.slice();
  const exhausted = new Set();
  let cursor = 0;
  const exhaustReasons = new Map();

  function next() {
    for (let i = 0; i < ring.length; i++) {
      const candidate = ring[cursor];
      cursor = (cursor + 1) % ring.length;
      if (!exhausted.has(candidate.name)) return candidate;
    }
    throw new AllExhaustedError(`all ${ring.length} accounts exhausted`);
  }

  function markExhausted(account, reason) {
    if (!account?.name) return;
    exhausted.add(account.name);
    exhaustReasons.set(account.name, reason ?? "unspecified");
  }

  function isAllExhausted() {
    return exhausted.size >= ring.length;
  }

  function healthy() {
    return ring.filter((a) => !exhausted.has(a.name));
  }

  function status() {
    return {
      total: ring.length,
      healthy: ring.length - exhausted.size,
      exhausted: [...exhausted].map((name) => ({ name, reason: exhaustReasons.get(name) })),
    };
  }

  function reset() {
    exhausted.clear();
    exhaustReasons.clear();
  }

  return { next, markExhausted, isAllExhausted, healthy, status, reset };
}
