// Integration test: N concurrent lockNextAvailable() against a real MySQL
// must yield N distinct group names (no double-lock under load).
//
// Skipped unless MYSQL_TEST_HOST / MYSQL_TEST_USER / MYSQL_TEST_DATABASE
// are set. Uses a separate test schema; truncates `groups` before the run.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPool, closePool, query, getPool } from "../src/db/pool.js";
import * as groupsRepo from "../src/db/repo/groups.js";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENV_KEYS = ["MYSQL_TEST_HOST", "MYSQL_TEST_USER", "MYSQL_TEST_DATABASE"];
const hasEnv = ENV_KEYS.every((k) => process.env[k]);

test("integration: 5 concurrent lockNextAvailable calls return 5 distinct group names", { skip: !hasEnv && "MYSQL_TEST_* not set" }, async () => {
  const config = {
    MYSQL_HOST: process.env.MYSQL_TEST_HOST,
    MYSQL_PORT: Number(process.env.MYSQL_TEST_PORT || 3306),
    MYSQL_USER: process.env.MYSQL_TEST_USER,
    MYSQL_PASSWORD: process.env.MYSQL_TEST_PASSWORD || "",
    MYSQL_DATABASE: process.env.MYSQL_TEST_DATABASE,
  };
  createPool(config);

  // Apply migrations (idempotent). Strip comment lines first so they don't
  // get glued onto the first statement. Bind each file to one connection so
  // PREPARE/EXECUTE + user-variable guards survive across statements.
  for (const file of ["001_init.sql", "002_workspace.sql"]) {
    const sql = await readFile(
      resolve(__dirname, `../src/db/migrations/${file}`),
      "utf8",
    );
    const stripped = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const conn = await getPool().getConnection();
    try {
      for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
        await conn.query(stmt);
      }
    } finally {
      conn.release();
    }
  }

  await query("DELETE FROM deployments");
  await query("DELETE FROM `groups`");
  await query("DELETE FROM accounts");

  // Seed an account so FK works for lock.
  await query("INSERT INTO accounts (name, api_key, enabled) VALUES (?, ?, ?)", ["int-test", "k", 1]);
  const accountRows = await query("SELECT id FROM accounts WHERE name = 'int-test'");
  const accountId = accountRows[0].id;

  // Seed 5 groups.
  for (let i = 1; i <= 5; i++) {
    await query("INSERT INTO `groups` (name, branch, status) VALUES (?, ?, 'AVAILABLE')", [`g_${i}`, `release/g_${i}`]);
  }

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      groupsRepo.lockNextAvailable(accountId, String(1000 + i), 24, "DEFAULT"),
    ),
  );

  const names = results.map((r) => r?.name).filter(Boolean);
  assert.equal(names.length, 5, "all 5 locks must succeed");
  assert.equal(new Set(names).size, 5, `must be 5 distinct, got ${JSON.stringify(names)}`);

  // 6th call → no AVAILABLE → null.
  const sixth = await groupsRepo.lockNextAvailable(accountId, "9999", 24, "DEFAULT");
  assert.equal(sixth, null, "6th lock must return null");

  await closePool();
});

