// mysql2/promise pool + helpers. Wraps driver errors in DbError so callers
// don't import mysql2 directly.

import mysql from "mysql2/promise";
import { DbError } from "../errors.js";

let _pool = null;

export function createPool(config) {
  if (_pool) return _pool;
  _pool = mysql.createPool({
    host: config.MYSQL_HOST,
    port: config.MYSQL_PORT,
    user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD,
    database: config.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    multipleStatements: false,
    dateStrings: false,
    timezone: "Z",
  });
  // Force every connection to UTC. Without this, MySQL session inherits
  // SYSTEM (e.g. UTC+7 in Vietnam) → NOW() / CURRENT_TIMESTAMP / DEFAULT
  // values are stored as local but the driver returns them as UTC, breaking
  // every `expires_at < ?` and `created_at < ?` comparison the daemon does
  // (sweeper would never release locks, etc.). With session set to '+00:00',
  // DB time functions match real UTC and align with mysql2's timezone:"Z".
  _pool.on("connection", (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return _pool;
}

export function getPool() {
  if (!_pool) throw new DbError("db.pool.not_initialized — call createPool(config) at boot");
  return _pool;
}

export async function query(sql, params) {
  const pool = getPool();
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (err) {
    throw new DbError(`db.query.failed: ${err.message}`, err);
  }
}

export async function withTx(fn) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    // Only wrap mysql-driver errors. Domain errors thrown by the callback
    // (e.g. NoGroupAvailableError) must keep their identity so callers can
    // branch on instanceof.
    if (err && err.sqlState) {
      throw new DbError(`db.tx.failed: ${err.message}`, err);
    }
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  if (!_pool) return;
  const p = _pool;
  _pool = null;
  try { await p.end(); } catch { /* ignore */ }
}

export async function ping() {
  await query("SELECT 1");
  return true;
}
