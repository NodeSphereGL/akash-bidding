// Idempotent migration runner. Reads all src/db/migrations/*.sql sorted by
// filename, splits on semicolons (statement terminator), executes each via the
// pool. No tracking table — relies on CREATE TABLE IF NOT EXISTS in scripts.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { createPool, closePool, getPool } from "../src/db/pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = resolve(__dirname, "../src/db/migrations");

function splitStatements(sql) {
  // Strip line comments, then split on ; at top level. SQL strings in our
  // migrations don't contain ; so a naive split is acceptable here.
  const stripped = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  const config = loadConfig();
  createPool(config);
  const pool = getPool();

  const files = (await readdir(MIG_DIR)).filter((f) => f.endsWith(".sql")).sort();
  console.log(`[migrate] dir=${MIG_DIR} files=${files.length}`);
  for (const file of files) {
    const path = join(MIG_DIR, file);
    const sql = await readFile(path, "utf8");
    const stmts = splitStatements(sql);
    console.log(`[migrate] applying ${file} (${stmts.length} stmt(s))`);
    for (const stmt of stmts) {
      await pool.query(stmt);
    }
  }
  console.log("[migrate] done");
  await closePool();
}

main().catch(async (err) => {
  console.error("[migrate] failed:", err.message);
  if (err.cause) console.error("  cause:", err.cause.message);
  await closePool();
  process.exit(1);
});
