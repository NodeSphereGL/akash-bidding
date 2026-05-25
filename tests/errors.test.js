import { test } from "node:test";
import assert from "node:assert/strict";
import { AkashApiError } from "../src/errors.js";

test("AkashApiError: redacts sensitive keys in body", () => {
  const err = new AkashApiError(401, "unauthorized", {
    message: "bad key",
    "x-api-key": "ak_secretvalue",
    authorization: "Bearer abc",
    nested: { token: "leak", normal: "ok" },
  });
  assert.equal(err.body["x-api-key"], "[redacted]");
  assert.equal(err.body.authorization, "[redacted]");
  assert.equal(err.body.nested.token, "[redacted]");
  assert.equal(err.body.nested.normal, "ok");
  assert.equal(err.body.message, "bad key");
});

test("AkashApiError: truncates oversize string body", () => {
  const huge = "x".repeat(5000);
  const err = new AkashApiError(500, "boom", huge);
  assert.ok(err.body.length < 5000);
  assert.ok(err.body.endsWith("…"));
});

test("AkashApiError: tolerates null body", () => {
  const err = new AkashApiError(500, "boom", null);
  assert.equal(err.body, null);
});
