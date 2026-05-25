// Phase 3 of plan 260525-1700: verifies per-account concurrent loops.
// All cases use injected fake akash + fake notify so no network/wall-clock dep.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runAccountLoop } from "../src/index.js";
import { AkashApiError } from "../src/errors.js";

function fakeLogger() {
  const lines = [];
  function build(base) {
    const emit = (level) => (event, fields) => {
      lines.push({ ts: Date.now(), level, event, ...base, ...fields });
    };
    return {
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      child: (extra) => build({ ...base, ...extra }),
      drain: async () => {},
    };
  }
  const logger = build({});
  return { logger, lines };
}

function fakeNotify() {
  const calls = [];
  const stub = async (name, ...args) => {
    calls.push({ name, args });
    return false;
  };
  return {
    calls,
    notifyLeaseSuccess: (...args) => stub("notifyLeaseSuccess", ...args),
    notifyAuthFail: (...args) => stub("notifyAuthFail", ...args),
    notifyAllDepleted: (...args) => stub("notifyAllDepleted", ...args),
    notifySdlFail: (...args) => stub("notifySdlFail", ...args),
    notifyFatal: (...args) => stub("notifyFatal", ...args),
    notifyCrash: (...args) => stub("notifyCrash", ...args),
  };
}

const baseConfig = {
  BID_WAIT_MS: 50,
  BID_POLL_INTERVAL_MS: 5,
  RETRY_MIN_MS: 10,
  RETRY_MAX_MS: 30,
  LEASE_HOLD_MS: 200,
  NO_MATCH_EXHAUST_THRESHOLD: 1000,
  DEPOSIT_USD: 5,
  GPU_BLACKLIST: [],
  MAX_UACT_PER_BLOCK: 100000,
  STARTUP_JITTER_MS: 0,
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  AKASH_API_BASE: "http://fake",
  ACCOUNTS_PATH: "fake",
  SDL_PATH: "fake",
  LOG_FILE: null,
};

function fakeAkash(handlers = {}) {
  let dseqCounter = 1;
  return {
    getBalance: handlers.getBalance ?? (async () => ({ usd: 100 })),
    createDeployment: handlers.createDeployment ?? (async () => ({ dseq: String(dseqCounter++), manifest: {}, txHash: "tx" })),
    getOwnerAddress: handlers.getOwnerAddress ?? (async () => "akash1owner"),
    getBids: handlers.getBids ?? (async () => []),
    createLease: handlers.createLease ?? (async () => ({ id: "L", dseq: "1" })),
    closeDeployment: handlers.closeDeployment ?? (async () => ({})),
  };
}

test("concurrency 1: account A 200ms hold does not block account B (B completes 2+ cycles in 600ms)", async () => {
  const { logger } = fakeLogger();
  const notify = fakeNotify();
  const accountA = { name: "a", apiKey: "kA", proxy: null };
  const accountB = { name: "b", apiKey: "kB", proxy: null };

  // A leases on every cycle → sleeps LEASE_HOLD_MS = 200ms
  const akashA = fakeAkash({
    getBids: async () => [
      {
        id: { owner: "o", dseq: "1", gseq: 1, oseq: 1, provider: "p", bseq: 1 },
        state: "open",
        price: { amount: "5000", denom: "uact" },
        resources_offer: [{ resources: { gpu: { attributes: [{ key: "model", value: "rtx4090" }] } } }],
      },
    ],
  });
  // B never matches → quick close + RETRY_MIN..MAX_MS sleep (~20ms)
  const akashB = fakeAkash({ getBids: async () => [] });

  const abortController = new AbortController();
  const config = { ...baseConfig };
  // limit cycles so test terminates: A 2 leases, B 5+ cycles
  let aCycles = 0;
  let bCycles = 0;
  const akashAWrapped = {
    ...akashA,
    createDeployment: async (...args) => {
      aCycles++;
      if (aCycles >= 2) abortController.abort();
      return akashA.createDeployment(...args);
    },
  };
  const akashBWrapped = {
    ...akashB,
    createDeployment: async (...args) => {
      bCycles++;
      return akashB.createDeployment(...args);
    },
  };

  const start = Date.now();
  await Promise.allSettled([
    runAccountLoop(accountA, { config, sdl: "", logger, notify, akash: akashAWrapped, abortSignal: abortController.signal }),
    runAccountLoop(accountB, { config, sdl: "", logger, notify, akash: akashBWrapped, abortSignal: abortController.signal }),
  ]);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1000, `should finish in <1s, took ${elapsed}ms`);
  assert.ok(bCycles >= 2, `B should run ≥2 cycles independent of A's hold (got ${bCycles})`);
  assert.ok(notify.calls.some((c) => c.name === "notifyLeaseSuccess"), "A should have leased");
});

