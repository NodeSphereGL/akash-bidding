// Sweeper auto-topup retry: drives a single tick with a fake akash + repo
// and asserts retry behavior + the >1h alert path.

import { test } from "node:test";
import assert from "node:assert/strict";

import { startSweeper } from "../src/sweeper.js";

function fakeLogger() {
  const lines = [];
  function build(base) {
    const emit = (level) => (event, fields) => {
      lines.push({ level, event, ...base, ...fields });
    };
    return {
      info: emit("info"), warn: emit("warn"), error: emit("error"),
      child: (extra) => build({ ...base, ...extra }),
    };
  }
  return { logger: build({}), lines };
}

const baseConfig = {
  SWEEP_INTERVAL_MS: 999_999,
  PUT_NAG_INTERVAL_MS: 1_800_000,
  TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "y", // notifier still no-ops via cfg
};

function fakeGroupsRepo() {
  return {
    expireDue: async () => 0,
    listPutFailedNagDue: async () => [],
    markNagged: async () => {},
  };
}

test("sweeper.auto_topup: PATCH ok → marks row + logs retry.ok", async () => {
  const { logger, lines } = fakeLogger();
  const recentMark = [];
  const deploymentsRepo = {
    expireDue: async () => 0,
    listPendingAutoTopUp: async () => [
      { dseq: "100", account_id: 1, leased_at: new Date() },
    ],
    markAutoTopUpDisabled: async (dseq, id) => { recentMark.push([dseq, id]); },
  };
  const akash = { disableAutoTopUp: async () => ({ ok: true }) };
  const accounts = [{ id: 1, name: "alpha", apiKey: "k", proxy: null }];

  const abort = new AbortController();
  const sw = startSweeper({
    config: baseConfig, logger, notify: { notifyPutFailedNag: async () => {}, notifySweepRelease: async () => {} },
    groupsRepo: fakeGroupsRepo(), deploymentsRepo, accountsRepo: { listAll: async () => accounts }, akash, abortSignal: abort.signal,
  });
  await sw.tick();
  sw.stop();

  assert.deepEqual(recentMark, [["100", 1]]);
  const okLog = lines.find((l) => l.event === "sweeper.auto_topup.retry.ok");
  assert.ok(okLog, "must log retry.ok");
  const done = lines.find((l) => l.event === "sweeper.cycle.done");
  assert.equal(done.autoTopUp.tried, 1);
  assert.equal(done.autoTopUp.ok, 1);
  assert.equal(done.autoTopUp.alerted, 0);
});

test("sweeper.auto_topup: PATCH fails fresh row → warn but NO alert (under 1h)", async () => {
  const { logger, lines } = fakeLogger();
  const notifyCalls = [];
  const deploymentsRepo = {
    expireDue: async () => 0,
    listPendingAutoTopUp: async () => [
      { dseq: "200", account_id: 2, leased_at: new Date(Date.now() - 5 * 60_000) }, // 5min old
    ],
    markAutoTopUpDisabled: async () => {},
  };
  const akash = { disableAutoTopUp: async () => { throw new Error("upstream 502"); } };
  const accounts = [{ id: 2, name: "beta", apiKey: "k", proxy: null }];
  const notify = {
    notifyPutFailedNag: async () => {},
    notifySweepRelease: async () => {},
    notifyLeaseOrphan: async (args) => { notifyCalls.push(args); return true; },
  };

  const sw = startSweeper({
    config: baseConfig, logger, notify,
    groupsRepo: fakeGroupsRepo(), deploymentsRepo,
    accountsRepo: { listAll: async () => accounts }, akash,
    abortSignal: new AbortController().signal,
  });
  await sw.tick();
  sw.stop();

  assert.equal(notifyCalls.length, 0, "no alert under 1h threshold");
  const warn = lines.find((l) => l.event === "sweeper.auto_topup.retry.failed");
  assert.ok(warn, "must log retry.failed");
  const done = lines.find((l) => l.event === "sweeper.cycle.done");
  assert.equal(done.autoTopUp.tried, 1);
  assert.equal(done.autoTopUp.ok, 0);
  assert.equal(done.autoTopUp.alerted, 0);
});

