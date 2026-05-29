// Notify payload sanity: PUT-failed notifiers must include the operator
// context (group, dseq, error) and skip silently when telegram is unconfigured.

import { test } from "node:test";
import assert from "node:assert/strict";

import { notifyPutFailed, notifyPutFailedNag, notifySweepRelease, notifyLeaseSuccess } from "../src/notify.js";

const blankCfg = { botToken: "", chatId: "" };

test("notifyPutFailed: returns false silently when telegram unconfigured", async () => {
  const ok = await notifyPutFailed(
    { dseq: "100", reason: "boom", group: "group_01_vast_ai", account: { name: "alpha" } },
    blankCfg,
  );
  assert.equal(ok, false);
});

test("notifyPutFailedNag: returns false silently when telegram unconfigured", async () => {
  const ok = await notifyPutFailedNag(
    { name: "group_01_vast_ai", locked_dseq: "100", locked_by_account_id: 1, last_error: "boom" },
    blankCfg,
  );
  assert.equal(ok, false);
});

test("notifySweepRelease: returns false silently when telegram unconfigured", async () => {
  assert.equal(await notifySweepRelease(5, blankCfg), false);
});

test("notifyLeaseSuccess: accepts optional group + putStatus without throwing", async () => {
  const ok = await notifyLeaseSuccess(
    {
      bid: { model: "rtx4090", uactPerBlock: 1234, provider: "p" },
      lease: { id: "L1", dseq: "100" },
      account: { name: "alpha" },
      group: "group_01_vast_ai",
      putStatus: "PUT_OK",
    },
    blankCfg,
  );
  assert.equal(ok, false);
});

// Capture sendTelegram payload via fetch stub.
test("notifyPutFailed: payload includes dseq, group, account name, and reason", async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    await notifyPutFailed(
      { dseq: "100", reason: "kaboom", group: "group_03_b100", account: { name: "alpha" } },
      { botToken: "X", chatId: "Y" },
    );
    assert.ok(captured, "fetch must be called");
    const text = captured.body.text;
    assert.match(text, /100/);
    assert.match(text, /group_03_b100/);
    assert.match(text, /alpha/);
    assert.match(text, /kaboom/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("notifyPutFailedNag: payload includes the release hint with group name", async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    await notifyPutFailedNag(
      { name: "group_05_s50", locked_dseq: "555", locked_by_account_id: 2, last_error: "timeout" },
      { botToken: "X", chatId: "Y" },
    );
    assert.ok(captured);
    const text = captured.body.text;
    assert.match(text, /group_05_s50/);
    assert.match(text, /\/release/);
    assert.match(text, /555/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
