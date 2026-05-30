#!/usr/bin/env node
// Reconcile live console-api deployment state into the local `deployments`
// table.
//
// Why this is more than "loop accounts + upsert": console-api api-keys are
// frequently shared-wallet — N keys all see the same wallet's deployments.
// A naive per-account upsert produces N rows per logical deployment. We
// dedupe by (owner, dseq) and keep ONE canonical row (lowest account.id).
//
// Pipeline:
//   1. Per-account fetch (parallel, paginated).
//   2. Normalize rows; drop ones without a lease (nothing for the daemon to
//      manage yet — bidder will pick those up).
//   3. Dedupe by (owner, dseq) — lowest account.id wins as canonical.
//   4. Upsert canonical row + delete non-canonical LEASED rows.
//   5. Two-way reconcile: close stale LEASED rows whose dseq is no longer
//      live for the canonical account.
//
// Conservative DB guards:
//   - Never downgrade PUT_OK / PUT_FAILED (daemon owns those).
//   - Never delete / close rows with group_name set (daemon progressed past
//     initial insert).
//   - Never touch rows whose created_at >= scanStart (avoid racing the
//     daemon's concurrent inserts).
//
// Usage:
//   node scripts/ops/sync-live-deployments.js [--dry-run] [--account=NAME] [--limit=N]

import "dotenv/config";
import { fetch } from "undici";
import { loadConfig, AVG_BLOCK_TIME_SECONDS } from "../../src/config.js";
import { loadAccountsFromDb } from "../../src/accounts-loader.js";
import { request as akashRequest } from "../../src/akash.js";
import { createPool, query, closePool } from "../../src/db/pool.js";

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

async function fetchAccount(account, config, limit) {
  const ctx = { account, config, logger: { warn: () => {}, info: () => {} } };
  try {
    const raw = await listLive(ctx, limit);
    return { account, raw, error: null };
  } catch (err) {
    return { account, raw: [], error: `${err.status ?? ""} ${err.message}`.trim() };
  }
}

function normalize(d, anchor, lockHoursMs) {
  if (!hasLease(d)) return { skip: "no_lease" };
  const dseq = extractDseq(d);
  if (!dseq) return { skip: "no_dseq" };
  const owner = extractOwner(d);
  if (!owner) return { skip: "no_owner", dseq };
  const height = extractLeasedHeight(d);
  if (height == null) return { skip: "no_created_at", dseq };
  const leasedAt = heightToDate(height, anchor);
  return {
    dseq: String(dseq),
    owner,
    provider: extractProvider(d),
    leasedAt,
    expiresAt: new Date(leasedAt.getTime() + lockHoursMs),
  };
}

// Bucket all per-account candidates by (owner, dseq). Lowest account.id wins
// as canonical. We also track every account.id that saw the row so we can
// clean up non-canonical duplicates in the DB.
function dedupe(perAccount) {
  const map = new Map();
  for (const { account, candidates } of perAccount) {
    for (const c of candidates) {
      const key = `${c.owner}|${c.dseq}`;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, {
          ...c,
          canonicalAccountId: account.id,
          canonicalAccountName: account.name,
          seenByAccountIds: [account.id],
        });
      } else {
        prev.seenByAccountIds.push(account.id);
        if (account.id < prev.canonicalAccountId) {
          prev.canonicalAccountId = account.id;
          prev.canonicalAccountName = account.name;
        }
        prev.provider = prev.provider ?? c.provider ?? null;
      }
    }
  }
  return [...map.values()];
}

async function upsertCanonical(row) {
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
    [row.dseq, row.canonicalAccountId, row.owner, row.provider, row.leasedAt, row.expiresAt],
  );
  return result.affectedRows; // 1 = insert, 2 = update, 0 = no change
}

