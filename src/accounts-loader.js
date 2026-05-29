// Loads and validates accounts.json. Throws with actionable messages on
// missing apiKey, duplicate name, or non-array root. Normalizes empty/missing
// proxy to null.

import { readFile } from "node:fs/promises";
import * as accountsRepo from "./db/repo/accounts.js";
import { isValidWorkspace } from "./workspace-validator.js";

export async function loadAccounts(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`accounts: cannot read ${path}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`accounts: ${path} is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`accounts: root must be an array, got ${typeof parsed}`);
  }
  if (parsed.length === 0) {
    throw new Error(`accounts: ${path} is empty`);
  }

  const seen = new Set();
  const out = [];
  parsed.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`accounts[${idx}]: must be an object`);
    }
    const { name, apiKey, proxy, workspace } = entry;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`accounts[${idx}]: missing or empty name`);
    }
    if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey === "REPLACE_ME") {
      throw new Error(`accounts[${idx}] (${name}): missing or placeholder apiKey`);
    }
    if (seen.has(name)) {
      throw new Error(`accounts: duplicate name "${name}"`);
    }
    seen.add(name);
    const normalizedProxy =
      typeof proxy === "string" && proxy.trim().length > 0 ? proxy.trim() : null;
    let normalizedWorkspace;
    if (workspace != null) {
      const ws = typeof workspace === "string" ? workspace.trim() : "";
      if (ws.length === 0) {
        normalizedWorkspace = undefined;
      } else if (!isValidWorkspace(ws)) {
        throw new Error(
          `accounts[${idx}] (${name}): invalid workspace "${ws}" — must match /^[a-z0-9_-]+$/i, max 64 chars`,
        );
      } else {
        normalizedWorkspace = ws;
      }
    }
    out.push({ name, apiKey, proxy: normalizedProxy, workspace: normalizedWorkspace });
  });
  return out;
}

/**
 * Load enabled accounts from the DB. Returns the same shape the loop expects
 * (`{ id, name, apiKey, proxy, enabled }`). Throws if table is empty so the
 * operator gets a clear hint instead of a silent no-op daemon.
 */
export async function loadAccountsFromDb() {
  const rows = await accountsRepo.listEnabled();
  if (rows.length === 0) {
    throw new Error(
      "accounts: table is empty — run 'npm run db:import-accounts' to seed it from accounts.json",
    );
  }
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    apiKey: a.apiKey,
    proxy: a.proxy && a.proxy.trim() ? a.proxy.trim() : null,
    enabled: a.enabled,
    workspace: a.workspace ?? "DEFAULT",
  }));
}
