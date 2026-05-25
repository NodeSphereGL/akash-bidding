import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createRotator } from "../src/rotator.js";
import { AllExhaustedError } from "../src/errors.js";
import { loadAccounts } from "../src/accounts-loader.js";

const accounts = [
  { name: "a", apiKey: "k1", proxy: null },
  { name: "b", apiKey: "k2", proxy: null },
  { name: "c", apiKey: "k3", proxy: null },
];

test("rotator: round-robin in insertion order", () => {
  const r = createRotator(accounts);
  assert.equal(r.next().name, "a");
  assert.equal(r.next().name, "b");
  assert.equal(r.next().name, "c");
  assert.equal(r.next().name, "a");
});

test("rotator: skips exhausted accounts", () => {
  const r = createRotator(accounts);
  r.markExhausted(accounts[1], "test");
  assert.equal(r.next().name, "a");
  assert.equal(r.next().name, "c");
  assert.equal(r.next().name, "a");
});

test("rotator: throws AllExhaustedError when all marked", () => {
  const r = createRotator(accounts);
  r.markExhausted(accounts[0], "x");
  r.markExhausted(accounts[1], "x");
  r.markExhausted(accounts[2], "x");
  assert.equal(r.isAllExhausted(), true);
  assert.throws(() => r.next(), AllExhaustedError);
});

test("rotator: single account exhausted → immediately all-exhausted", () => {
  const r = createRotator([accounts[0]]);
  r.markExhausted(accounts[0], "x");
  assert.equal(r.isAllExhausted(), true);
});

test("rotator: status() reports counts and reasons", () => {
  const r = createRotator(accounts);
  r.markExhausted(accounts[0], "balance");
  const s = r.status();
  assert.equal(s.total, 3);
  assert.equal(s.healthy, 2);
  assert.equal(s.exhausted[0].name, "a");
  assert.equal(s.exhausted[0].reason, "balance");
});

test("rotator: empty input throws", () => {
  assert.throws(() => createRotator([]));
});

test("loadAccounts: rejects duplicate names", async () => {
  const p = resolve(tmpdir(), `acc-dup-${Date.now()}.json`);
  await writeFile(p, JSON.stringify([
    { name: "x", apiKey: "k1", proxy: null },
    { name: "x", apiKey: "k2", proxy: null },
  ]));
  await assert.rejects(loadAccounts(p), /duplicate name/);
  await unlink(p).catch(() => {});
});

test("loadAccounts: rejects missing apiKey", async () => {
  const p = resolve(tmpdir(), `acc-noapi-${Date.now()}.json`);
  await writeFile(p, JSON.stringify([{ name: "x", proxy: null }]));
  await assert.rejects(loadAccounts(p), /apiKey/);
  await unlink(p).catch(() => {});
});

test("loadAccounts: rejects REPLACE_ME placeholder", async () => {
  const p = resolve(tmpdir(), `acc-placeholder-${Date.now()}.json`);
  await writeFile(p, JSON.stringify([{ name: "x", apiKey: "REPLACE_ME", proxy: null }]));
  await assert.rejects(loadAccounts(p), /placeholder/);
  await unlink(p).catch(() => {});
});

test("loadAccounts: normalizes empty proxy to null", async () => {
  const p = resolve(tmpdir(), `acc-proxy-${Date.now()}.json`);
  await writeFile(p, JSON.stringify([
    { name: "x", apiKey: "k1", proxy: "" },
    { name: "y", apiKey: "k2", proxy: "  " },
    { name: "z", apiKey: "k3", proxy: "http://1.2.3.4:8080" },
  ]));
  const out = await loadAccounts(p);
  assert.equal(out[0].proxy, null);
  assert.equal(out[1].proxy, null);
  assert.equal(out[2].proxy, "http://1.2.3.4:8080");
  await unlink(p).catch(() => {});
});

test("loadAccounts: rejects non-array root", async () => {
  const p = resolve(tmpdir(), `acc-notarray-${Date.now()}.json`);
  await writeFile(p, JSON.stringify({ accounts: [] }));
  await assert.rejects(loadAccounts(p), /array/);
  await unlink(p).catch(() => {});
});
