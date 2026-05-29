// accounts repo. Maps snake_case columns to camelCase at this boundary because
// the loop code consumes accounts via existing `account.apiKey` references.

import { query } from "../pool.js";
import { DbError } from "../../errors.js";

const COLS = "id, name, api_key, proxy, workspace, enabled, created_at, updated_at";

function toCamel(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    apiKey: row.api_key,
    proxy: row.proxy,
    workspace: row.workspace,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAll() {
  const rows = await query(`SELECT ${COLS} FROM accounts ORDER BY id ASC`);
  return rows.map(toCamel);
}

export async function listEnabled() {
  const rows = await query(`SELECT ${COLS} FROM accounts WHERE enabled = 1 ORDER BY id ASC`);
  return rows.map(toCamel);
}

export async function get(id) {
  const rows = await query(`SELECT ${COLS} FROM accounts WHERE id = ?`, [id]);
  return toCamel(rows[0]);
}

export async function getByName(name) {
  const rows = await query(`SELECT ${COLS} FROM accounts WHERE name = ?`, [name]);
  return toCamel(rows[0]);
}

export async function insert({ name, apiKey, proxy, enabled, workspace }) {
  try {
    const result = await query(
      "INSERT INTO accounts (name, api_key, proxy, enabled, workspace) VALUES (?, ?, ?, ?, ?)",
      [name, apiKey, proxy ?? null, enabled === false ? 0 : 1, workspace ?? "DEFAULT"],
    );
    return get(result.insertId);
  } catch (err) {
    if (err instanceof DbError && err.code === "ER_DUP_ENTRY") {
      throw new DbError(`accounts.insert: duplicate name "${name}"`, err.cause);
    }
    throw err;
  }
}

export async function update(id, patch) {
  const map = { name: "name", apiKey: "api_key", proxy: "proxy", enabled: "enabled", workspace: "workspace" };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      sets.push(`${col} = ?`);
      params.push(k === "enabled" ? (patch[k] ? 1 : 0) : patch[k]);
    }
  }
  if (sets.length === 0) return get(id);
  params.push(id);
  await query(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, params);
  return get(id);
}

export async function remove(id) {
  const result = await query("DELETE FROM accounts WHERE id = ?", [id]);
  return result.affectedRows > 0;
}
