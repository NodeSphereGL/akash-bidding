#!/usr/bin/env node
// Reconcile live console-api deployment state into the local `deployments`
// table. Per-account fetch + simple upsert.
//
// Filter: only deployments with a non-empty `leases` array — a deployment
// without a lease is not consuming a managed-wallet position and there's
// nothing for the daemon to manage. The bidder will pick those up in its
// normal cycle.
//
// Uniqueness: (account_id, dseq) — the schema's existing UNIQUE key. If two
// api-keys see the same wallet's deployment, each gets its own row. That's
// by design: each row represents "this api-key can manage this deployment".
//
// expires_at = (lease/deployment block-height converted via chain anchor) +
// GROUP_LOCK_HOURS. Rows missing a parseable created_at are skipped with a
// warning so we never inherit a wrong expiry.
//
// Usage:
//   node scripts/ops/sync-live-deployments.js [--dry-run] [--account=NAME] [--limit=N]

import "dotenv/config";
import { fetch } from "undici";
import { loadConfig, AVG_BLOCK_TIME_SECONDS } from "../../src/config.js";
import { loadAccountsFromDb } from "../../src/accounts-loader.js";
import { request as akashRequest } from "../../src/akash.js";
import { createPool, query, closePool } from "../../src/db/pool.js";

const CONCURRENCY = 4;
const LATEST_BLOCK_PATH = "/rest/cosmos/base/tendermint/v1beta1/blocks/latest";

function parseArgs(argv) {
  const out = { dryRun: false, account: null, limit: 20 };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--account=")) out.account = a.slice("--account=".length);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length)) || 20;
    else console.warn(`[sync-live] ignoring unknown arg: ${a}`);
  }
  return out;
}