test("integration: lockNextAvailablePending leaves locked_dseq NULL with short TTL; bindLockToDseq promotes", { skip: !hasEnv && "MYSQL_TEST_* not set" }, async () => {
  const config = {
    MYSQL_HOST: process.env.MYSQL_TEST_HOST,
    MYSQL_PORT: Number(process.env.MYSQL_TEST_PORT || 3306),
    MYSQL_USER: process.env.MYSQL_TEST_USER,
    MYSQL_PASSWORD: process.env.MYSQL_TEST_PASSWORD || "",
    MYSQL_DATABASE: process.env.MYSQL_TEST_DATABASE,
  };
  createPool(config);

  for (const file of ["001_init.sql", "002_workspace.sql"]) {
    const sql = await readFile(
      resolve(__dirname, `../src/db/migrations/${file}`),
      "utf8",
    );
    const stripped = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const conn = await getPool().getConnection();
    try {
      for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
        await conn.query(stmt);
      }
    } finally {
      conn.release();
    }
  }

  await query("DELETE FROM deployments");
  await query("DELETE FROM `groups`");
  await query("DELETE FROM accounts");

  await query("INSERT INTO accounts (name, api_key, enabled) VALUES (?, ?, ?)", ["int-test-pending", "k", 1]);
  const accountRows = await query("SELECT id FROM accounts WHERE name = 'int-test-pending'");
  const accountId = accountRows[0].id;

  await query("INSERT INTO `groups` (name, branch, status) VALUES (?, ?, 'AVAILABLE')", ["pg_1", "release/pg_1"]);
  await query("INSERT INTO `groups` (name, branch, status) VALUES (?, ?, 'AVAILABLE')", ["pg_2", "release/pg_2"]);

  // 1. lockNextAvailablePending: picks ASC, leaves dseq NULL, short TTL.
  const locked = await groupsRepo.lockNextAvailablePending(accountId, "DEFAULT", 10);
  assert.equal(locked?.name, "pg_1");
  assert.equal(locked?.status, "LOCKED");
  assert.equal(locked?.locked_dseq, null, "locked_dseq must remain NULL during pending");
  assert.equal(locked?.locked_by_account_id, accountId);
  const expiresMs = new Date(locked.expires_at).getTime();
  const lockedAtMs = new Date(locked.locked_at).getTime();
  const ttlMin = (expiresMs - lockedAtMs) / 60000;
  assert.ok(ttlMin >= 9 && ttlMin <= 11, `pending TTL must be ~10min, got ${ttlMin}min`);

  // 2. bindLockToDseq: promotes pending → full lock with dseq + 24h TTL.
  const promoted = await groupsRepo.bindLockToDseq("pg_1", "27000001", 24);
  assert.equal(promoted?.locked_dseq, "27000001");
  const newExpiresMs = new Date(promoted.expires_at).getTime();
  const newTtlHours = (newExpiresMs - Date.now()) / 3600_000;
  assert.ok(newTtlHours >= 23 && newTtlHours <= 25, `full TTL must be ~24h, got ${newTtlHours}h`);

  // 3. bindLockToDseq on already-bound row → throws.
  await assert.rejects(
    groupsRepo.bindLockToDseq("pg_1", "27000002", 24),
    /not in pending state/,
  );

  // 4. lockNextAvailablePending workspace scoping: pg_1 locked, pg_2 still picks.
  const second = await groupsRepo.lockNextAvailablePending(accountId, "DEFAULT", 10);
  assert.equal(second?.name, "pg_2");

  // 5. No more AVAILABLE → null.
  const third = await groupsRepo.lockNextAvailablePending(accountId, "DEFAULT", 10);
  assert.equal(third, null);

  await closePool();
});

test("integration: N concurrent lockNextAvailablePending calls return N distinct names", { skip: !hasEnv && "MYSQL_TEST_* not set" }, async () => {
  const config = {
    MYSQL_HOST: process.env.MYSQL_TEST_HOST,
    MYSQL_PORT: Number(process.env.MYSQL_TEST_PORT || 3306),
    MYSQL_USER: process.env.MYSQL_TEST_USER,
    MYSQL_PASSWORD: process.env.MYSQL_TEST_PASSWORD || "",
    MYSQL_DATABASE: process.env.MYSQL_TEST_DATABASE,
  };
  createPool(config);

  for (const file of ["001_init.sql", "002_workspace.sql"]) {
    const sql = await readFile(
      resolve(__dirname, `../src/db/migrations/${file}`),
      "utf8",
    );
    const stripped = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const conn = await getPool().getConnection();
    try {
      for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
        await conn.query(stmt);
      }
    } finally {
      conn.release();
    }
  }

  await query("DELETE FROM deployments");
  await query("DELETE FROM `groups`");
  await query("DELETE FROM accounts");

  await query("INSERT INTO accounts (name, api_key, enabled) VALUES (?, ?, ?)", ["int-test-race", "k", 1]);
  const accountRows = await query("SELECT id FROM accounts WHERE name = 'int-test-race'");
  const accountId = accountRows[0].id;

  for (let i = 1; i <= 4; i++) {
    await query("INSERT INTO `groups` (name, branch, status) VALUES (?, ?, 'AVAILABLE')", [`pr_${i}`, `release/pr_${i}`]);
  }

  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      groupsRepo.lockNextAvailablePending(accountId, "DEFAULT", 10),
    ),
  );
  const names = results.map((r) => r?.name).filter(Boolean);
  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4, `must be 4 distinct, got ${JSON.stringify(names)}`);

  const fifth = await groupsRepo.lockNextAvailablePending(accountId, "DEFAULT", 10);
  assert.equal(fifth, null);

  await closePool();
});
