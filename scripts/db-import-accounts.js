// One-shot import of accounts.json into the accounts table. Idempotent on
// name. Reuses loadAccounts() validator from src/accounts-loader.js so
// duplicate/missing-key checks stay consistent.

import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadAccounts } from "../src/accounts-loader.js";
import { createPool, closePool } from "../src/db/pool.js";
import * as accountsRepo from "../src/db/repo/accounts.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  createPool(config);

  let parsed;
  try {
    parsed = await loadAccounts(resolve(config.ACCOUNTS_PATH));
  } catch (err) {
    console.error(`[import-accounts] cannot read ${config.ACCOUNTS_PATH}: ${err.message}`);
    process.exit(1);
  }

  let inserted = 0, skipped = 0;
  for (const a of parsed) {
    const existing = await accountsRepo.getByName(a.name);
    if (existing) { skipped++; continue; }
    if (dryRun) { inserted++; continue; }
    await accountsRepo.insert({ name: a.name, apiKey: a.apiKey, proxy: a.proxy, enabled: true });
    inserted++;
  }

  console.log(`[import-accounts] source=${config.ACCOUNTS_PATH}`);
  console.log(`[import-accounts] found=${parsed.length} ${dryRun ? "would-insert" : "inserted"}=${inserted} skipped=${skipped}`);
  await closePool();
}

main().catch(async (err) => {
  console.error("[import-accounts] failed:", err.message);
  await closePool();
  process.exit(1);
});
