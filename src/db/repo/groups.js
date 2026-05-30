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

/**
 * Pre-POST lock with short TTL. Same atomic pick-next-available semantics as
 * `lockNextAvailable` but leaves `locked_dseq = NULL` (no dseq yet — POST
 * hasn't happened) and uses a minutes-based TTL so a crash between lock and
 * lease auto-recovers quickly via the sweeper.
 *
 * Promote with `bindLockToDseq` once POST succeeds and lease lands.
 */
export async function lockNextAvailablePending(accountId, workspace, pendingMinutes, conn) {
  const run = async (c) => {
    const [rows] = await c.query(
      "SELECT name FROM `groups` WHERE status = 'AVAILABLE' AND workspace = ? ORDER BY name ASC LIMIT 1 FOR UPDATE",
      [workspace ?? "DEFAULT"],
    );
    if (rows.length === 0) return null;
    const name = rows[0].name;
    await c.query(
      `UPDATE \`groups\` SET status = 'LOCKED', locked_by_account_id = ?, locked_dseq = NULL,
         locked_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE), last_error = NULL
       WHERE name = ?`,
      [accountId, pendingMinutes, name],
    );
    const [updated] = await c.query(
      `SELECT ${COLS} FROM \`groups\` WHERE name = ?`,
      [name],
    );
    return updated[0] ?? null;
  };
  return conn ? run(conn) : withTx(run);
}

/**
 * Promote a pending lock (set by `lockNextAvailablePending`) to the full
 * post-lease state: bind the dseq and extend `expires_at` to `lockHours`.
 *
 * Guard: throws DbError if the row is not currently LOCKED with NULL dseq.
 * That state means the caller is misusing this method (e.g. promoting a
 * lock that already has a dseq, or a row that is not locked).
 */
export async function bindLockToDseq(name, dseq, lockHours, conn) {
  const run = async (c) => {
    const [rows] = await c.query(
      "SELECT status, locked_dseq FROM `groups` WHERE name = ? FOR UPDATE",
      [name],
    );
    if (rows.length === 0) {
      throw new DbError(`groups.bindLockToDseq: group "${name}" not found`);
    }
    const row = rows[0];
    if (row.status !== "LOCKED" || row.locked_dseq != null) {
      throw new DbError(
        `groups.bindLockToDseq: "${name}" not in pending state (status=${row.status}, locked_dseq=${row.locked_dseq ?? "NULL"})`,
      );
    }
    await c.query(
      `UPDATE \`groups\` SET locked_dseq = ?,
         expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR)
       WHERE name = ?`,
      [String(dseq), lockHours, name],
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
