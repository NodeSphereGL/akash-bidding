// Accounts admin routes. accountsRepo already returns camelCase, so toJson
// is mostly a passthrough (drop apiKey from list responses to reduce leak risk
// even though the API is loopback-only).

import * as accountsRepo from "../../db/repo/accounts.js";
import { sendJson, sendError, HttpError } from "../json-body.js";
import { DbError } from "../../errors.js";

function toJson(a, { includeApiKey } = {}) {
  if (!a) return a;
  const out = {
    id: a.id,
    name: a.name,
    proxy: a.proxy,
    enabled: a.enabled,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
  if (includeApiKey) out.apiKey = a.apiKey;
  return out;
}

export async function list(req, res, { query }) {
  const enabledRaw = query.get("enabled");
  const rows = enabledRaw === "true"
    ? await accountsRepo.listEnabled()
    : await accountsRepo.listAll();
  sendJson(res, 200, rows.map((a) => toJson(a)));
}

export async function get(req, res, { params }) {
  const id = Number(params[0]);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "VALIDATION", "id must be positive int");
  const row = await accountsRepo.get(id);
  if (!row) return sendError(res, 404, "NOT_FOUND", `account ${id} not found`);
  sendJson(res, 200, toJson(row, { includeApiKey: true }));
}

export async function create(req, res, { body }) {
  if (!body || typeof body !== "object") throw new HttpError(400, "VALIDATION", "body required");
  if (!body.name || typeof body.name !== "string") throw new HttpError(400, "VALIDATION", "name required");
  if (!body.apiKey || typeof body.apiKey !== "string") throw new HttpError(400, "VALIDATION", "apiKey required");
  try {
    const row = await accountsRepo.insert({
      name: body.name,
      apiKey: body.apiKey,
      proxy: body.proxy ?? null,
      enabled: body.enabled !== false,
    });
    sendJson(res, 201, toJson(row, { includeApiKey: true }));
  } catch (err) {
    if (err instanceof DbError && err.cause?.code === "ER_DUP_ENTRY") {
      return sendError(res, 409, "DUPLICATE", `account name "${body.name}" already exists`);
    }
    throw err;
  }
}

export async function update(req, res, { params, body }) {
  const id = Number(params[0]);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "VALIDATION", "id must be positive int");
  if (!body || typeof body !== "object") throw new HttpError(400, "VALIDATION", "body required");
  const existing = await accountsRepo.get(id);
  if (!existing) return sendError(res, 404, "NOT_FOUND", `account ${id} not found`);
  const patch = {};
  for (const k of ["name", "apiKey", "proxy", "enabled"]) {
    if (k in body) patch[k] = body[k];
  }
  const row = await accountsRepo.update(id, patch);
  sendJson(res, 200, toJson(row, { includeApiKey: true }));
}

export async function remove(req, res, { params }) {
  const id = Number(params[0]);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "VALIDATION", "id must be positive int");
  const ok = await accountsRepo.remove(id);
  if (!ok) return sendError(res, 404, "NOT_FOUND", `account ${id} not found`);
  sendJson(res, 200, { deleted: true });
}
