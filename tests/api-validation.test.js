// Router + body parser unit tests. Avoids the DB by exercising the parts
// that don't require repos: route matching, JSON body limits, content-type.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { match } from "../src/api/router.js";
import { parseJsonBody, HttpError } from "../src/api/json-body.js";

test("router: matches groups list and capture name param", () => {
  const r = match("GET", "/v1/groups");
  assert.ok(r);
  assert.deepEqual(r.params, []);
  const r2 = match("GET", "/v1/groups/group_01_vast_ai");
  assert.ok(r2);
  assert.equal(r2.params[0], "group_01_vast_ai");
});

test("router: release endpoint matches before generic group GET", () => {
  const r = match("POST", "/v1/groups/group_01_vast_ai/release");
  assert.ok(r);
  assert.equal(r.params[0], "group_01_vast_ai");
});

test("router: accounts require numeric id", () => {
  assert.ok(match("GET", "/v1/accounts/42"));
  assert.equal(match("GET", "/v1/accounts/abc"), null);
});

test("router: returns null for unknown path", () => {
  assert.equal(match("GET", "/nope"), null);
  assert.equal(match("PATCH", "/v1/groups"), null);
});

test("router: health endpoint", () => {
  assert.ok(match("GET", "/health"));
});

function buildMockReq(body, headers = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.headers = headers;
  return stream;
}

test("parseJsonBody: parses valid JSON", async () => {
  const req = buildMockReq('{"a":1}', { "content-type": "application/json" });
  const parsed = await parseJsonBody(req);
  assert.deepEqual(parsed, { a: 1 });
});

test("parseJsonBody: returns null on empty body", async () => {
  const req = buildMockReq("", {});
  const parsed = await parseJsonBody(req);
  assert.equal(parsed, null);
});

test("parseJsonBody: 415 on wrong content-type", async () => {
  const req = buildMockReq("hello", { "content-type": "text/plain" });
  await assert.rejects(() => parseJsonBody(req), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 415);
    return true;
  });
});

test("parseJsonBody: 400 on invalid JSON", async () => {
  const req = buildMockReq("not json", { "content-type": "application/json" });
  await assert.rejects(() => parseJsonBody(req), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, "INVALID_JSON");
    return true;
  });
});

test("parseJsonBody: 413 on oversized body", async () => {
  const big = "x".repeat(150 * 1024);
  const req = buildMockReq(big, { "content-type": "application/json" });
  await assert.rejects(() => parseJsonBody(req), (err) => {
    assert.equal(err.status, 413);
    return true;
  });
});

// Full server end-to-end is exercised by the curl examples in
// docs/api-examples.md against a live MySQL — kept out of the unit suite
// to avoid pool/listener cleanup brittleness.
