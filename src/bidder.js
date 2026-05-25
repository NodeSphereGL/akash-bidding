// Pure bid filtering and ranking. No I/O, no globals — fully unit-testable.
//
// Pipeline (R4): drop non-open → extract GPU model → drop blacklisted models
// → parse price.amount → drop bids above MAX_UACT_PER_BLOCK → sort DESC.
// Output is consumed greedy-first by the orchestrator; the tail forms the
// fallback walk on lease failure.

/**
 * @typedef {object} RawBid
 * @typedef {object} BidCandidate
 * @property {RawBid} bid
 * @property {string} model
 * @property {number} uactPerBlock
 * @property {string} provider
 * @property {object} compositeId  // { provider, dseq, gseq, oseq } shape used to create lease
 */

const STATE_OPEN = "open";

/**
 * Walks the bid payload looking for the GPU model. Tolerates two common
 * provider variants of the attributes object: array of { key, value } pairs
 * AND a plain key→value map. Returns lowercase model string or null.
 */
export function extractGpuModel(bid) {
  if (!bid || typeof bid !== "object") return null;

  const offers = bid.resources_offer ?? bid.resourcesOffer ?? bid.bid?.resources_offer;
  if (!Array.isArray(offers)) {
    // Some response shapes flatten the resources block.
    const flat = bid.resources?.gpu ?? bid.gpu;
    return readGpuAttrs(flat);
  }

  for (const offer of offers) {
    const gpu = offer?.resources?.gpu ?? offer?.gpu;
    const model = readGpuAttrs(gpu);
    if (model) return model;
  }
  return null;
}

function readGpuAttrs(gpu) {
  if (!gpu) return null;
  const attrs = gpu.attributes;
  if (!attrs) return null;
  // Array form: [{ key: "model", value: "nvidia-a100-sxm4" }, ...]
  if (Array.isArray(attrs)) {
    const modelAttr = attrs.find((a) => typeof a?.key === "string" && /model/i.test(a.key) && typeof a.value === "string" && a.value.length > 0);
    if (modelAttr) return String(modelAttr.value).toLowerCase();
    // Some payloads place model as a key with empty value (e.g. "vendor/nvidia/model/a100": "").
    for (const a of attrs) {
      const k = a?.key;
      if (typeof k === "string" && /model/i.test(k)) {
        const parts = k.split("/").filter(Boolean);
        return String(parts[parts.length - 1]).toLowerCase();
      }
    }
    return null;
  }
  // Map form: { model: "nvidia-a100-sxm4" }
  if (typeof attrs === "object") {
    const v = attrs.model ?? attrs["vendor/nvidia/model"];
    if (typeof v === "string") return v.toLowerCase();
  }
  return null;
}

export function isBlacklisted(model, blacklist) {
  if (!model || !Array.isArray(blacklist) || blacklist.length === 0) return false;
  return blacklist.some((entry) => entry && model.includes(entry));
}

function extractPriceAmount(bid) {
  // amount may carry trailing zeros / decimal point ("10000" or "10000.000000…")
  const v = bid?.price?.amount ?? bid?.bid?.price?.amount ?? bid?.amount;
  if (v == null) return NaN;
  const n = typeof v === "string" ? Math.floor(parseFloat(v)) : v;
  return Number.isFinite(n) ? n : NaN;
}

function extractProvider(bid) {
  return bid?.id?.provider ?? bid?.provider ?? bid?.bid_id?.provider ?? bid?.bidId?.provider ?? null;
}

function extractCompositeId(bid) {
  const id = bid?.id ?? bid?.bid_id ?? bid?.bidId ?? {};
  return {
    provider: id.provider ?? extractProvider(bid),
    dseq: id.dseq ?? bid?.dseq,
    gseq: id.gseq ?? bid?.gseq,
    oseq: id.oseq ?? bid?.oseq,
  };
}

function extractState(bid) {
  return (bid?.state ?? bid?.bid?.state ?? STATE_OPEN).toString().toLowerCase();
}

/**
 * @param {RawBid[]} rawBids
 * @param {{ gpuBlacklist: string[], maxUactPerBlock: number, logger?: object }} config
 * @returns {BidCandidate[]} DESC-sorted by uactPerBlock
 */
export function filterAndRank(rawBids, config) {
  const { gpuBlacklist = [], maxUactPerBlock, logger } = config;
  if (!Number.isFinite(maxUactPerBlock) || maxUactPerBlock <= 0) {
    throw new Error(`bidder: invalid maxUactPerBlock=${maxUactPerBlock}`);
  }
  if (!Array.isArray(rawBids)) return [];

  const blacklist = gpuBlacklist.map((s) => String(s).toLowerCase().trim()).filter(Boolean);

  const total = rawBids.length;
  const stage1 = rawBids.filter((b) => extractState(b) === STATE_OPEN);

  const stage2 = [];
  for (const bid of stage1) {
    const model = extractGpuModel(bid);
    if (!model) continue;
    if (isBlacklisted(model, blacklist)) continue;
    const uactPerBlock = extractPriceAmount(bid);
    if (!Number.isFinite(uactPerBlock)) continue;
    if (uactPerBlock > maxUactPerBlock) continue;
    stage2.push({
      bid,
      model,
      uactPerBlock,
      provider: extractProvider(bid),
      compositeId: extractCompositeId(bid),
    });
  }

  stage2.sort((a, b) => b.uactPerBlock - a.uactPerBlock);

  logger?.info?.("bidder.filter", {
    total,
    afterStateFilter: stage1.length,
    candidates: stage2.length,
    maxUactPerBlock,
    blacklist,
  });
  return stage2;
}
