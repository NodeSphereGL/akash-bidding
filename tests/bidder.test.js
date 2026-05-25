import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { filterAndRank, extractGpuModel, isBlacklisted } from "../src/bidder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures/bids-sample.json");

const baseConfig = {
  gpuBlacklist: ["a100", "pro6000se", "h100"],
  maxUactPerBlock: 100000,
};

test("filterAndRank: empty input returns empty array", () => {
  assert.deepEqual(filterAndRank([], baseConfig), []);
});

test("filterAndRank: drops non-open state bids", async () => {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const closed = raw.filter((b) => b.state === "closed");
  assert.ok(closed.length > 0, "fixture must include at least one closed bid");
  const out = filterAndRank(raw, baseConfig);
  assert.ok(out.every((c) => c.bid.state === "open"));
});

test("filterAndRank: drops blacklisted GPU models (substring, case-insensitive)", async () => {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const out = filterAndRank(raw, baseConfig);
  for (const c of out) {
    assert.ok(!c.model.includes("a100"), `${c.model} should be dropped`);
    assert.ok(!c.model.includes("h100"), `${c.model} should be dropped`);
    assert.ok(!c.model.includes("pro6000se"), `${c.model} should be dropped`);
  }
});

test("filterAndRank: drops bids over MAX_UACT_PER_BLOCK", async () => {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const out = filterAndRank(raw, baseConfig);
  for (const c of out) {
    assert.ok(c.uactPerBlock <= baseConfig.maxUactPerBlock);
  }
});

test("filterAndRank: cap boundary — bid at exactly MAX is INCLUDED, +1 excluded", () => {
  const bids = [
    mkBid("p1", "rtx4090", 100000),
    mkBid("p2", "rtx4080", 100001),
  ];
  const out = filterAndRank(bids, baseConfig);
  assert.equal(out.length, 1);
  assert.equal(out[0].uactPerBlock, 100000);
});

test("filterAndRank: sorts DESC by uactPerBlock", async () => {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const out = filterAndRank(raw, baseConfig);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].uactPerBlock >= out[i].uactPerBlock);
  }
});

test("filterAndRank: drops bids with null GPU model without throwing", () => {
  const bids = [
    { provider: "p1", state: "open", price: { amount: "70000" }, resources_offer: [{ resources: {} }] },
    mkBid("p2", "rtx3090", 60000),
  ];
  const out = filterAndRank(bids, baseConfig);
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, "p2");
});

test("filterAndRank: throws on invalid maxUactPerBlock", () => {
  assert.throws(() => filterAndRank([], { ...baseConfig, maxUactPerBlock: 0 }));
  assert.throws(() => filterAndRank([], { ...baseConfig, maxUactPerBlock: NaN }));
});

test("extractGpuModel: handles array attribute form", () => {
  const bid = {
    resources_offer: [{ resources: { gpu: { attributes: [{ key: "model", value: "NVIDIA-A100-SXM4" }] } } }],
  };
  assert.equal(extractGpuModel(bid), "nvidia-a100-sxm4");
});

test("extractGpuModel: handles map attribute form", () => {
  const bid = {
    resources_offer: [{ resources: { gpu: { attributes: { model: "NVIDIA-H100-PCIE" } } } }],
  };
  assert.equal(extractGpuModel(bid), "nvidia-h100-pcie");
});

test("extractGpuModel: handles key-encoded model", () => {
  const bid = {
    resources_offer: [{ resources: { gpu: { attributes: [{ key: "vendor/nvidia/model/pro6000se", value: "" }] } } }],
  };
  assert.equal(extractGpuModel(bid), "pro6000se");
});

test("extractGpuModel: returns null on missing GPU block", () => {
  assert.equal(extractGpuModel({}), null);
  assert.equal(extractGpuModel(null), null);
});

test("extractGpuModel: does NOT pick non-model attributes (e.g. vendor, interface)", () => {
  const bid = {
    resources_offer: [{
      resources: { gpu: { attributes: [
        { key: "vendor", value: "nvidia" },
        { key: "interface", value: "pcie" },
      ] } },
    }],
  };
  assert.equal(extractGpuModel(bid), null);
});

test("isBlacklisted: substring case-insensitive", () => {
  assert.equal(isBlacklisted("nvidia-a100-sxm4", ["a100"]), true);
  assert.equal(isBlacklisted("nvidia-rtx4090", ["a100", "h100"]), false);
  assert.equal(isBlacklisted("nvidia-h100-pcie", ["h100"]), true);
});

function mkBid(provider, model, amount, state = "open") {
  return {
    id: { owner: "o", dseq: "1", gseq: 1, oseq: 1, provider, bseq: 1 },
    state,
    price: { amount: String(amount), denom: "uact" },
    resources_offer: [{ resources: { gpu: { attributes: [{ key: "model", value: model }] } } }],
  };
}
