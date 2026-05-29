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
