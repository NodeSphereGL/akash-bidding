#!/usr/bin/env node
// One-shot test that fires every notifier type so you can eyeball the format
// in Telegram. Run: npm run test-telegram

import "dotenv/config";
import {
  sendTelegram,
  notifyLeaseSuccess,
  notifyAllDepleted,
  notifyAuthFail,
  notifySdlFail,
  notifyFatal,
  notifyCrash,
} from "../src/notify.js";

const cfg = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
};

if (!cfg.botToken || !cfg.chatId) {
  console.error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing in .env");
  process.exit(1);
}

const fakeAccount = { name: "trial-test" };
const fakeBid = {
  model: "nvidia-rtx4090",
  uactPerBlock: 1500,
  provider: "akash1prov_test_xxxxxxxxxxxxxxxxxxxxxx",
  compositeId: { dseq: "26970000", gseq: 1, oseq: 1, provider: "akash1prov_test" },
};
const fakeLease = { id: "akash1prov_test/26970000/1/1", dseq: "26970000" };

const sequence = [
  ["smoke", () => sendTelegram("🧪 <b>Akash Bidder Smoke Test</b>\nIf you see this, Telegram wiring is OK.", cfg)],
  ["leaseSuccess", () => notifyLeaseSuccess({ bid: fakeBid, lease: fakeLease, account: fakeAccount }, cfg)],
  ["authFail", () => notifyAuthFail(fakeAccount, cfg)],
  ["sdlFail", () => notifySdlFail(new Error("akash-deploy.yaml not found (test)"), cfg)],
  ["fatal", () => notifyFatal("Accounts Load Failed", new Error("test config error"), cfg)],
  ["allDepleted", () => notifyAllDepleted(3, cfg)],
  ["crash", () => notifyCrash(new Error("simulated uncaught (test)"), cfg)],
];

for (const [name, fn] of sequence) {
  process.stdout.write(`→ ${name.padEnd(14)} ... `);
  const ok = await fn();
  console.log(ok ? "OK" : "FAILED");
  await new Promise((r) => setTimeout(r, 800));
}
console.log("\nDone. Check the Telegram chat for 7 messages.");
