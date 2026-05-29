// Scans a groups-source directory and inserts each matching subdir as a row.
// Idempotent — existing names skipped. Operator script, not a daemon runtime
// concern, so the source dir is supplied per-invocation:
//
//   npm run db:seed-groups -- --dir=/path/to/rpow2/data
//   RPOW2_DATA_DIR=/path/to/rpow2/data npm run db:seed-groups
//
// `--dry-run` prints the plan without writes.

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { createPool, closePool } from "../src/db/pool.js";
import * as groupsRepo from "../src/db/repo/groups.js";

const GROUP_RE = /^(group_\d+|v247_group_\d+)/i;

function getDir() {
  const flag = process.argv.find((a) => a.startsWith("--dir="));
  if (flag) return resolve(flag.slice("--dir=".length));
  if (process.env.RPOW2_DATA_DIR) return resolve(process.env.RPOW2_DATA_DIR);
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const dir = getDir();
  if (!dir) {
    console.error("[seed-groups] source dir required. Pass --dir=/path or set RPOW2_DATA_DIR env.");
    process.exit(2);
  }
  const config = loadConfig();
  createPool(config);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[seed-groups] cannot read ${dir}: ${err.message}`);
    process.exit(1);
  }

  const names = entries
    .filter((e) => e.isDirectory() && GROUP_RE.test(e.name))
    .map((e) => e.name)
    .sort();

  let inserted = 0, skipped = 0;
  const v247Warns = [];
  for (const name of names) {
    if (name.startsWith("v247_")) v247Warns.push(name);
    if (dryRun) {
      const existing = await groupsRepo.get(name);
      if (existing) skipped++; else inserted++;
      continue;
    }
    const existing = await groupsRepo.get(name);
    if (existing) { skipped++; continue; }
    await groupsRepo.insert({ name, branch: `release/${name}`, status: "AVAILABLE" });
    inserted++;
  }

  console.log(`[seed-groups] dir=${dir}`);
  console.log(`[seed-groups] found=${names.length} ${dryRun ? "would-insert" : "inserted"}=${inserted} skipped=${skipped}`);
  if (v247Warns.length > 0) {
    console.warn(`[seed-groups] WARN ${v247Warns.length} v247_* rows — review and DISABLE any non-runnable ones via PUT /v1/groups/:name {status:DISABLED}`);
    for (const n of v247Warns) console.warn(`  - ${n}`);
  }
  await closePool();
}

main().catch(async (err) => {
  console.error("[seed-groups] failed:", err.message);
  await closePool();
  process.exit(1);
});
