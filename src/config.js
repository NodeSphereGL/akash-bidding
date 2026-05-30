// Env loader + constants. Reads .env via dotenv, parses + validates required
// numeric fields, fails fast with a clear message if anything is missing or
// invalid.
//
// Pricing model (Validation Session 2):
//   1 uact = $0.000001  (confirmed: deposit:5 USD → 5,000,000 uact in escrow)
//   averageBlockTime = 6.098s  (from Akash Console source `averageBlockTime`)
//   USD/hour = price.amount × 3600 / averageBlockTime / 1e6
// Operator sets `MAX_USD_PER_HOUR` (preferred). Daemon converts it to the
// uact/block cap used by the bid filter. Setting `MAX_UACT_PER_BLOCK`
// directly is still supported as an override for fine-grained tuning.

import "dotenv/config";

export const AVG_BLOCK_TIME_SECONDS = 6.098;
export const UACT_PER_USD = 1_000_000;

export function usdPerHourToUactPerBlock(usdPerHour) {
  const blocksPerHour = 3600 / AVG_BLOCK_TIME_SECONDS;
  return Math.round((usdPerHour * UACT_PER_USD) / blocksPerHour);
}

export function uactPerBlockToUsdPerHour(uactPerBlock) {
  const blocksPerHour = 3600 / AVG_BLOCK_TIME_SECONDS;
  return (uactPerBlock * blocksPerHour) / UACT_PER_USD;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`config: ${name}=${raw} is not a number`);
  return n;
}

function int(name, fallback) {
  const v = num(name, fallback);
  return Math.trunc(v);
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw == null || raw === "" ? fallback : raw;
}

function csvLower(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig() {
  const config = {
    SDL_PATH: str("SDL_PATH", "./akash-deploy.yaml"),
    ACCOUNTS_PATH: str("ACCOUNTS_PATH", "./accounts.json"),
    LOG_FILE: str("LOG_FILE", "./logs/akash-bidding.log"),

    AKASH_API_BASE: str("AKASH_API_BASE", "https://console-api.akash.network"),
    // Chain REST node — Console UI reads bids from here, not from console-api.
    // Console-api's /v1/bids has been observed to return [] when chain has bids.
    AKASH_RPC_BASE: str("AKASH_RPC_BASE", "https://rpc.akt.dev"),

    DEPOSIT_USD: num("DEPOSIT_USD", 5),
    MIN_BALANCE_USD: num("MIN_BALANCE_USD", 5),

    MAX_USD_PER_HOUR: num("MAX_USD_PER_HOUR", NaN),
    MAX_UACT_PER_BLOCK: int("MAX_UACT_PER_BLOCK", 0),
    GPU_BLACKLIST: csvLower("GPU_BLACKLIST"),

    BID_WAIT_MS: int("BID_WAIT_MS", 120000),
    BID_POLL_INTERVAL_MS: int("BID_POLL_INTERVAL_MS", 10000),
    LEASE_HOLD_MS: int("LEASE_HOLD_MS", 3600000),
    RETRY_MIN_MS: int("RETRY_MIN_MS", 60000),
    RETRY_MAX_MS: int("RETRY_MAX_MS", 180000),
    REQUEST_TIMEOUT_MS: int("REQUEST_TIMEOUT_MS", 30000),
    NO_MATCH_EXHAUST_THRESHOLD: int("NO_MATCH_EXHAUST_THRESHOLD", 10),
    STARTUP_JITTER_MS: int("STARTUP_JITTER_MS", 30000),

    TELEGRAM_BOT_TOKEN: str("TELEGRAM_BOT_TOKEN", ""),
    TELEGRAM_CHAT_ID: str("TELEGRAM_CHAT_ID", ""),

    MYSQL_HOST: str("MYSQL_HOST", "127.0.0.1"),
    MYSQL_PORT: int("MYSQL_PORT", 3306),
    MYSQL_USER: str("MYSQL_USER", ""),
    MYSQL_PASSWORD: str("MYSQL_PASSWORD", ""),
    MYSQL_DATABASE: str("MYSQL_DATABASE", ""),

    GROUP_LOCK_HOURS: int("GROUP_LOCK_HOURS", 24),
    SWEEP_INTERVAL_MS: int("SWEEP_INTERVAL_MS", 300_000),
    PUT_NAG_INTERVAL_MS: int("PUT_NAG_INTERVAL_MS", 1_800_000),

    // Admin API bind is hard-coded to 127.0.0.1 in api/server.js — no override.
    API_PORT: int("API_PORT", 8088),
  };

  // MAX_USD_PER_HOUR takes precedence; falls back to MAX_UACT_PER_BLOCK for
  // power users who want the raw chain-denom cap.
  if (Number.isFinite(config.MAX_USD_PER_HOUR) && config.MAX_USD_PER_HOUR > 0) {
    config.MAX_UACT_PER_BLOCK = usdPerHourToUactPerBlock(config.MAX_USD_PER_HOUR);
  }
  if (!(config.MAX_UACT_PER_BLOCK > 0)) {
    throw new Error("config: set MAX_USD_PER_HOUR (preferred) or MAX_UACT_PER_BLOCK > 0");
  }
  if (!(config.BID_WAIT_MS > 0) || !(config.BID_POLL_INTERVAL_MS > 0)) {
    throw new Error("config: BID_WAIT_MS and BID_POLL_INTERVAL_MS must be > 0");
  }
  if (!(config.RETRY_MAX_MS >= config.RETRY_MIN_MS)) {
    throw new Error("config: RETRY_MAX_MS must be >= RETRY_MIN_MS");
  }
  if (!(config.DEPOSIT_USD > 0) || !(config.MIN_BALANCE_USD >= 0)) {
    throw new Error("config: DEPOSIT_USD must be > 0 and MIN_BALANCE_USD >= 0");
  }
  if (!config.MYSQL_USER || !config.MYSQL_DATABASE) {
    throw new Error("config: MYSQL_USER and MYSQL_DATABASE are required");
  }
  if (!(config.GROUP_LOCK_HOURS > 0)) {
    throw new Error("config: GROUP_LOCK_HOURS must be > 0");
  }
  return config;
}
