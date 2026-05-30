// deployments repo. Audit-log style — append + status flips.
// All write methods accept an optional `conn` (mysql2 connection) so callers
// can compose them inside withTx; non-tx callers omit it and use the pool.
//
// After migration 003, the UNIQUE key is (account_id, dseq) — the same dseq
// value may appear across different accounts, so updateStatus is keyed by
// the (dseq, accountId) pair.

import { query } from "../pool.js";
import { DbError } from "../../errors.js";

const COLS = "id, dseq, account_id, owner, group_name, provider, uact_per_block, status, leased_at, expires_at, put_attempts, auto_topup_disabled, last_error, created_at, updated_at";

function exec(conn, sql, params) {
  if (conn) return conn.query(sql, params).then(([rows]) => rows);
  return query(sql, params);
}

export async function insert({ dseq, accountId, groupName, provider, uactPerBlock, status, leasedAt, expiresAt }, conn) {
  try {
    await exec(
      conn,
      `INSERT INTO deployments
         (dseq, account_id, group_name, provider, uact_per_block, status, leased_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(dseq),
        accountId,
        groupName ?? null,
        provider ?? null,
        uactPerBlock ?? null,
        status,
        leasedAt ?? null,
        expiresAt ?? null,
      ],
    );
    return get(String(dseq), accountId, conn);
  } catch (err) {
    if (err instanceof DbError && err.code === "ER_DUP_ENTRY") {
      throw new DbError(`deployments.insert: duplicate (account_id=${accountId}, dseq="${dseq}")`, err.cause);
    }
    // mysql2 raw errors from conn.query() also need translation.
    if (err && err.code === "ER_DUP_ENTRY") {
      throw new DbError(`deployments.insert: duplicate (account_id=${accountId}, dseq="${dseq}")`, err);
    }
    throw err;
  }
}

export async function get(dseq, accountId, conn) {
  if (accountId != null) {
    const rows = await exec(
      conn,
      `SELECT ${COLS} FROM deployments WHERE dseq = ? AND account_id = ?`,
      [String(dseq), accountId],
    );
    return rows[0] ?? null;
  }
  const rows = await exec(
    conn,
    `SELECT ${COLS} FROM deployments WHERE dseq = ? ORDER BY id DESC LIMIT 1`,
    [String(dseq)],
  );
  return rows[0] ?? null;
}

export async function list({ accountId, status, limit } = {}) {
  const where = [];
  const params = [];
  if (accountId != null) { where.push("account_id = ?"); params.push(accountId); }
  if (status) { where.push("status = ?"); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limitSql = limit ? `LIMIT ${Number(limit)}` : "LIMIT 200";
  return query(`SELECT ${COLS} FROM deployments ${whereSql} ORDER BY id DESC ${limitSql}`, params);
}

/**
 * Flip status and optionally patch group_name / last_error / put_attempts for
 * a specific (dseq, accountId) row.
 * `patch.put_attempts_increment` adds 1 to the counter atomically.
 */
export async function updateStatus(dseq, accountId, status, patch = {}, conn) {
  if (accountId == null) {
    throw new DbError("deployments.updateStatus: accountId is required");
  }
  const allowed = ["group_name", "last_error"];
  const sets = ["status = ?"];
  const params = [status];
  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (patch.put_attempts != null) {
    sets.push("put_attempts = ?");
    params.push(patch.put_attempts);
  } else if (patch.put_attempts_increment) {
    sets.push("put_attempts = put_attempts + 1");
  }
  params.push(String(dseq), accountId);
  await exec(
    conn,
    `UPDATE deployments SET ${sets.join(", ")} WHERE dseq = ? AND account_id = ?`,
    params,
  );
  return get(dseq, accountId, conn);
}

export async function markAutoTopUpDisabled(dseq, accountId, conn) {
  await exec(
    conn,
    "UPDATE deployments SET auto_topup_disabled = TRUE WHERE dseq = ? AND account_id = ?",
    [String(dseq), accountId],
  );
}

/**
 * Rows where auto-topup is still ON but should be OFF. Status filter limits
 * the set to deployments that have been leased + had their SDL PUT successfully
 * — i.e. the only state where the PATCH is meaningful. Returns up to `limit`
 * rows; sweeper iterates per tick.
 */
export async function listPendingAutoTopUp(limit = 50) {
  return query(
    `SELECT ${COLS} FROM deployments
     WHERE auto_topup_disabled = FALSE
       AND status IN ('LEASED','PUT_OK','PUT_FAILED')
     ORDER BY id ASC
     LIMIT ?`,
    [Number(limit)],
  );
}

export async function expireDue(now) {
  const result = await query(
    `UPDATE deployments SET status = 'EXPIRED'
     WHERE status IN ('LEASED','PUT_OK') AND expires_at IS NOT NULL AND expires_at < ?`,
    [now],
  );
  return result.affectedRows;
}
