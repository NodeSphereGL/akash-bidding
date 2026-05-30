#!/usr/bin/env node
// Reconcile live console-api deployment state into the local `deployments`
// table. Additive only — inserts/upserts rows for active deployments per
// account. Does NOT lock groups, does NOT flip missing rows to CLOSED.
//
// Intended use: first-time prod reconciliation when DB is fresh but managed
// wallets already hold live deployments (operator created them manually or
// from an earlier daemon run).
//
// Usage:
//   node scripts/ops/sync-live-deployments.js [--dry-run] [--account=NAME] [--limit=N]
//
// expires_at is derived as (lease/created time from API) + GROUP_LOCK_HOURS.
// Rows missing a parseable created time are skipped with a warning so the
// operator can investigate manually instead of inheriting a wrong expiry.

import "dotenv/config";
import { fetch } from "undici";
import { loadConfig, AVG_BLOCK_TIME_SECONDS } from "../../src/config.js";
import { loadAccountsFromDb } from "../../src/accounts-loader.js";
import { request as akashRequest } from "../../src/akash.js";
import { createPool, query, closePool } from "../../src/db/pool.js";

const CONCURRENCY = 4;
const LATEST_BLOCK_PATH = "/rest/cosmos/base/tendermint/v1beta1/blocks/latest";

function parseArgs(argv) {
  const out = { dryRun: false, account: null, limit: 500 };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--account=")) out.account = a.slice("--account=".length);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length)) || 500;
    else console.warn(`[sync-live] ignoring unknown arg: ${a}`);
  }
  return out;
}

function unwrap(body) {
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

// Akash chain DeploymentState enum: invalid=0, active=1, closed=2.
// console-api may serialize it as a number, a string, or the bare enum name.
function isActive(d) {
  const state = d?.deployment?.state ?? d?.state;
  if (state == null) return true;
  if (typeof state === "number") return state === 1;
  if (typeof state === "string") return /^active$/i.test(state) || state === "1";
  return true;
}

function extractDseq(d) {
  return (
    d?.deployment?.deployment_id?.dseq ??
    d?.deployment?.id?.dseq ??
    d?.deployment_id?.dseq ??
    d?.id?.dseq ??
    d?.dseq ??
    null
  );
}

function extractProvider(d) {
  const leases = d?.leases ?? d?.deployment?.leases ?? [];
  for (const l of leases) {
    const p = l?.id?.provider ?? l?.lease?.lease_id?.provider ?? l?.lease_id?.provider ?? l?.provider;
    if (p) return p;
  }
  return null;
}

// console-api stores `created_at` as a block-height string (not a wall-clock
// timestamp). Prefer the first lease's created_at — that's "in use" start —
// otherwise fall back to the deployment's own created_at.
function extractLeasedHeight(d) {
  const leaseHeight = d?.leases?.[0]?.created_at ?? d?.leases?.[0]?.lease?.created_at;
  const depHeight = d?.deployment?.created_at ?? d?.created_at;
  const raw = leaseHeight ?? depHeight;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Linear height → wall-clock using a single chain anchor. Drift is bounded
// by AVG_BLOCK_TIME_SECONDS variance — fine for 24h expiry math.
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

async function listLive(ctx, limit) {
  const body = await akashRequest(ctx, "GET", `/v1/deployments?limit=${limit}`);
  const data = unwrap(body);
  return Array.isArray(data?.deployments) ? data.deployments : [];
}

async function upsertDeployment({ accountId, dseq, provider, leasedAt, expiresAt }) {
  // INSERT new row, or refresh an old terminal row back to LEASED if the
  // remote deployment is still active. Never downgrade a healthier status
  // (PUT_OK stays PUT_OK; PUT_FAILED stays PUT_FAILED so the nag continues).
  const result = await query(
    `INSERT INTO deployments
       (dseq, account_id, provider, status, leased_at, expires_at)
     VALUES (?, ?, ?, 'LEASED', ?, ?)
     ON DUPLICATE KEY UPDATE
       status     = IF(status IN ('CLOSED','EXPIRED'), 'LEASED', status),
       provider   = COALESCE(provider, VALUES(provider)),
       leased_at  = COALESCE(leased_at, VALUES(leased_at)),
       expires_at = VALUES(expires_at)`,
    [String(dseq), accountId, provider, leasedAt, expiresAt],
  );
  // mysql2 affectedRows convention: 1 = insert, 2 = update, 0 = no change.
  return result.affectedRows;
}

async function syncAccount(account, config, anchor, { dryRun, limit }) {
  const ctx = { account, config, logger: { warn: () => {}, info: () => {} } };
  const stats = {
    account: account.name,
    fetched: 0,
    active: 0,
    inserted: 0,
    updated: 0,
    skippedNoCreatedAt: 0,
    skippedNoDseq: 0,
    error: null,
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
  const truncated = live.length >= limit;

  for (const d of live) {
    if (!isActive(d)) continue;
    stats.active++;
    const dseq = extractDseq(d);
    if (!dseq) {
      stats.skippedNoDseq++;
      console.warn(`[sync-live] ${account.name}: row missing dseq, skipped`);
      continue;
    }
    const height = extractLeasedHeight(d);
    if (height == null) {
      stats.skippedNoCreatedAt++;
      console.warn(`[sync-live] ${account.name} dseq=${dseq}: no created_at block-height on API row — skipped`);
      continue;
    }
    const leasedAt = heightToDate(height, anchor);
    const expiresAt = new Date(leasedAt.getTime() + lockHoursMs);
    const provider = extractProvider(d);

    if (dryRun) {
      console.log(
        `[dry-run] ${account.name} dseq=${dseq} leased_at=${leasedAt.toISOString()} expires_at=${expiresAt.toISOString()} provider=${provider ?? "-"}`,
      );
      stats.inserted++;
      continue;
    }

    const affected = await upsertDeployment({
      accountId: account.id,
      dseq,
      provider,
      leasedAt,
      expiresAt,
    });
    if (affected >= 2) stats.updated++;
    else if (affected === 1) stats.inserted++;
    // 0 = row existed but no field actually changed; not counted.
  }

  if (truncated) {
    console.warn(
      `[sync-live] ${account.name}: returned ${live.length} rows == limit=${limit}; bump --limit to be sure nothing was clipped`,
    );
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

function pad(s, n) {
  return String(s).padEnd(n);
}

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
    const skipped = r.skippedNoCreatedAt + r.skippedNoDseq;
    console.log(
      `  ${pad(r.account, 24)} fetched=${r.fetched} active=${r.active} inserted=${r.inserted} updated=${r.updated} skipped=${skipped}`,
    );
    totIns += r.inserted;
    totUpd += r.updated;
    totSkip += skipped;
  }
  console.log(
    `\n[sync-live] totals inserted=${totIns} updated=${totUpd} skipped=${totSkip} errors=${totErr} dry_run=${args.dryRun}`,
  );

  await closePool();
}

main().catch(async (e) => {
  console.error("[sync-live] fatal:", e);
  try { await closePool(); } catch {}
  process.exit(99);
});
