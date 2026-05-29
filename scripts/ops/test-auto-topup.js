// Manual smoke test: verify the PATCH /v2/deployment-settings/{dseq} body
// shape against the live Akash console-api before relying on it in prod.
//
// Usage:
//   node scripts/ops/test-auto-topup.js <accountName> <dseq>
//
// Expected outcomes:
//   200/204 with autoTopUpEnabled=false → request shape confirmed
//   400 invalid field                   → swap body to flat {autoTopUpEnabled:false} in src/akash.js
//   404 not found                       → endpoint path needs adjusting (try /v1/?)
//
// Pre-req: the account must have a LEASED or PUT_OK deployment with the given
// dseq. Use the admin API (GET /v1/deployments) or mysql to find one.

import "dotenv/config";
import { loadConfig } from "../../src/config.js";
import { loadAccountsFromDb } from "../../src/accounts-loader.js";
import { disableAutoTopUp } from "../../src/akash.js";
import { createPool, closePool } from "../../src/db/pool.js";

const [accountName, dseq] = process.argv.slice(2);
if (!accountName || !dseq) {
  console.error("usage: node scripts/ops/test-auto-topup.js <accountName> <dseq>");
  process.exit(2);
}

const config = loadConfig();
createPool(config);

try {
  const accounts = await loadAccountsFromDb();
  const account = accounts.find((a) => a.name === accountName);
  if (!account) {
    console.error(`no account named "${accountName}" — known: ${accounts.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`[smoke] PATCH /v2/deployment-settings/${dseq} as ${account.name} ...`);
  const start = Date.now();
  const body = await disableAutoTopUp({ account, config }, dseq);
  console.log(`[ok] ${Date.now() - start}ms — response:`);
  console.log(JSON.stringify(body, null, 2));
} catch (err) {
  console.error(`[fail] ${err.name}: ${err.message}`);
  if (err.body) console.error("body:", JSON.stringify(err.body, null, 2));
  process.exitCode = 1;
} finally {
  await closePool();
}
