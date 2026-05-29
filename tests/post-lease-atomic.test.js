// postLeaseAtomic guarantees: either both the deployments insert AND the
// group lock succeed, or neither does. Verifies the wired-up flow without
// hitting a real DB by stubbing withTx.

import test from "node:test";
import assert from "node:assert/strict";

// We need to stub withTx before the SUT imports it. Easiest path: import the
// SUT once, then replace the repo methods on the args object per-test, while
// stubbing the pool module via a side-by-side test harness.
//
// Lightweight harness: import withTx by intercepting at the repo layer. Both
// repos accept an optional conn arg. We never actually need a real conn here
// because we stub the repo methods themselves; we only need to verify the
// invocation order and rollback semantics.

import { postLeaseAtomic } from "../src/post-lease.js";
import { NoGroupAvailableError } from "../src/errors.js";

// Fake withTx — injected per-test. Records whether the tx committed (callback
// returned without throwing) so tests can assert rollback semantics.
let lastTxCommitted;
function makeFakeTx() {
  const fakeConn = { __fake: true };
  return async (fn) => {
    lastTxCommitted = false;
    const result = await fn(fakeConn);
    lastTxCommitted = true;
    return result;
  };
}

const baseArgs = () => ({
  dseq: "27041241",
  account: { id: 4, name: "toanbkvn3", workspace: "DEFAULT" },
  leaseResult: { bid: { provider: "akash1prov", uactPerBlock: 25 } },
  hours: 24,
  now: new Date("2026-05-29T15:46:00Z"),
  expiresAt: new Date("2026-05-30T15:46:00Z"),
});

test("postLeaseAtomic: happy path commits insert + lock and returns group", async () => {
  const withTx = makeFakeTx();
  const calls = [];
  const db = {
    deploymentsRepo: {
      insert: async (fields, conn) => {
        assert.ok(conn?.__fake, "insert must receive the tx conn");
        calls.push(["insert", fields.dseq, fields.accountId]);
      },
    },
    groupsRepo: {
      lockNextAvailable: async (accountId, dseq, hours, workspace, conn) => {
        assert.ok(conn?.__fake, "lockNextAvailable must receive the tx conn");
        calls.push(["lock", accountId, dseq, workspace]);
        return { name: "group_03_b100", status: "LOCKED" };
      },
    },
  };

  const r = await postLeaseAtomic({ ...baseArgs(), db, withTx });
  assert.equal(r.group.name, "group_03_b100");
  assert.deepEqual(calls, [
    ["insert", "27041241", 4],
    ["lock", 4, "27041241", "DEFAULT"],
  ]);
  assert.equal(lastTxCommitted, true);
});

test("postLeaseAtomic: insert throws → lockNextAvailable NOT called, tx rolls back", async () => {
  const withTx = makeFakeTx();
  let lockCalled = false;
  const db = {
    deploymentsRepo: {
      insert: async () => { throw new Error("duplicate dseq"); },
    },
    groupsRepo: {
      lockNextAvailable: async () => { lockCalled = true; return { name: "x" }; },
    },
  };

  await assert.rejects(postLeaseAtomic({ ...baseArgs(), db, withTx }), /duplicate dseq/);
  assert.equal(lockCalled, false);
  assert.equal(lastTxCommitted, false);
});

test("postLeaseAtomic: no available group → NoGroupAvailableError + rollback", async () => {
  const withTx = makeFakeTx();
  let insertCalled = false;
  const db = {
    deploymentsRepo: {
      insert: async () => { insertCalled = true; },
    },
    groupsRepo: {
      lockNextAvailable: async () => null,
    },
  };

  await assert.rejects(
    postLeaseAtomic({ ...baseArgs(), db, withTx }),
    (err) => err instanceof NoGroupAvailableError && err.workspace === "DEFAULT",
  );
  assert.equal(insertCalled, true, "insert ran before lock check");
  assert.equal(lastTxCommitted, false, "rollback so inserted row is undone");
});
