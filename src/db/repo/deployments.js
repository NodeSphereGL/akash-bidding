// deployments repo. Returns snake_case rows. Audit-log style — append + status flips.

import { query } from "../pool.js";
import { DbError } from "../../errors.js";

const COLS = "id, dseq, account_id, group_name, provider, uact_per_block, status, leased_at, expires_at, put_attempts, last_error, created_at, updated_at";

export async function insert({ dseq, accountId, groupName, provider, uactPerBlock, status, leasedAt, expiresAt }) {
  try {
    const result = await query(
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
    return get(String(dseq), result.insertId);
  } catch (err) {
    if (err instanceof DbError && err.code === "ER_DUP_ENTRY") {
      throw new DbError(`deployments.insert: duplicate dseq "${dseq}"`, err.cause);
    }
    throw err;
  }
}

export async function get(dseq) {
  const rows = await query(`SELECT ${COLS} FROM deployments WHERE dseq = ?`, [String(dseq)]);
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
 * Flip status and optionally patch group_name / last_error / put_attempts.
 * `patch.put_attempts_increment` adds 1 to the counter atomically.
 */
export async function updateStatus(dseq, status, patch = {}) {
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
  params.push(String(dseq));
  await query(`UPDATE deployments SET ${sets.join(", ")} WHERE dseq = ?`, params);
  return get(dseq);
}

export async function expireDue(now) {
  const result = await query(
    `UPDATE deployments SET status = 'EXPIRED'
     WHERE status IN ('LEASED','PUT_OK') AND expires_at IS NOT NULL AND expires_at < ?`,
    [now],
  );
  return result.affectedRows;
}
