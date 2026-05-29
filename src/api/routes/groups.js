// Groups admin routes. Wraps groupsRepo. snake_case → camelCase at the JSON
// boundary so external clients don't see DB column conventions.

import * as groupsRepo from "../../db/repo/groups.js";
import { sendJson, sendError, HttpError } from "../json-body.js";
import { DbError } from "../../errors.js";
import { isValidWorkspace } from "../../workspace-validator.js";

const STATUS_VALUES = new Set(["AVAILABLE", "LOCKED", "PUT_FAILED", "DISABLED"]);
const NAME_RE = /^[a-z0-9_]+$/i;

function toJson(row) {
  if (!row) return row;
  return {
    name: row.name,
    branch: row.branch,
    workspace: row.workspace,
    status: row.status,
    lockedByAccountId: row.locked_by_account_id,
    lockedDseq: row.locked_dseq,
    lockedAt: row.locked_at,
    expiresAt: row.expires_at,
    lastNagAt: row.last_nag_at,
    lastError: row.last_error,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function list(req, res, { query }) {
  const status = query.get("status");
  if (status && !STATUS_VALUES.has(status)) {
    throw new HttpError(400, "VALIDATION", `status must be one of ${[...STATUS_VALUES].join(",")}`);
  }
  const workspace = query.get("workspace");
  if (workspace != null && !isValidWorkspace(workspace)) {
    throw new HttpError(400, "VALIDATION", "invalid workspace");
  }
  const rows = await groupsRepo.listAll({ status, workspace: workspace ?? undefined });
  sendJson(res, 200, rows.map(toJson));
}

export async function get(req, res, { params }) {
  const row = await groupsRepo.get(params[0]);
  if (!row) return sendError(res, 404, "NOT_FOUND", `group ${params[0]} not found`);
  sendJson(res, 200, toJson(row));
}

export async function create(req, res, { body }) {
  if (!body || typeof body !== "object") throw new HttpError(400, "VALIDATION", "body required");
  if (!body.name || !NAME_RE.test(body.name)) throw new HttpError(400, "VALIDATION", "invalid name");
  if (!body.branch || typeof body.branch !== "string") throw new HttpError(400, "VALIDATION", "branch required");
  if (body.workspace != null && !isValidWorkspace(body.workspace)) {
    throw new HttpError(400, "VALIDATION", "invalid workspace");
  }
  try {
    const row = await groupsRepo.insert({
      name: body.name,
      branch: body.branch,
      status: body.status,
      notes: body.notes,
      workspace: body.workspace,
    });
    sendJson(res, 201, toJson(row));
  } catch (err) {
    if (err instanceof DbError && (err.code === "ER_DUP_ENTRY" || err.cause?.code === "ER_DUP_ENTRY")) {
      return sendError(res, 409, "DUPLICATE", `group name "${body.name}" already exists`);
    }
    throw err;
  }
}

export async function update(req, res, { params, body }) {
  const name = params[0];
  if (!body || typeof body !== "object") throw new HttpError(400, "VALIDATION", "body required");
  const patch = {};
  if (body.status != null) {
    if (!STATUS_VALUES.has(body.status)) throw new HttpError(400, "VALIDATION", "invalid status");
    patch.status = body.status;
  }
  if (body.branch != null) {
    if (typeof body.branch !== "string") throw new HttpError(400, "VALIDATION", "branch must be string");
    patch.branch = body.branch;
  }
  if (body.notes != null) patch.notes = String(body.notes);
  if (body.workspace != null) {
    if (!isValidWorkspace(body.workspace)) throw new HttpError(400, "VALIDATION", "invalid workspace");
    patch.workspace = body.workspace;
  }
  const existing = await groupsRepo.get(name);
  if (!existing) return sendError(res, 404, "NOT_FOUND", `group ${name} not found`);
  const row = await groupsRepo.update(name, patch);
  sendJson(res, 200, toJson(row));
}

export async function remove(req, res, { params }) {
  const ok = await groupsRepo.remove(params[0]);
  if (!ok) return sendError(res, 404, "NOT_FOUND", `group ${params[0]} not found`);
  sendJson(res, 200, { deleted: true });
}

export async function release(req, res, { params }) {
  const existing = await groupsRepo.get(params[0]);
  if (!existing) return sendError(res, 404, "NOT_FOUND", `group ${params[0]} not found`);
  const row = await groupsRepo.release(params[0]);
  sendJson(res, 200, toJson(row));
}
