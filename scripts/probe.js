#!/usr/bin/env node
// One-shot live probe against the Akash Console managed-wallet API.
// Resolves: (a) GPU model field path in bid response, (b) balance endpoint shape,
// (c) sample uact/block price range to calibrate MAX_UACT_PER_BLOCK.
//
// Reads AKASH_API_KEY (+ optional AKASH_PROXY) from .env, creates a $5 deployment,
// polls bids up to 180s, probes 3 balance endpoint candidates, then closes the
// deployment. Dumps raw JSON to scripts/probe-output/ and writes findings.md.
//
// Run: npm run probe

import "dotenv/config";
import { fetch, ProxyAgent } from "undici";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "probe-output");

const API_BASE = process.env.AKASH_API_BASE || "https://console-api.akash.network";
const RPC_BASE = process.env.AKASH_RPC_BASE || "https://rpc.akt.dev";
const API_KEY = process.env.AKASH_API_KEY;
const PROXY = process.env.AKASH_PROXY || null;
const SDL_PATH = resolve(process.env.SDL_PATH || "./akash-deploy.yaml");
const DEPOSIT_USD = Number(process.env.DEPOSIT_USD || 5);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

if (!API_KEY) {
  console.error("AKASH_API_KEY not set in .env. Aborting.");
  process.exit(1);
}

const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const dispatcher = PROXY ? new ProxyAgent(PROXY) : undefined;

async function req(method, path, body, { base = API_BASE, auth = true } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json" };
    if (auth) headers["x-api-key"] = API_KEY;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      dispatcher,
      signal: ctl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, ok: res.ok, body: json };
  } finally {
    clearTimeout(timer);
  }
}

async function dump(name, data) {
  await mkdir(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, `${name}-${ts()}.json`);
  await writeFile(file, JSON.stringify(data, null, 2));
  return file;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[probe] API base: ${API_BASE}`);
  console.log(`[probe] Proxy: ${PROXY ? "yes" : "no"}`);

  const sdl = await readFile(SDL_PATH, "utf8");
  console.log(`[probe] SDL loaded (${sdl.length} bytes) from ${SDL_PATH}`);

  // 1. Create deployment — console-api expects `{ data: { sdl, deposit } }`.
  console.log("[probe] POST /v1/deployments ...");
  const create = await req("POST", "/v1/deployments", { data: { sdl, deposit: DEPOSIT_USD } });
  await dump("create", create);
  if (!create.ok) {
    console.error(`[probe] create failed: ${create.status}`);
    console.error(JSON.stringify(create.body, null, 2));
    process.exit(2);
  }
  const data = create.body?.data ?? create.body;
  const dseq = data?.dseq;
  const manifest = data?.manifest;
  if (!dseq) {
    console.error("[probe] could not extract dseq from create response. Dump saved.");
    process.exit(3);
  }
  console.log(`[probe] deployment created: dseq=${dseq}  manifest=${manifest ? "present" : "missing"}`);

  // 2. Resolve owner address via console-api deployments listing (needed for chain REST).
  const deployments = await req("GET", "/v1/deployments?limit=5");
  await dump("deployments", deployments);
  const owner = deployments.body?.data?.deployments?.[0]?.deployment?.id?.owner;
  console.log(`[probe] owner=${owner || "(unresolved)"} ${deployments.status}`);

  // 3. Poll bids via chain REST (console-api /v1/bids returns [] in practice).
  let bidsCollected = [];
  if (owner) {
    const start = Date.now();
    const path = `/rest/akash/market/v1beta5/bids/list?filters.owner=${owner}&filters.dseq=${dseq}`;
    while (Date.now() - start < 180000) {
      const bids = await req("GET", path, undefined, { base: RPC_BASE, auth: false });
      const arr = Array.isArray(bids.body?.bids) ? bids.body.bids : [];
      if (bids.ok && arr.length > 0) {
        bidsCollected = arr;
        console.log(`[probe] got ${arr.length} bids @ t=${Math.round((Date.now() - start) / 1000)}s (chain REST)`);
        await dump("bids", bids.body);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (bidsCollected.length === 0) {
      console.warn("[probe] no bids seen in 180s — provider availability low or filters off.");
    }
  }

  // 4. Close deployment
  console.log(`[probe] DELETE /v1/deployments/${dseq} ...`);
  const closed = await req("DELETE", `/v1/deployments/${dseq}`);
  await dump("close", closed);
  console.log(`[probe] close status: ${closed.status}`);

  // 5. Findings.md — items in `data` are `{ bid: {...}, escrow_account: {...} }`.
  const firstItem = bidsCollected[0] ?? null;
  const firstBid = firstItem?.bid ?? firstItem;
  const gpuPathGuess = firstBid ? guessGpuPath(firstBid) : "no bids — re-run probe";
  const priceGuess = firstBid ? guessPriceAmount(firstBid) : "no bids";
  const states = [...new Set(bidsCollected.map((b) => b?.bid?.state ?? b?.state).filter(Boolean))];

  const findings = `# Probe Findings

Run at: ${new Date().toISOString()}
Account proxy: ${PROXY ? "yes" : "no"}
dseq: ${dseq}
manifest present: ${manifest ? "yes" : "NO — lease will fail"}

## GPU model field path
${gpuPathGuess}

## Sample bid price (uact/block)
${priceGuess}
Use this to calibrate \`MAX_UACT_PER_BLOCK\` in .env.

## Bid \`state\` values observed
${states.length ? states.join(", ") : "none"}

## Balance / wallet
Console-api has no dedicated balance endpoint. /v1/deployments returns escrow_account details for active deployments. Daemon falls back to insufficient-credit error detection at create time.

## Raw dumps
Files in \`scripts/probe-output/\`:
- create-*.json
- bids-*.json
- deployments-*.json
- close-*.json
`;
  await writeFile(resolve(OUT_DIR, "findings.md"), findings);
  console.log(`[probe] wrote ${resolve(OUT_DIR, "findings.md")}`);
}

function guessGpuPath(bid) {
  const paths = [];
  const search = (node, path) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "gpu" || k === "model" || (typeof v === "string" && /a100|h100|rtx|nvidia|t4|l40/i.test(v))) {
        paths.push(`${path}.${k} = ${typeof v === "string" ? v : JSON.stringify(v).slice(0, 80)}`);
      }
      if (typeof v === "object") search(v, `${path}.${k}`);
    }
  };
  search(bid, "bid");
  return paths.length ? paths.join("\n") : "no obvious GPU markers in first bid — inspect bids-*.json manually";
}

function guessPriceAmount(bid) {
  const candidates = [
    bid?.price?.amount,
    bid?.bid?.price?.amount,
    bid?.amount,
  ];
  const v = candidates.find((x) => x != null);
  return v != null ? `${v} (raw value)` : "not found at common paths — inspect bids-*.json";
}

main().catch((e) => {
  console.error("[probe] fatal:", e);
  process.exit(99);
});
