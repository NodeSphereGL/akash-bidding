// SDL template loader + GROUP_NAME injector. Pure functions; no DB, no I/O
// beyond the initial readFile.

import { readFile } from "node:fs/promises";
import YAML from "yaml";

const SERVICE_KEY = "service-rpow";

/**
 * @param {string} path
 * @returns {Promise<{ raw: string, parsed: object }>}
 */
export async function loadTemplate(path) {
  const raw = await readFile(path, "utf8");
  const parsed = YAML.parse(raw);
  if (!parsed?.services?.[SERVICE_KEY]) {
    throw new Error(`sdl.loadTemplate: services.${SERVICE_KEY} missing in ${path}`);
  }
  return { raw, parsed };
}

/**
 * Replace GROUP_NAME env in the SDL template; return YAML string ready for PUT.
 * Pure — does not mutate `template`.
 */
export function injectGroupName(template, groupName) {
  if (!template?.parsed) throw new Error("sdl.injectGroupName: template missing");
  if (!groupName || typeof groupName !== "string") {
    throw new Error("sdl.injectGroupName: groupName required");
  }
  const clone = structuredClone(template.parsed);
  const svc = clone.services?.[SERVICE_KEY];
  if (!svc) throw new Error(`sdl.injectGroupName: services.${SERVICE_KEY} missing`);
  // Replaces the full env array. Today the template carries only GROUP_NAME;
  // if other env vars are added to the template they MUST be preserved here.
  svc.env = [`GROUP_NAME=${groupName}`];
  return YAML.stringify(clone);
}