function unwrap(body) {
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

function hasLease(d) {
  const leases = d?.leases ?? d?.deployment?.leases;
  return Array.isArray(leases) && leases.length > 0;
}

function extractDseq(d) {
  return d?.deployment?.id?.dseq ?? d?.id?.dseq ?? d?.dseq ?? null;
}

function extractOwner(d) {
  return d?.deployment?.id?.owner ?? d?.id?.owner ?? d?.owner ?? null;
}

function extractProvider(d) {
  const leases = d?.leases ?? d?.deployment?.leases ?? [];
  for (const l of leases) {
    const p = l?.id?.provider ?? l?.provider;
    if (p) return p;
  }
  return null;
}

// console-api stores `created_at` as a block-height string. Prefer the first
// lease's created_at (closer to "in use" start), else the deployment's.
function extractLeasedHeight(d) {
  const leaseHeight = d?.leases?.[0]?.created_at;
  const depHeight = d?.deployment?.created_at;
  const raw = leaseHeight ?? depHeight;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function heightToDate(height, anchor) {
  const ms = anchor.timeMs - (anchor.height - height) * AVG_BLOCK_TIME_SECONDS * 1000;
  return new Date(ms);
}

async function fetchChainAnchor(config) {
  const url = `${config.AKASH_RPC_BASE}${LATEST_BLOCK_PATH}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`chain anchor: HTTP ${res.status} from ${url}`);
    const body = await res.json();
    const header = body?.block?.header;
    const height = Number(header?.height);
    const timeMs = header?.time ? new Date(header.time).getTime() : NaN;
    if (!Number.isFinite(height) || !Number.isFinite(timeMs)) {
      throw new Error(`chain anchor: malformed response from ${url}`);
    }
    return { height, timeMs };
  } finally {
    clearTimeout(timer);
  }
}

async function listLive(ctx, pageSize) {
  const HARD_CEILING_PAGES = 50;
  const out = [];
  let skip = 0;
  for (let page = 0; page < HARD_CEILING_PAGES; page++) {
    const body = await akashRequest(ctx, "GET", `/v1/deployments?skip=${skip}&limit=${pageSize}`);
    const data = unwrap(body);
    const rows = Array.isArray(data?.deployments) ? data.deployments : [];
    out.push(...rows);
    const hasMore = data?.pagination?.hasMore === true;
    const total = Number(data?.pagination?.total ?? 0);
    if (!hasMore || rows.length === 0) break;
    skip += rows.length;
    if (total > 0 && skip >= total) break;
  }
  return out;
}

// INSERT new row, or refresh metadata on the existing (account_id, dseq) row.
// Never downgrade a healthier status — PUT_OK / PUT_FAILED stay (the daemon
// or sweeper owns those state transitions). CLOSED/EXPIRED get promoted back
// to LEASED if the deployment is alive again on Akash.
async function upsert({ accountId, dseq, owner, provider, leasedAt, expiresAt }) {
  const result = await query(
    `INSERT INTO deployments
       (dseq, account_id, owner, provider, status, leased_at, expires_at)
     VALUES (?, ?, ?, ?, 'LEASED', ?, ?)
     ON DUPLICATE KEY UPDATE
       status     = IF(status IN ('CLOSED','EXPIRED'), 'LEASED', status),
       owner      = COALESCE(owner, VALUES(owner)),
       provider   = COALESCE(provider, VALUES(provider)),
       leased_at  = COALESCE(leased_at, VALUES(leased_at)),
       expires_at = VALUES(expires_at)`,
    [String(dseq), accountId, owner, provider, leasedAt, expiresAt],
  );
  return result.affectedRows; // 1 = insert, 2 = update, 0 = no change
}

async function syncAccount(account, config, anchor, { dryRun, limit }) {
  const ctx = { account, config, logger: { warn: () => {}, info: () => {} } };
  const stats = {
    account: account.name, fetched: 0, withLease: 0,
    inserted: 0, updated: 0, skipped: 0, error: null,
  };

  let live;
  try {
    live = await listLive(ctx, limit);
  } catch (err) {
    stats.error = `${err.status ?? ""} ${err.message}`.trim();
    return stats;
  }
  stats.fetched = live.length;

  const lockHoursMs = config.GROUP_LOCK_HOURS * 3600 * 1000;

  for (const d of live) {
    if (!hasLease(d)) continue;
    stats.withLease++;

    const dseq = extractDseq(d);
    if (!dseq) {
      stats.skipped++;
      console.warn(`[sync-live] ${account.name}: row missing dseq — skipped`);
      continue;
    }
    const height = extractLeasedHeight(d);
    if (height == null) {
      stats.skipped++;
      console.warn(`[sync-live] ${account.name} dseq=${dseq}: no created_at block-height — skipped`);
      continue;
    }
    const leasedAt = heightToDate(height, anchor);
    const expiresAt = new Date(leasedAt.getTime() + lockHoursMs);
    const owner = extractOwner(d);
    const provider = extractProvider(d);

    if (dryRun) {
      console.log(
        `[dry-run] ${account.name} dseq=${dseq} owner=${owner?.slice(0, 14) ?? "-"}… provider=${provider ?? "-"} expires=${expiresAt.toISOString()}`,
      );
      stats.inserted++;
      continue;
    }

    const affected = await upsert({ accountId: account.id, dseq, owner, provider, leasedAt, expiresAt });
    if (affected >= 2) stats.updated++;
    else if (affected === 1) stats.inserted++;
    // 0 = row identical to current — not counted
  }

  return stats;
}

async function runConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

function pad(s, n) { return String(s).padEnd(n); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  createPool(config);

  let accounts;
  try {
    accounts = await loadAccountsFromDb();
  } catch (err) {
    console.error(`[sync-live] ${err.message}`);
    await closePool();
    process.exit(1);
  }
  if (args.account) {
    accounts = accounts.filter((a) => a.name === args.account);
    if (accounts.length === 0) {
      console.error(`[sync-live] no enabled account named "${args.account}"`);
      await closePool();
      process.exit(1);
    }
  }

  let anchor;
  try {
    anchor = await fetchChainAnchor(config);
  } catch (err) {
    console.error(`[sync-live] ${err.message}`);
    await closePool();
    process.exit(1);
  }

  console.log(
    `[sync-live] dry_run=${args.dryRun} accounts=${accounts.length} limit=${args.limit} concurrency=${CONCURRENCY} lock_hours=${config.GROUP_LOCK_HOURS} chain_anchor=height=${anchor.height} time=${new Date(anchor.timeMs).toISOString()}`,
  );

  const results = await runConcurrent(accounts, CONCURRENCY, (a) =>
    syncAccount(a, config, anchor, args),
  );

  console.log("\n[sync-live] per-account summary:");
  let totIns = 0, totUpd = 0, totSkip = 0, totErr = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ${pad(r.account, 24)} ERROR: ${r.error}`);
      totErr++;
      continue;
    }
    console.log(
      `  ${pad(r.account, 24)} fetched=${r.fetched} with_lease=${r.withLease} inserted=${r.inserted} updated=${r.updated} skipped=${r.skipped}`,
    );
    totIns += r.inserted; totUpd += r.updated; totSkip += r.skipped;
  }
  console.log(
    `\n[sync-live] totals: inserted=${totIns} updated=${totUpd} skipped=${totSkip} errors=${totErr} dry_run=${args.dryRun}`,
  );

  await closePool();
}

main().catch(async (e) => {
  console.error("[sync-live] fatal:", e);
  try { await closePool(); } catch {}
  process.exit(99);
});