test("concurrency 2: A 401 marks A exhausted; B continues independently", async () => {
  const { logger, lines } = fakeLogger();
  const notify = fakeNotify();
  const accountA = { name: "a", apiKey: "kA", proxy: null };
  const accountB = { name: "b", apiKey: "kB", proxy: null };

  const akashA = fakeAkash({
    getBalance: async () => { throw new AkashApiError(401, "unauthorized", {}); },
  });
  let bCycles = 0;
  const abortController = new AbortController();
  const akashB = fakeAkash({
    createDeployment: async (...args) => {
      bCycles++;
      if (bCycles >= 3) abortController.abort();
      return { dseq: String(bCycles), manifest: {}, txHash: "tx" };
    },
    getBids: async () => [],
  });

  const config = { ...baseConfig };
  const results = await Promise.allSettled([
    runAccountLoop(accountA, { config, sdl: "", logger, notify, akash: akashA, abortSignal: abortController.signal }),
    runAccountLoop(accountB, { config, sdl: "", logger, notify, akash: akashB, abortSignal: abortController.signal }),
  ]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value.reason, "401");
  assert.ok(bCycles >= 3, `B should keep cycling (got ${bCycles})`);
  assert.ok(lines.some((l) => l.event === "auth.fail" && l.account === "a"));
  assert.ok(notify.calls.some((c) => c.name === "notifyAuthFail"));
});

test("concurrency 3: abort fires mid-cycle, both loops return promptly", async () => {
  const { logger } = fakeLogger();
  const notify = fakeNotify();
  const accountA = { name: "a", apiKey: "kA", proxy: null };
  const accountB = { name: "b", apiKey: "kB", proxy: null };

  // Both accounts lease and enter LEASE_HOLD_MS = 5000ms — abort must wake them
  const config = { ...baseConfig, LEASE_HOLD_MS: 5000 };
  const akash = fakeAkash({
    getBids: async () => [
      {
        id: { owner: "o", dseq: "1", gseq: 1, oseq: 1, provider: "p", bseq: 1 },
        state: "open",
        price: { amount: "5000", denom: "uact" },
        resources_offer: [{ resources: { gpu: { attributes: [{ key: "model", value: "rtx4090" }] } } }],
      },
    ],
  });

  const abortController = new AbortController();
  // abort 100ms in — loops are sleeping in LEASE_HOLD_MS by then
  setTimeout(() => abortController.abort(), 100);

  const start = Date.now();
  await Promise.allSettled([
    runAccountLoop(accountA, { config, sdl: "", logger, notify, akash, abortSignal: abortController.signal }),
    runAccountLoop(accountB, { config, sdl: "", logger, notify, akash, abortSignal: abortController.signal }),
  ]);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1000, `loops must wake on abort, took ${elapsed}ms`);
});

test("concurrency 4: per-iteration crash isolation — loop continues after thrown exception", async () => {
  const { logger, lines } = fakeLogger();
  const notify = fakeNotify();
  const account = { name: "a", apiKey: "kA", proxy: null };

  let createDeploymentCalls = 0;
  const abortController = new AbortController();
  const akash = fakeAkash({
    createDeployment: async (...args) => {
      createDeploymentCalls++;
      if (createDeploymentCalls === 1) throw new Error("simulated programming error");
      if (createDeploymentCalls >= 2) abortController.abort();
      return { dseq: "1", manifest: {}, txHash: "tx" };
    },
    getBids: async () => [],
  });

  const config = { ...baseConfig };
  const result = await runAccountLoop(account, {
    config,
    sdl: "",
    logger,
    notify,
    akash,
    abortSignal: abortController.signal,
  });
  // Should NOT have crashed; should have returned via abort
  assert.ok(createDeploymentCalls >= 2, `loop must continue after exception (calls=${createDeploymentCalls})`);
  assert.ok(
    lines.some((l) => l.event === "cycle.unexpected"),
    "must emit cycle.unexpected event on thrown exception",
  );
  assert.equal(result?.reason, "aborted");
});

test("concurrency 5: account.loop.start and account.loop.exit lifecycle events fire", async () => {
  const { logger, lines } = fakeLogger();
  const notify = fakeNotify();
  const account = { name: "a", apiKey: "kA", proxy: null };
  const abortController = new AbortController();

  const akash = fakeAkash({
    getBalance: async () => { throw new AkashApiError(401, "unauthorized", {}); },
  });

  const config = { ...baseConfig };
  await runAccountLoop(account, {
    config,
    sdl: "",
    logger,
    notify,
    akash,
    abortSignal: abortController.signal,
  });

  assert.ok(lines.some((l) => l.event === "account.loop.start" && l.account === "a"), "must emit account.loop.start");
  assert.ok(lines.some((l) => l.event === "account.loop.exit" && l.account === "a"), "must emit account.loop.exit");
});
