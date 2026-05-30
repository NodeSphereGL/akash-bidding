#!/usr/bin/env node
// Reconcile live console-api deployment state into the local `deployments`
// table. Two-phase:
//   1) Fetch active deployments per enabled account in parallel.
//   2) Dedupe per (owner, dseq) — multiple api-keys can see the same wallet's
//      deployments. Pick the lowest account.id as the canonical owner of the
//      local row; upsert that; delete non-canonical (account_id, dseq) rows.
//
// Does NOT lock groups, does NOT flip missing rows to CLOSED — sweeper handles
// expiry and group locks must be operator-controlled.
//
// Usage:
//   node scripts/ops/sync-live-deployments.js [--dry-run] [--account=NAME] [--limit=N]
//
// expires_at = (lease/deployment block-height converted via chain anchor) +
// GROUP_LOCK_HOURS. Rows missing a parseable created_at are skipped with a
// warning so the operator can investigate manually instead of inheriting a
// wrong expiry.

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

function extractOwner(d) {
  return (
    d?.deployment?.deployment_id?.owner ??
    d?.deployment?.id?.owner ??
    d?.deployment_id?.owner ??
    d?.id?.owner ??
    d?.owner ??
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

// Linear height → wall-clock using a single chain anchor. Drift bounded by
// AVG_BLOCK_TIME_SECONDS variance — fine for 24h expiry math.
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

async function fetchAccount(account, config, limit) {
  const ctx = { account, config, logger: { warn: () => {}, info: () => {} } };
  const result = { account, raw: [], error: null };
  try {
    result.raw = await listLive(ctx, limit);
  } catch (err) {
    result.error = `${err.status ?? ""} ${err.message}`.trim();
  }
  return result;
}

// Normalize one API row to a candidate record. Returns null if the row is
// closed / missing required fields — caller increments skip counters.
function normalize(account, d, anchor, lockHoursMs) {
  if (!isActive(d)) return { skip: "inactive" };
  const dseq = extractDseq(d);
  if (!dseq) return { skip: "no_dseq" };
  const owner = extractOwner(d);
  if (!owner) return { skip: "no_owner", dseq };
  const height = extractLeasedHeight(d);
  if (height == null) return { skip: "no_created_at", dseq };
  const leasedAt = heightToDate(height, anchor);
  const expiresAt = new Date(leasedAt.getTime() + lockHoursMs);
  return {
    dseq: String(dseq),
    owner,
    provider: extractProvider(d),
    leasedAt,
    expiresAt,
    seenBy: account.id,
  };
}

// Pick canonical account per (owner, dseq): lowest account.id among accounts
// that observed the row. Deterministic + matches the existing daemon's
// natural account ordering (lockNextAvailable uses ORDER BY name ASC, but
// for sync-live we use id since it's stable across rename).
function dedupe(perAccount) {
  const map = new Map(); // key = owner + '|' + dseq
  for (const { account, candidates } of perAccount) {
    for (const c of candidates) {
      const key = `${c.owner}|${c.dseq}`;
      const prev = map.get(key);
      if (!prev || account.id < prev.canonicalAccountId) {
        map.set(key, {
          owner: c.owner,
          dseq: c.dseq,
          provider: c.provider ?? prev?.provider ?? null,
          leasedAt: c.leasedAt,
          expiresAt: c.expiresAt,
          canonicalAccountId: account.id,
          canonicalAccountName: account.name,
          seenByAccountIds: prev ? [...new Set([...prev.seenByAccountIds, account.id])] : [account.id],
        });
      } else {
        prev.seenByAccountIds = [...new Set([...prev.seenByAccountIds, account.id])];
        prev.provider = prev.provider ?? c.provider ?? null;
      }
    }
  }
  return [...map.values()];
}

async function upsertCanonical({ canonicalAccountId, owner, dseq, provider, leasedAt, expiresAt }) {
  // INSERT new row, or refresh an old terminal row back to LEASED + record
  // the wallet owner. Never downgrade a healthier status (PUT_OK stays
  // PUT_OK; PUT_FAILED stays PUT_FAILED so the nag continues).
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
    [dseq, canonicalAccountId, owner, provider, leasedAt, expiresAt],
  );
  return result.affectedRows;
}

// Remove non-canonical shared-wallet rows. Constrained to LEASED status so
// we never delete a row that a daemon loop has progressed past initial
// import (PUT_OK / PUT_FAILED / CLOSED / EXPIRED are preserved).
async function deleteNonCanonical({ owner, dseq, canonicalAccountId }) {
  const result = await query(
    `DELETE FROM deployments
     WHERE dseq = ? AND account_id <> ? AND status = 'LEASED'
       AND (owner = ? OR owner IS NULL)`,
    [dseq, canonicalAccountId, owner],
  );
  return result.affectedRows;
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

  // --- phase 1: fetch live state per account ---
  const fetchResults = await runConcurrent(accounts, CONCURRENCY, (a) =>
    fetchAccount(a, config, args.limit),
  );

  // --- phase 2: normalize + bucket by account ---
  const lockHoursMs = config.GROUP_LOCK_HOURS * 3600 * 1000;
  const perAccount = [];
  const accountStats = new Map();
  for (const r of fetchResults) {
    const stat = { account: r.account.name, fetched: r.raw.length, active: 0, skipped: 0, error: r.error };
    accountStats.set(r.account.id, stat);
    if (r.error) { perAccount.push({ account: r.account, candidates: [] }); continue; }
    const candidates = [];
    for (const d of r.raw) {
      const n = normalize(r.account, d, anchor, lockHoursMs);
      if (n.skip === "inactive") continue;
      if (n.skip) {
        stat.skipped++;
        console.warn(`[sync-live] ${r.account.name} ${n.skip}${n.dseq ? ` dseq=${n.dseq}` : ""} — skipped`);
        continue;
      }
      stat.active++;
      candidates.push(n);
    }
    perAccount.push({ account: r.account, candidates });
  }

  // --- phase 3: dedupe by (owner, dseq) ---
  const canonicalRows = dedupe(perAccount);
  const sharedRows = canonicalRows.filter((r) => r.seenByAccountIds.length > 1);
  console.log(
    `\n[sync-live] dedupe: ${canonicalRows.length} unique (owner,dseq) tuples; ${sharedRows.length} shared across multiple accounts`,
  );
  for (const r of sharedRows) {
    const names = r.seenByAccountIds.map((id) => {
      const acc = accounts.find((a) => a.id === id);
      return acc?.name ?? `id=${id}`;
    });
    console.log(
      `  shared: dseq=${r.dseq} owner=${r.owner.slice(0, 14)}… seen_by=[${names.join(", ")}] canonical=${r.canonicalAccountName}`,
    );
  }

  // --- phase 4: write canonical rows + remove non-canonical duplicates ---
  let inserted = 0, updated = 0, deleted = 0;
  for (const row of canonicalRows) {
    if (args.dryRun) {
      console.log(
        `[dry-run] upsert canonical: account=${row.canonicalAccountName} dseq=${row.dseq} owner=${row.owner.slice(0, 14)}… expires=${row.expiresAt.toISOString()}`,
      );
      continue;
    }
    const affected = await upsertCanonical(row);
    if (affected >= 2) updated++;
    else if (affected === 1) inserted++;

    if (row.seenByAccountIds.length > 1) {
      const removed = await deleteNonCanonical(row);
      if (removed > 0) {
        deleted += removed;
        console.log(
          `[sync-live] deduped: dseq=${row.dseq} removed ${removed} non-canonical LEASED row(s); kept account=${row.canonicalAccountName}`,
        );
      }
    }
  }

  console.log("\n[sync-live] per-account fetch summary:");
  for (const [, s] of accountStats) {
    if (s.error) console.log(`  ${pad(s.account, 24)} ERROR: ${s.error}`);
    else console.log(`  ${pad(s.account, 24)} fetched=${s.fetched} active=${s.active} skipped=${s.skipped}`);
  }
  console.log(
    `\n[sync-live] write totals: inserted=${inserted} updated=${updated} deleted_non_canonical=${deleted} dry_run=${args.dryRun}`,
  );

  await closePool();
}

main().catch(async (e) => {
  console.error("[sync-live] fatal:", e);
  try { await closePool(); } catch {}
  process.exit(99);
});
