// Verifies the PATCH request shape against console-api spec.
//   PATCH /v2/deployment-settings/{dseq}
//   body: { data: { autoTopUpEnabled: false } }
// Mocks fetch at the undici layer so no network is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

import { disableAutoTopUp } from "../src/akash.js";

function makeCtx() {
  return {
    account: { name: "tester", apiKey: "test-key", proxy: null },
    config: {
      AKASH_API_BASE: "https://console-api.akash.network",
      REQUEST_TIMEOUT_MS: 5000,
    },
  };
}

test("disableAutoTopUp: PATCHes /v2/deployment-settings/{dseq} with correct body + headers", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const pool = agent.get("https://console-api.akash.network");
  let capturedBody, capturedHeaders;
  pool.intercept({
    path: "/v2/deployment-settings/27041241",
    method: "PATCH",
  }).reply(200, (req) => {
    capturedBody = req.body;
    capturedHeaders = req.headers;
    return { data: { autoTopUpEnabled: false } };
  });

  const result = await disableAutoTopUp(makeCtx(), "27041241");
  assert.deepEqual(result, { autoTopUpEnabled: false });
  assert.deepEqual(JSON.parse(capturedBody), { data: { autoTopUpEnabled: false } });
  // Header keys are case-insensitive in undici mock; check both spellings.
  const apiKey = capturedHeaders["x-api-key"] ?? capturedHeaders["X-Api-Key"];
  assert.equal(apiKey, "test-key");

  await agent.close();
});

test("disableAutoTopUp: dseq with special chars is URL-encoded", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const pool = agent.get("https://console-api.akash.network");
  pool.intercept({
    path: "/v2/deployment-settings/abc%2Fdef",
    method: "PATCH",
  }).reply(200, { data: {} });

  await disableAutoTopUp(makeCtx(), "abc/def");
  await agent.close();
});

test("disableAutoTopUp: non-2xx surfaces as AkashApiError", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const pool = agent.get("https://console-api.akash.network");
  pool.intercept({
    path: "/v2/deployment-settings/999",
    method: "PATCH",
  }).reply(404, { error: "not_found" });

  await assert.rejects(
    disableAutoTopUp(makeCtx(), "999"),
    (err) => err.name === "AkashApiError" && err.status === 404,
  );
  await agent.close();
});
