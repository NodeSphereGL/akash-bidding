// Akash REST client. Two backends:
//   • console-api  (managed-wallet) — create/lease/close/list deployments. Needs x-api-key.
//   • chain RPC REST              — bid listing. Public, no auth. Console UI uses this too,
//                                    because console-api's /v1/bids has been observed to
//                                    return [] when the chain has live bids.
//
// Both share the same transport: per-call ProxyAgent injection (memoized),
// 30s AbortController timeout, retry-once-without-proxy on transport errors.

import { fetch, ProxyAgent } from "undici";
import { AkashApiError } from "./errors.js";

const agentCache = new Map();
const ownerCache = new Map(); // account.name → owner address

function getDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  let agent = agentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    agentCache.set(proxyUrl, agent);
  }
  return agent;
}

function isTransportError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  const code = err.code || err.cause?.code;
  if (!code) return false;
  return (
    code.startsWith("UND_ERR_") ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND"
  );
}

async function doFetch({ url, headers, dispatcher, method, body, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      dispatcher,
      signal: ctl.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function transport(ctx, { url, headers, method, body }) {
  const { account, config, logger } = ctx;
  const baseArgs = {
    url,
    headers,
    method,
    body,
    timeoutMs: config.REQUEST_TIMEOUT_MS,
  };

  try {
    return await doFetch({ ...baseArgs, dispatcher: getDispatcher(account.proxy) });
  } catch (err) {
    if (account.proxy && isTransportError(err)) {
      logger?.warn?.("proxy.fallback", {
        account: account.name,
        proxy: account.proxy,
        errorCode: err.code || err.cause?.code || err.name,
      });
      return await doFetch({ ...baseArgs, dispatcher: undefined });
    }
    throw err;
  }
}

// Cloudflare caches GET responses from console-api with `Cache-Control:
// private, max-age=30` and a cache key that does NOT include `x-api-key`.
// Result: whoever warms the cache first, the next 30s of GETs from *any*
// api-key get that first response — so different accounts see each other's
// deployments. Confirmed by `cf-cache-status: HIT` in the response headers.
// Curl avoided it by accident (different connection patterns). The fix is
// a per-call cache-buster query param so every GET is unique → MISS.
function bustCache(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_t=${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Console managed-wallet request. Adds x-api-key. Throws AkashApiError on non-2xx. */
export async function request(ctx, method, path, body) {
  const { account, config } = ctx;
  const finalPath = method === "GET" ? bustCache(path) : path;
  const res = await transport(ctx, {
    url: `${config.AKASH_API_BASE}${finalPath}`,
    headers: {
      "x-api-key": account.apiKey,
      "Content-Type": "application/json",
    },
    method,
    body,
  });
  if (!res.ok) {
    const code = res.body?.code || res.body?.error || res.body?.message;
    throw new AkashApiError(res.status, code, res.body);
  }
  return res.body;
}

/** Chain REST request — no api-key, GET only. Throws AkashApiError on non-2xx. */
async function chainRequest(ctx, path) {
  const { config } = ctx;
  const res = await transport(ctx, {
    url: `${config.AKASH_RPC_BASE}${path}`,
    headers: { "Content-Type": "application/json" },
    method: "GET",
  });
  if (!res.ok) {
    const code = res.body?.code || res.body?.error || res.body?.message;
    throw new AkashApiError(res.status, code, res.body);
  }
  return res.body;
}

function unwrap(body) {
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

/**
 * Create deployment from raw SDL string.
 * @returns { dseq, manifest, txHash } — manifest must be passed verbatim to createLease.
 */
export async function createDeployment(ctx, sdl, depositUsd) {
  const body = await request(ctx, "POST", "/v1/deployments", { data: { sdl, deposit: depositUsd } });
  const data = unwrap(body);
  const dseq = data?.dseq;
  if (!dseq) throw new AkashApiError(200, "no_dseq_in_response", body);
  return {
    dseq,
    manifest: data?.manifest ?? null,
    txHash: data?.signTx?.transactionHash ?? data?.txHash ?? null,
    raw: data,
  };
}

/**
 * Fetch bids from the chain REST. Console-api's /v1/bids is empty in practice;
 * the UI itself uses this same endpoint. Returns array of bare bid objects
 * (unwrapping `{ bid, escrow_account }` items) so the bidder sees
 * `{ id, state, price, resources_offer }` directly.
 */
export async function getBids(ctx, dseq, owner) {
  if (!owner) throw new Error("getBids: owner address required");
  const path = `/rest/akash/market/v1beta5/bids/list?filters.owner=${encodeURIComponent(owner)}&filters.dseq=${encodeURIComponent(dseq)}`;
  const body = await chainRequest(ctx, path);
  if (!body || !Array.isArray(body.bids)) return [];
  return body.bids.map((item) => item?.bid ?? item);
}

/** Create lease against picked bid. */
export async function createLease(ctx, compositeId, manifest) {
  const lease = {
    dseq: String(compositeId.dseq),
    gseq: Number(compositeId.gseq),
    oseq: Number(compositeId.oseq),
    provider: compositeId.provider,
  };
  const body = await request(ctx, "POST", "/v1/leases", { manifest, leases: [lease] });
  return unwrap(body);
}

/** Close deployment. Idempotent — 404 treated as already-closed. */
export async function closeDeployment(ctx, dseq) {
  try {
    await request(ctx, "DELETE", `/v1/deployments/${encodeURIComponent(dseq)}`);
  } catch (err) {
    if (err instanceof AkashApiError && err.status === 404) return;
    throw err;
  }
}

/**
 * PUT /v1/deployments/{dseq} with new SDL string.
 *
 * No longer called by `runAccountLoop` — the orchestrator now POSTs the SDL
 * with the real GROUP_NAME baked in (lock-before-POST flow), eliminating the
 * post-lease PUT and the 2nd ReplicaSet it would cause on the provider.
 *
 * Retained for ops tooling (e.g. manual SDL refresh for a stuck lease).
 * Returns the unwrapped response body; throws AkashApiError on non-2xx.
 */
export async function updateDeployment(ctx, dseq, sdl) {
  const body = await request(
    ctx,
    "PUT",
    `/v1/deployments/${encodeURIComponent(dseq)}`,
    { data: { sdl } },
  );
  return unwrap(body);
}

/**
 * PATCH /v2/deployment-settings/{dseq} to disable auto-topup. Without this
 * the console managed-wallet auto-refills escrow when it drains → cost
 * accrues forever. We want a one-way trip: lease → run → drain → evict.
 * Throws AkashApiError on non-2xx; caller decides whether to mark
 * `auto_topup_disabled` or schedule a sweeper retry.
 */
export async function disableAutoTopUp(ctx, dseq) {
  const body = await request(
    ctx,
    "PATCH",
    `/v2/deployment-settings/${encodeURIComponent(dseq)}`,
    { data: { autoTopUpEnabled: false } },
  );
  return unwrap(body);
}

/**
 * Health check + key validation. Console-api has no balance endpoint; we
 * confirm the api-key works by listing deployments and rely on
 * insufficient-credit-at-create as the financial exhaustion signal.
 *
 * Side effect: caches the account's owner address if any prior deployment
 * is found, so subsequent getBids() calls don't need an extra round-trip.
 */
export async function getBalance(ctx) {
  const body = await request(ctx, "GET", "/v1/deployments?limit=1");
  const data = unwrap(body);
  const owner = data?.deployments?.[0]?.deployment?.id?.owner;
  if (owner) ownerCache.set(ctx.account.name, owner);
  return null;
}

/**
 * Returns the cosmos address that owns this account's deployments. Lazy:
 * first attempts the cache, then `/v1/deployments?limit=1`, then falls back
 * to `/v1/deployments/{dseq}` if a dseq was just created and the account
 * had no prior deployments.
 */
export async function getOwnerAddress(ctx, fallbackDseq) {
  const cached = ownerCache.get(ctx.account.name);
  if (cached) return cached;

  const list = await request(ctx, "GET", "/v1/deployments?limit=1");
  const listData = unwrap(list);
  let owner = listData?.deployments?.[0]?.deployment?.id?.owner;

  if (!owner && fallbackDseq != null) {
    const one = await request(ctx, "GET", `/v1/deployments/${encodeURIComponent(fallbackDseq)}`);
    owner = unwrap(one)?.deployment?.id?.owner;
  }

  if (!owner) {
    throw new AkashApiError(200, "owner_address_unresolvable", { dseq: fallbackDseq });
  }
  ownerCache.set(ctx.account.name, owner);
  return owner;
}

export const __test = { isTransportError, unwrap, ownerCache };
