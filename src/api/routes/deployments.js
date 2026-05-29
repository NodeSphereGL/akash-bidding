// Deployments read-only routes (audit log surface).

import * as deploymentsRepo from "../../db/repo/deployments.js";
import { sendJson, sendError, HttpError } from "../json-body.js";

function toJson(row) {
  if (!row) return row;
  return {
    id: row.id,
    dseq: row.dseq,
    accountId: row.account_id,
    groupName: row.group_name,
    provider: row.provider,
    uactPerBlock: row.uact_per_block,
    status: row.status,
    leasedAt: row.leased_at,
    expiresAt: row.expires_at,
    putAttempts: row.put_attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function list(req, res, { query }) {
  const accountIdRaw = query.get("account_id");
  const status = query.get("status");
  const limitRaw = query.get("limit");
  let accountId;
  if (accountIdRaw != null && accountIdRaw !== "") {
    accountId = Number(accountIdRaw);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new HttpError(400, "VALIDATION", "account_id must be positive int");
    }
  }
  const limit = limitRaw ? Math.min(Number(limitRaw) || 200, 1000) : undefined;
  const rows = await deploymentsRepo.list({ accountId, status, limit });
  sendJson(res, 200, rows.map(toJson));
}

export async function get(req, res, { params }) {
  const row = await deploymentsRepo.get(params[0]);
  if (!row) return sendError(res, 404, "NOT_FOUND", `deployment ${params[0]} not found`);
  sendJson(res, 200, toJson(row));
}