test("sweeper.auto_topup: PATCH fails > 1h → fires notifyLeaseOrphan exactly once", async () => {
  const { logger } = fakeLogger();
  const notifyCalls = [];
  const oneRow = { dseq: "300", account_id: 3, leased_at: new Date(Date.now() - 2 * 3600_000) }; // 2h old
  const deploymentsRepo = {
    expireDue: async () => 0,
    listPendingAutoTopUp: async () => [oneRow],
    markAutoTopUpDisabled: async () => {},
  };
  const akash = { disableAutoTopUp: async () => { throw new Error("still 503"); } };
  const accounts = [{ id: 3, name: "gamma", apiKey: "k", proxy: null }];
  const notify = {
    notifyPutFailedNag: async () => {},
    notifySweepRelease: async () => {},
    notifyLeaseOrphan: async (args) => { notifyCalls.push(args); return true; },
  };

  const sw = startSweeper({
    config: baseConfig, logger, notify,
    groupsRepo: fakeGroupsRepo(), deploymentsRepo,
    accountsRepo: { listAll: async () => accounts }, akash,
    abortSignal: new AbortController().signal,
  });
  await sw.tick();
  await sw.tick(); // second tick must NOT re-alert the same dseq
  sw.stop();

  assert.equal(notifyCalls.length, 1, "exactly one alert across two ticks");
  assert.equal(notifyCalls[0].dseq, "300");
  assert.match(notifyCalls[0].error, /auto-topup disable still failing/);
});

test("sweeper.auto_topup: row whose account row is missing (deleted) is skipped + warned", async () => {
  const { logger, lines } = fakeLogger();
  const markCalls = [];
  const deploymentsRepo = {
    expireDue: async () => 0,
    listPendingAutoTopUp: async () => [{ dseq: "400", account_id: 99, leased_at: new Date() }],
    markAutoTopUpDisabled: async (...args) => { markCalls.push(args); },
  };
  let patchCalled = false;
  const akash = { disableAutoTopUp: async () => { patchCalled = true; } };
  const accounts = [{ id: 1, name: "alpha" }]; // account_id 99 deleted from DB

  const sw = startSweeper({
    config: baseConfig, logger,
    notify: { notifyPutFailedNag: async () => {}, notifySweepRelease: async () => {} },
    groupsRepo: fakeGroupsRepo(), deploymentsRepo,
    accountsRepo: { listAll: async () => accounts }, akash,
    abortSignal: new AbortController().signal,
  });
  await sw.tick();
  sw.stop();

  assert.equal(patchCalled, false);
  assert.equal(markCalls.length, 0);
  const warn = lines.find((l) => l.event === "sweeper.auto_topup.account_missing");
  assert.ok(warn, "must warn when account row is gone");
  const done = lines.find((l) => l.event === "sweeper.cycle.done");
  assert.equal(done.autoTopUp.tried, 0);
});

test("sweeper.auto_topup: row whose account is DISABLED but still in DB still gets PATCHed", async () => {
  // H3 regression: previously the sweeper loaded accounts via listEnabled at
  // startup, so disabling an account stranded its auto-topup retries and
  // escrow kept refilling. Sweeper now uses listAll per tick.
  const { logger, lines } = fakeLogger();
  const recentMark = [];
  const deploymentsRepo = {
    expireDue: async () => 0,
    listPendingAutoTopUp: async () => [{ dseq: "500", account_id: 7, leased_at: new Date() }],
    markAutoTopUpDisabled: async (dseq, id) => { recentMark.push([dseq, id]); },
  };
  const akash = { disableAutoTopUp: async () => ({ ok: true }) };
  // Account 7 is disabled but still present in the DB.
  const accounts = [{ id: 7, name: "disabled-but-present", apiKey: "k", proxy: null, enabled: false }];

  const sw = startSweeper({
    config: baseConfig, logger,
    notify: { notifyPutFailedNag: async () => {}, notifySweepRelease: async () => {} },
    groupsRepo: fakeGroupsRepo(), deploymentsRepo,
    accountsRepo: { listAll: async () => accounts }, akash,
    abortSignal: new AbortController().signal,
  });
  await sw.tick();
  sw.stop();

  assert.deepEqual(recentMark, [["500", 7]], "PATCH retried even though account is disabled");
  const ok = lines.find((l) => l.event === "sweeper.auto_topup.retry.ok");
  assert.ok(ok, "must log retry.ok for disabled account");
});