// Delete duplicate rows for the same logical deployment that ended up under
// a non-canonical account_id. Only touches rows still in the initial-import
// state — never PUT_OK / PUT_FAILED / CLOSED / EXPIRED, never with a group.
async function deleteNonCanonical({ dseq, owner, canonicalAccountId, scanStart }) {
  const result = await query(
    `DELETE FROM deployments
     WHERE dseq = ?
       AND account_id <> ?
       AND status = 'LEASED'
       AND group_name IS NULL
       AND created_at < ?
       AND (owner = ? OR owner IS NULL)`,
    [dseq, canonicalAccountId, scanStart, owner],
  );
  return result.affectedRows;
}

// For the canonical account: flip LEASED rows whose dseq is not in the
// live set to CLOSED. Same conservative guards as deleteNonCanonical.
async function reconcileClosedForAccount({ accountId, liveDseqs, scanStart, dryRun }) {
  const notInLive = liveDseqs.length > 0
    ? `AND dseq NOT IN (${liveDseqs.map(() => "?").join(",")})`
    : "";
  const params = [accountId, scanStart, ...liveDseqs];

  if (dryRun) {
    const rows = await query(
      `SELECT id, dseq FROM deployments
       WHERE account_id = ?
         AND status = 'LEASED'
         AND group_name IS NULL
         AND created_at < ?
         ${notInLive}`,
      params,
    );
    return { affected: rows.length, dseqs: rows.map((r) => r.dseq) };
  }
  const result = await query(
    `UPDATE deployments SET status = 'CLOSED'
     WHERE account_id = ?
       AND status = 'LEASED'
       AND group_name IS NULL
       AND created_at < ?
       ${notInLive}`,
    params,
  );
  return { affected: result.affectedRows, dseqs: [] };
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

  const scanStart = new Date();

  console.log(
    `[sync-live] dry_run=${args.dryRun} accounts=${accounts.length} limit=${args.limit} lock_hours=${config.GROUP_LOCK_HOURS} scan_start=${scanStart.toISOString()} chain_anchor=height=${anchor.height} time=${new Date(anchor.timeMs).toISOString()}`,
  );

  // Phase 1 — fetch each account sequentially. Simple and avoids hammering
  // console-api in parallel; the whole script finishes in a few seconds.
  const fetched = [];
  for (const a of accounts) {
    fetched.push(await fetchAccount(a, config, args.limit));
  }

  // Raw transparency: what each api-key actually returned, with the key
  // prefix so the operator can sanity-check against curl manually.
  console.log("\n[sync-live] raw fetch (api-key → dseqs):");
  for (const r of fetched) {
    const prefix = r.account.apiKey ? r.account.apiKey.slice(0, 24) + "…" : "?";
    if (r.error) {
      console.log(`  ${pad(r.account.name, 18)} key=${prefix} ERROR: ${r.error}`);
      continue;
    }
    if (r.raw.length === 0) {
      console.log(`  ${pad(r.account.name, 18)} key=${prefix} (0 deployments)`);
      continue;
    }
    const summary = r.raw.map((d) => {
      const dseq = extractDseq(d);
      const owner = extractOwner(d);
      const leases = (d?.leases ?? d?.deployment?.leases ?? []).length;
      return `${dseq}/${owner?.slice(0, 14) ?? "?"}…(leases=${leases})`;
    });
    console.log(`  ${pad(r.account.name, 18)} key=${prefix} → ${summary.join(", ")}`);
  }

  // Phase 2 — normalize per account
  const lockHoursMs = config.GROUP_LOCK_HOURS * 3600 * 1000;
  const perAccount = [];
  const stats = new Map();
  for (const r of fetched) {
    const s = { account: r.account.name, fetched: r.raw.length, with_lease: 0, skipped: 0, error: r.error };
    stats.set(r.account.id, s);
    if (r.error) { perAccount.push({ account: r.account, candidates: [] }); continue; }
    const candidates = [];
    for (const d of r.raw) {
      const n = normalize(d, anchor, lockHoursMs);
      if (n.skip === "no_lease") continue;
      if (n.skip) {
        s.skipped++;
        console.warn(`[sync-live] ${r.account.name} ${n.skip}${n.dseq ? ` dseq=${n.dseq}` : ""} — skipped`);
        continue;
      }
      s.with_lease++;
      candidates.push(n);
    }
    perAccount.push({ account: r.account, candidates });
  }

  // Phase 3 — dedupe by (owner, dseq)
  const canonical = dedupe(perAccount);
  const shared = canonical.filter((r) => r.seenByAccountIds.length > 1);
  console.log(
    `\n[sync-live] dedupe: ${canonical.length} unique (owner,dseq) tuples; ${shared.length} shared across multiple accounts`,
  );
  for (const r of shared) {
    const names = r.seenByAccountIds
      .map((id) => accounts.find((a) => a.id === id)?.name ?? `id=${id}`);
    console.log(
      `  shared: dseq=${r.dseq} owner=${r.owner.slice(0, 14)}… seen_by=[${names.join(", ")}] canonical=${r.canonicalAccountName}`,
    );
  }

  // Phase 4 — write canonical rows + delete non-canonical duplicates.
  // Track each account's "live LEASED set" for phase 5. An account's set
  // includes ONLY dseqs where it is canonical. Non-canonical accounts'
  // sets stay empty → phase 5 will close all their stale LEASED rows.
  let inserted = 0, updated = 0, deleted = 0;
  const liveByAccount = new Map(); // accountId → string[]
  for (const r of fetched) {
    if (!r.error) liveByAccount.set(r.account.id, []);
  }
  for (const row of canonical) {
    const list = liveByAccount.get(row.canonicalAccountId) ?? [];
    list.push(row.dseq);
    liveByAccount.set(row.canonicalAccountId, list);

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
      const removed = await deleteNonCanonical({
        dseq: row.dseq,
        owner: row.owner,
        canonicalAccountId: row.canonicalAccountId,
        scanStart,
      });
      if (removed > 0) {
        deleted += removed;
        console.log(
          `[sync-live] deduped: dseq=${row.dseq} removed ${removed} non-canonical LEASED row(s); kept account=${row.canonicalAccountName}`,
        );
      }
    }
  }

  // Phase 5 — close stale LEASED rows for every account that fetched
  // successfully. For non-canonical accounts (shared wallet, lost to a
  // lower-id account), their live set is empty → all their LEASED rows
  // get closed. This is how legacy duplicates from the pre-dedup era get
  // cleaned up. Errored accounts are skipped (can't tell "empty" from
  // "fetch failed").
  let totalClosed = 0;
  for (const [accountId, liveDseqs] of liveByAccount) {
    const acc = accounts.find((a) => a.id === accountId);
    const res = await reconcileClosedForAccount({
      accountId,
      liveDseqs,
      scanStart,
      dryRun: args.dryRun,
    });
    totalClosed += res.affected;
    if (args.dryRun && res.dseqs.length > 0) {
      console.log(
        `[dry-run] ${acc?.name ?? `id=${accountId}`} would CLOSE stale dseqs: ${res.dseqs.join(", ")}`,
      );
    }
  }

  console.log("\n[sync-live] per-account fetch summary:");
  let totErr = 0;
  for (const [, s] of stats) {
    if (s.error) { console.log(`  ${pad(s.account, 24)} ERROR: ${s.error}`); totErr++; continue; }
    console.log(`  ${pad(s.account, 24)} fetched=${s.fetched} with_lease=${s.with_lease} skipped=${s.skipped}`);
  }
  console.log(
    `\n[sync-live] write totals: inserted=${inserted} updated=${updated} closed=${totalClosed} deleted_non_canonical=${deleted} errors=${totErr} dry_run=${args.dryRun}`,
  );

  await closePool();
}

main().catch(async (e) => {
  console.error("[sync-live] fatal:", e);
  try { await closePool(); } catch {}
  process.exit(99);
});
