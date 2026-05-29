// One-shot ops utility: close given (account, dseq) leases on Akash and
// release the matching local DB rows + group locks. Edit TARGETS before use.
// Usage: node scripts/ops/close-test-leases.js
import "dotenv/config";
import { loadConfig } from "../../src/config.js";
import { loadAccountsFromDb } from "../../src/accounts-loader.js";
import { closeDeployment } from "../../src/akash.js";
import { createPool, query, closePool } from "../../src/db/pool.js";

const TARGETS = [
  { accountName: "cherryvalidator", dseq: "27041240", group: "group_01_vast_ai" },
  { accountName: "mommeus",         dseq: "27041241", group: "group_02_m79" },
  { accountName: "toanbkvn3",       dseq: "27041241", group: "group_03_b100" },
  { accountName: "somewhere",       dseq: "27041243", group: "group_04_b100" },
];

const config = loadConfig();
createPool(config);
const accounts = await loadAccountsFromDb();
const byName = new Map(accounts.map((a) => [a.name, a]));

for (const t of TARGETS) {
  const account = byName.get(t.accountName);
  if (!account) {
    console.log(`[skip] no account row for ${t.accountName}`);
    continue;
  }
  const ctx = { account, config };
  try {
    await closeDeployment(ctx, t.dseq);
    console.log(`[ok]   DELETE /v1/deployments/${t.dseq} (${t.accountName})`);
    await query(
      "UPDATE deployments SET status='CLOSED' WHERE dseq=? AND account_id=?",
      [t.dseq, account.id],
    );
    await query(
      "UPDATE `groups` SET status='AVAILABLE', locked_by_account_id=NULL, locked_dseq=NULL, locked_at=NULL, expires_at=NULL, last_nag_at=NULL WHERE name=?",
      [t.group],
    );
    console.log(`       released group ${t.group}`);
  } catch (err) {
    console.error(`[fail] ${t.accountName} dseq=${t.dseq}: ${err.message}`);
  }
}

await closePool();
