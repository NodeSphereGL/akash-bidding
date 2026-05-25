import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createLogger } from "../src/logger.js";

test("logger: writes valid JSONL with timestamp + level + event", async () => {
  const path = resolve(tmpdir(), `log-${Date.now()}-${Math.random()}.log`);
  const log = createLogger(path);
  log.info("cycle.start", { dseq: "1234" });
  log.warn("proxy.fallback", { account: "a" });
  log.error("crash", { reason: "x" });
  await new Promise((r) => setTimeout(r, 50));

  const content = await readFile(path, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 3);
  for (const ln of lines) {
    const obj = JSON.parse(ln);
    assert.ok(obj.ts);
    assert.ok(obj.level);
    assert.ok(obj.event);
  }
  await unlink(path).catch(() => {});
});

test("logger: child() merges base fields into every call", async () => {
  const path = resolve(tmpdir(), `log-child-${Date.now()}-${Math.random()}.log`);
  const log = createLogger(path);
  const scoped = log.child({ account: "trial-1" });
  scoped.info("cycle.start", { dseq: "1" });
  scoped.info("cycle.end", { leased: true });
  await new Promise((r) => setTimeout(r, 50));

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  for (const ln of lines) {
    const obj = JSON.parse(ln);
    assert.equal(obj.account, "trial-1");
  }
  await unlink(path).catch(() => {});
});

test("logger: no file path → stdout-only without throwing", () => {
  const log = createLogger(null);
  log.info("noop", {});
});

test("logger: drain() flushes pending writes synchronously after await", async () => {
  const { readFileSync } = await import("node:fs");
  const path = resolve(tmpdir(), `log-drain-${Date.now()}-${Math.random()}.log`);
  const log = createLogger(path);
  log.info("burst", { i: 1 });
  log.info("burst", { i: 2 });
  log.info("burst", { i: 3 });
  await log.drain();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  await unlink(path).catch(() => {});
});
