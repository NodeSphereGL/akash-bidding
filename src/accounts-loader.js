// Loads and validates accounts.json. Throws with actionable messages on
// missing apiKey, duplicate name, or non-array root. Normalizes empty/missing
// proxy to null.

import { readFile } from "node:fs/promises";

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
    const { name, apiKey, proxy } = entry;
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
    out.push({ name, apiKey, proxy: normalizedProxy });
  });
  return out;
}
