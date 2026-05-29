// Sweeper unit tests: mocked repos + notify. Drives the sweeper via its
// returned `tick` function to avoid setInterval timing.

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
  SWEEP_INTERVAL_MS: 999_999, // never fires; we call tick directly
  PUT_NAG_INTERVAL_MS: 1_800_000,
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
};

test("sweeper: expires LOCKED groups and EXPIRED deployments, logs counts", async () => {
  const { logger, lines } = fakeLogger();
  const groupsRepo = {
    expireDue: async () => 3,
    listPutFailedNagDue: async () => [],
    markNagged: async () => {},
  };
  const deploymentsRepo = { expireDue: async () => 2 };
  const notify = { notifyPutFailedNag: async () => {}, notifySweepRelease: async () => {} };

  const abort = new AbortController();
  const sw = startSweeper({
    config: baseConfig, logger, notify, groupsRepo, deploymentsRepo, abortSignal: abort.signal,
  });
  await sw.tick();

  const done = lines.find((l) => l.event === "sweeper.cycle.done");
  assert.ok(done, "must emit cycle.done");
  assert.equal(done.released, 3);
  assert.equal(done.expired, 2);
  assert.equal(done.nagged, 0);
  sw.stop();
});

test("sweeper: nags PUT_FAILED groups once per tick + marks each nagged", async () => {
  const { logger } = fakeLogger();
  const due = [
    { name: "group_01_vast_ai", locked_dseq: "100", locked_by_account_id: 1 },
    { name: "group_02_m79", locked_dseq: "101", locked_by_account_id: 2 },
  ];
  const marked = [];
  const groupsRepo = {
    expireDue: async () => 0,
    listPutFailedNagDue: async () => due,
    markNagged: async (name) => { marked.push(name); },
  };
  const deploymentsRepo = { expireDue: async () => 0 };
  const nagCalls = [];
  const notify = {
    notifyPutFailedNag: async (g) => { nagCalls.push(g.name); },
    notifySweepRelease: async () => {},
  };

  const abort = new AbortController();
  const sw = startSweeper({ config: baseConfig, logger, notify, groupsRepo, deploymentsRepo, abortSignal: abort.signal });
  await sw.tick();

  assert.deepEqual(nagCalls, ["group_01_vast_ai", "group_02_m79"]);
  assert.deepEqual(marked, ["group_01_vast_ai", "group_02_m79"]);
  sw.stop();
});

test("sweeper: notifySweepRelease fires only when released >= 3", async () => {
  const { logger } = fakeLogger();
  const sweepCalls = [];
  const notify = {
    notifyPutFailedNag: async () => {},
    notifySweepRelease: async (n) => { sweepCalls.push(n); },
  };
  const deploymentsRepo = { expireDue: async () => 0 };

  // released=2 → no notify
  let r1 = startSweeper({
    config: baseConfig, logger, notify,
    groupsRepo: { expireDue: async () => 2, listPutFailedNagDue: async () => [], markNagged: async () => {} },
    deploymentsRepo, abortSignal: new AbortController().signal,
  });
  await r1.tick();
  r1.stop();
  assert.equal(sweepCalls.length, 0);

  // released=5 → notify
  let r2 = startSweeper({
    config: baseConfig, logger, notify,
    groupsRepo: { expireDue: async () => 5, listPutFailedNagDue: async () => [], markNagged: async () => {} },
    deploymentsRepo, abortSignal: new AbortController().signal,
  });
  await r2.tick();
  r2.stop();
  assert.deepEqual(sweepCalls, [5]);
});

test("sweeper: cycle error in expireDue does not throw out of tick", async () => {
  const { logger, lines } = fakeLogger();
  const groupsRepo = {
    expireDue: async () => { throw new Error("db down"); },
    listPutFailedNagDue: async () => [],
    markNagged: async () => {},
  };
  const deploymentsRepo = { expireDue: async () => 0 };
  const notify = { notifyPutFailedNag: async () => {}, notifySweepRelease: async () => {} };

  const abort = new AbortController();
  const sw = startSweeper({ config: baseConfig, logger, notify, groupsRepo, deploymentsRepo, abortSignal: abort.signal });
  await sw.tick(); // must not throw
  assert.ok(lines.some((l) => l.event === "sweeper.expire.groups.failed"));
  sw.stop();
});

test("sweeper: abortSignal stops the interval", async () => {
  const { logger, lines } = fakeLogger();
  const abort = new AbortController();
  const sw = startSweeper({
    config: baseConfig, logger,
    notify: { notifyPutFailedNag: async () => {}, notifySweepRelease: async () => {} },
    groupsRepo: { expireDue: async () => 0, listPutFailedNagDue: async () => [], markNagged: async () => {} },
    deploymentsRepo: { expireDue: async () => 0 },
    abortSignal: abort.signal,
  });
  abort.abort();
  // Give the abort listener one microtask to run.
  await new Promise((r) => setImmediate(r));
  assert.ok(lines.some((l) => l.event === "sweeper.stop"));
  sw.stop();
});
