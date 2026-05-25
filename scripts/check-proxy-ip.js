#!/usr/bin/env node
// Verifies each account's outbound IP matches its configured proxy. Reads
// accounts.json, hits https://api.ipify.org through each proxy, prints a
// table. Use as a one-shot pre-flight check before starting the daemon.
//
// Run: npm run check-proxy

import "dotenv/config";
import { fetch, ProxyAgent } from "undici";
import { resolve } from "node:path";
import { loadAccounts } from "../src/accounts-loader.js";

const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const ACCOUNTS_PATH = resolve(process.env.ACCOUNTS_PATH || "./accounts.json");

async function ipFor(proxy) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
      signal: ctl.signal,
    });
    const body = await res.json();
    return body.ip;
  } catch (err) {
    return `ERROR: ${err.code || err.message}`;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const accounts = await loadAccounts(ACCOUNTS_PATH);
  console.log(`Checking outbound IP for ${accounts.length} account(s)\n`);
  console.log("name".padEnd(20) + "proxy".padEnd(50) + "outbound IP");
  console.log("-".repeat(90));
  for (const a of accounts) {
    const ip = await ipFor(a.proxy);
    const proxyLabel = a.proxy ? a.proxy.replace(/:[^@]+@/, ":***@") : "(direct)";
    console.log(a.name.padEnd(20) + proxyLabel.padEnd(50) + ip);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
