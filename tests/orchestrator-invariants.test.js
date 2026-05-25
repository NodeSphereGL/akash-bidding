// Pin orchestration invariants the per-account-loop refactor must preserve.
// Asserts OUTPUTS / event shapes / notifier shape — not internal call order.
// Phase 1 of plan: 260525-1700-per-account-concurrent-loops.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { filterAndRank } from "../src/bidder.js";
import * as notify from "../src/notify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures/bids-sample.json");

test("orchestrator-invariants: bidder dataflow yields top-priced bid first", async () => {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const candidates = filterAndRank(raw, {
    gpuBlacklist: ["a100", "pro6000se", "h100"],
    maxUactPerBlock: 100000,
  });
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(
      candidates[i - 1].uactPerBlock >= candidates[i].uactPerBlock,
      "fallback list must be DESC by uactPerBlock",
    );
  }
});

test("orchestrator-invariants: notify.notifyLeaseSuccess returns false silently when telegram unconfigured", async () => {
  const result = await notify.notifyLeaseSuccess(
    {
      bid: { model: "rtx4090", uactPerBlock: 1234, provider: "p" },
      lease: { id: "L1", dseq: "1" },
      account: { name: "alpha" },
    },
    { botToken: "", chatId: "", logger: { warn: () => {} } },
  );
  assert.equal(result, false);
});

test("orchestrator-invariants: notify.notifyAuthFail returns false silently when telegram unconfigured", async () => {
  const result = await notify.notifyAuthFail({ name: "alpha" }, { botToken: "", chatId: "" });
  assert.equal(result, false);
});

test("orchestrator-invariants: notify.notifyAllDepleted returns false silently when telegram unconfigured", async () => {
  const result = await notify.notifyAllDepleted(3, { botToken: "", chatId: "" });
  assert.equal(result, false);
});

