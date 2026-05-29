// groups repo. Race-safe lock via SELECT ... FOR UPDATE inside a tx.
// Returns plain snake_case rows from DB (no camelCase mapping at this layer).

import { query, withTx } from "../pool.js";
import { DbError } from "../../errors.js";

const COLS = "name, branch, workspace, status, locked_by_account_id, locked_dseq, locked_at, expires_at, last_nag_at, last_error, notes, created_at, updated_at";

export async function listAll({ status, workspace, limit } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push("status = ?"); params.push(status); }
  if (workspace) { where.push("workspace = ?"); params.push(workspace); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limitSql = limit ? `LIMIT ${Number(limit)}` : "";
  return query(`SELECT ${COLS} FROM \`groups\` ${whereSql} ORDER BY name ASC ${limitSql}`, params);
}

export async function get(name) {
  const rows = await query(`SELECT ${COLS} FROM \`groups\` WHERE name = ?`, [name]);
  return rows[0] ?? null;
}

export async function insert({ name, branch, status, notes, workspace }) {
  try {
    await query(
      "INSERT INTO `groups` (name, branch, status, notes, workspace) VALUES (?, ?, ?, ?, ?)",
      [name, branch, status ?? "AVAILABLE", notes ?? null, workspace ?? "DEFAULT"],
    );
  } catch (err) {
    if (err instanceof DbError && err.code === "ER_DUP_ENTRY") {
      throw new DbError(`groups.insert: duplicate name "${name}"`, err.cause);
    }
    throw err;
  }
  return get(name);
}

export async function update(name, patch) {
  const allowed = ["status", "branch", "notes", "workspace", "locked_by_account_id", "locked_dseq", "locked_at", "expires_at", "last_nag_at", "last_error"];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (sets.length === 0) return get(name);
  params.push(name);
  await query(`UPDATE \`groups\` SET ${sets.join(", ")} WHERE name = ?`, params);
  return get(name);
}

export async function remove(name) {
  const rows = await query("DELETE FROM `groups` WHERE name = ?", [name]);
  return rows.affectedRows > 0;
}

/**
 * Atomic pick-next-available. Sequential ASC by name. Returns locked row or null.
 * If `conn` is provided, runs inside that transaction (no nested withTx).
 */
export async function lockNextAvailable(accountId, dseq, lockHours, workspace, conn) {
  const run = async (c) => {
    const [rows] = await c.query(
      "SELECT name FROM `groups` WHERE status = 'AVAILABLE' AND workspace = ? ORDER BY name ASC LIMIT 1 FOR UPDATE",
      [workspace ?? "DEFAULT"],
    );
    if (rows.length === 0) return null;
    const name = rows[0].name;
    await c.query(
      `UPDATE \`groups\` SET status = 'LOCKED', locked_by_account_id = ?, locked_dseq = ?,
         locked_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR), last_error = NULL
       WHERE name = ?`,
      [accountId, dseq, lockHours, name],
    );
    const [updated] = await c.query(
      `SELECT ${COLS} FROM \`groups\` WHERE name = ?`,
      [name],
    );
    return updated[0] ?? null;
  };
  return conn ? run(conn) : withTx(run);
}

export async function release(name) {
  await query(
    `UPDATE \`groups\` SET status = 'AVAILABLE', locked_by_account_id = NULL,
       locked_dseq = NULL, locked_at = NULL, expires_at = NULL, last_nag_at = NULL,
       last_error = NULL
     WHERE name = ?`,
    [name],
  );
  return get(name);
}

export async function expireDue(now) {
  const result = await query(
    `UPDATE \`groups\` SET status = 'AVAILABLE', locked_by_account_id = NULL,
       locked_dseq = NULL, locked_at = NULL, expires_at = NULL, last_nag_at = NULL,
       last_error = NULL
     WHERE status = 'LOCKED' AND expires_at < ?`,
    [now],
  );
  return result.affectedRows;
}

export async function listPutFailedNagDue(intervalMs, now) {
  const cutoff = new Date(now.getTime() - intervalMs);
  return query(
    `SELECT ${COLS} FROM \`groups\`
     WHERE status = 'PUT_FAILED'
       AND (last_nag_at IS NULL OR last_nag_at < ?)
     ORDER BY name ASC`,
    [cutoff],
  );
}

export async function markNagged(name, now) {
  await query("UPDATE `groups` SET last_nag_at = ? WHERE name = ?", [now, name]);
}
