// Integration test: workspace-scoped lockNextAvailable.
// Account in workspace A must never lock a group in workspace B, even when
// only B-groups are AVAILABLE. Concurrent locks across workspaces must not
// deadlock or cross-contaminate.
//
// Skipped unless MYSQL_TEST_HOST / MYSQL_TEST_USER / MYSQL_TEST_DATABASE
// are set. Shares the test schema with groups-repo-race.int.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createPool, closePool, query, getPool } from "../src/db/pool.js";
import * as groupsRepo from "../src/db/repo/groups.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENV_KEYS = ["MYSQL_TEST_HOST", "MYSQL_TEST_USER", "MYSQL_TEST_DATABASE"];
const hasEnv = ENV_KEYS.every((k) => process.env[k]);

async function applyMigrations() {
  for (const file of ["001_init.sql", "002_workspace.sql"]) {
    const sql = await readFile(
      resolve(__dirname, `../src/db/migrations/${file}`),
      "utf8",
    );
    const stripped = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    // Single connection per file — session state (user vars, PREPARE) must
    // persist across the SET/PREPARE/EXECUTE/DEALLOCATE quartets in 002.
    const conn = await getPool().getConnection();
    try {
      for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
        await conn.query(stmt);
      }
    } finally {
      conn.release();
    }
  }
}

function buildConfig() {
  return {
    MYSQL_HOST: process.env.MYSQL_TEST_HOST,
    MYSQL_PORT: Number(process.env.MYSQL_TEST_PORT || 3306),
    MYSQL_USER: process.env.MYSQL_TEST_USER,
    MYSQL_PASSWORD: process.env.MYSQL_TEST_PASSWORD || "",
    MYSQL_DATABASE: process.env.MYSQL_TEST_DATABASE,
  };
}

async function resetTables() {
  await query("DELETE FROM deployments");
  await query("DELETE FROM `groups`");
  await query("DELETE FROM accounts");
}

async function seedAccount(name, workspace) {
  await query(
    "INSERT INTO accounts (name, api_key, enabled, workspace) VALUES (?, ?, ?, ?)",
    [name, "k", 1, workspace],
  );
  const rows = await query("SELECT id FROM accounts WHERE name = ?", [name]);
  return rows[0].id;
}

async function seedGroup(name, workspace) {
  await query(
    "INSERT INTO `groups` (name, branch, status, workspace) VALUES (?, ?, 'AVAILABLE', ?)",
    [name, `release/${name}`, workspace],
  );
}

test("integration: strict scoping — account in workspace A only locks A groups", { skip: !hasEnv && "MYSQL_TEST_* not set" }, async () => {
  createPool(buildConfig());
  await applyMigrations();
  await resetTables();

  const accountId = await seedAccount("acct-A", "ws_a");
  for (let i = 1; i <= 3; i++) await seedGroup(`ws_a_g_${i}`, "ws_a");
  for (let i = 1; i <= 2; i++) await seedGroup(`ws_b_g_${i}`, "ws_b");

  // Lock 3 times — must all be ws_a groups
  const locks = [];
  for (let i = 0; i < 3; i++) {
    locks.push(await groupsRepo.lockNextAvailable(accountId, String(2000 + i), 24, "ws_a"));
  }
  for (const g of locks) {
    assert.ok(g, "lock must succeed");
    assert.equal(g.workspace, "ws_a", `locked group must be ws_a, got ${g.workspace}`);
    assert.match(g.name, /^ws_a_g_/);
  }

  // 4th lock — no more ws_a AVAILABLE → null even though ws_b has 2 free
  const fourth = await groupsRepo.lockNextAvailable(accountId, "2999", 24, "ws_a");
  assert.equal(fourth, null, "must return null when no group in own workspace is free, ignoring foreign workspaces");

  // Confirm ws_b groups are untouched
  const wsbRows = await query("SELECT name, status FROM `groups` WHERE workspace = 'ws_b'");
  assert.equal(wsbRows.length, 2);
  for (const r of wsbRows) assert.equal(r.status, "AVAILABLE", "ws_b groups must remain AVAILABLE");

  await closePool();
});

test("integration: concurrent locks across workspaces don't cross-contaminate", { skip: !hasEnv && "MYSQL_TEST_* not set" }, async () => {
  createPool(buildConfig());
  await applyMigrations();
  await resetTables();

  const accountA = await seedAccount("acct-A2", "ws_a");
  const accountB = await seedAccount("acct-B2", "ws_b");
  for (let i = 1; i <= 4; i++) await seedGroup(`ws_a_g_${i}`, "ws_a");
  for (let i = 1; i <= 4; i++) await seedGroup(`ws_b_g_${i}`, "ws_b");

  // 4 A locks + 4 B locks fired concurrently
  const aPromises = Array.from({ length: 4 }, (_, i) =>
    groupsRepo.lockNextAvailable(accountA, `A${i}`, 24, "ws_a"),
  );
  const bPromises = Array.from({ length: 4 }, (_, i) =>
    groupsRepo.lockNextAvailable(accountB, `B${i}`, 24, "ws_b"),
  );
  const [aResults, bResults] = await Promise.all([
    Promise.all(aPromises),
    Promise.all(bPromises),
  ]);

  const aNames = aResults.map((r) => r?.name).filter(Boolean);
  const bNames = bResults.map((r) => r?.name).filter(Boolean);
  assert.equal(aNames.length, 4, "all 4 A locks must succeed");
  assert.equal(bNames.length, 4, "all 4 B locks must succeed");
  assert.equal(new Set(aNames).size, 4, "A locks must be distinct");
  assert.equal(new Set(bNames).size, 4, "B locks must be distinct");
  for (const n of aNames) assert.match(n, /^ws_a_g_/, `A account locked foreign group: ${n}`);
  for (const n of bNames) assert.match(n, /^ws_b_g_/, `B account locked foreign group: ${n}`);

  await closePool();
});

test("integration: empty workspace returns null", { skip: !hasEnv && "MYSQL_TEST_* not set" }, async () => {
  createPool(buildConfig());
  await applyMigrations();
  await resetTables();

  const accountId = await seedAccount("acct-v247", "validator247");
  for (let i = 1; i <= 3; i++) await seedGroup(`group_${i}`, "DEFAULT");

  const got = await groupsRepo.lockNextAvailable(accountId, "1", 24, "validator247");
  assert.equal(got, null, "must return null when workspace has zero groups");

  await closePool();
});
