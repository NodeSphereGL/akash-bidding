// SDL injection: pure-fn correctness + immutability of the loaded template.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as sdl from "../src/sdl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(__dirname, "../akash-deploy.yaml");

test("sdl: loadTemplate parses and exposes the rpow service", async () => {
  const t = await sdl.loadTemplate(TEMPLATE);
  assert.ok(t.raw.includes("toanbk/rpow2:v3"), "raw must include image");
  assert.ok(t.parsed.services["service-rpow"], "parsed must expose service-rpow");
});

test("sdl: injectGroupName produces YAML containing exact GROUP_NAME=<name> and image", async () => {
  const t = await sdl.loadTemplate(TEMPLATE);
  const out = sdl.injectGroupName(t, "group_01_vast_ai");
  assert.match(out, /GROUP_NAME=group_01_vast_ai/);
  assert.match(out, /toanbk\/rpow2:v3/);
});

test("sdl: injectGroupName is pure — template not mutated across multiple calls", async () => {
  const t = await sdl.loadTemplate(TEMPLATE);
  const beforeEnv = JSON.parse(JSON.stringify(t.parsed.services["service-rpow"].env));
  const out1 = sdl.injectGroupName(t, "group_01_vast_ai");
  const out2 = sdl.injectGroupName(t, "group_02_m79");
  const afterEnv = JSON.parse(JSON.stringify(t.parsed.services["service-rpow"].env));
  assert.deepEqual(beforeEnv, afterEnv, "template env array must not change");
  assert.match(out1, /GROUP_NAME=group_01_vast_ai/);
  assert.match(out2, /GROUP_NAME=group_02_m79/);
});

test("sdl: injectGroupName rejects missing groupName", async () => {
  const t = await sdl.loadTemplate(TEMPLATE);
  assert.throws(() => sdl.injectGroupName(t, ""), /groupName required/);
  assert.throws(() => sdl.injectGroupName(t, null), /groupName required/);
});

test("sdl: loadTemplate rejects template missing service-rpow", async () => {
  const bogusPath = resolve(__dirname, "fixtures/bids-sample.json");
  await assert.rejects(() => sdl.loadTemplate(bogusPath), /service-rpow missing/);
});
