// Telegram notifiers. Low-level sendTelegram() ported from cosmos-rescue,
// plus 5 typed notifiers for the events in R9. Failures never reject upstream.
// When TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset, all notifiers return
// false silently (operator opt-out by leaving env blank).

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MSG_LEN = 4000;
const TELEGRAM_TIMEOUT_MS = 10_000;

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(s, max) {
  s = String(s);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * @param {string} message - HTML-formatted message body
 * @param {{ botToken?: string, chatId?: string, logger?: object }} cfg
 * @returns {Promise<boolean>}
 */
export async function sendTelegram(message, cfg) {
  const { botToken, chatId, logger } = cfg || {};
  if (!botToken || !chatId) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncate(message, MAX_MSG_LEN),
        parse_mode: "HTML",
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger?.warn?.("telegram.send.failed", { status: res.status, body: body.slice(0, 400) });
      return false;
    }
    return true;
  } catch (err) {
    logger?.warn?.("telegram.send.error", { error: err.message });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyLeaseSuccess({ bid, lease, account, group, putStatus }, cfg) {
  const lines = [
    "🎯 <b>Akash Lease Acquired</b>",
    `<code>${new Date().toISOString()}</code>`,
    "",
    `Account: <b>${htmlEscape(account?.name ?? "?")}</b>`,
    `GPU: <b>${htmlEscape(bid?.model ?? "?")}</b>`,
    `Price: <b>${htmlEscape(bid?.uactPerBlock ?? "?")} uact/block</b>`,
    `Provider: <code>${htmlEscape(bid?.provider ?? "?")}</code>`,
    `dseq: <code>${htmlEscape(lease?.dseq ?? bid?.compositeId?.dseq ?? "?")}</code>`,
    `Lease: <code>${htmlEscape(lease?.id ?? lease?.leaseId ?? "?")}</code>`,
  ];
  if (group) lines.push(`Group: <b>${htmlEscape(group)}</b>`);
  if (putStatus) lines.push(`PUT: <b>${htmlEscape(putStatus)}</b>`);
  lines.push("", "Deposit: $5.00", "Next cycle in 1h.");
  return sendTelegram(lines.join("\n"), cfg);
}

export async function notifyPutFailed({ dseq, reason, group, account }, cfg) {
  const msg = [
    "❌ <b>Akash PUT Failed</b>",
    `<code>${new Date().toISOString()}</code>`,
    "",
    `Account: <b>${htmlEscape(account?.name ?? "?")}</b>`,
    `dseq: <code>${htmlEscape(dseq ?? "?")}</code>`,
    `Group: <code>${htmlEscape(group ?? "n/a")}</code>`,
    `Reason: ${htmlEscape(reason ?? "unknown")}`,
    "",
    "Deployment is alive but running placeholder image. Fix manually or release group.",
  ].join("\n");
  return sendTelegram(msg, cfg);
}

export async function notifyPutFailedNag(group, cfg) {
  const msg = [
    "⚠️ <b>PUT FAILED — manual action required</b>",
    `<code>${new Date().toISOString()}</code>`,
    "",
    `Group: <b>${htmlEscape(group?.name ?? "?")}</b>`,
    `dseq: <code>${htmlEscape(group?.locked_dseq ?? "?")}</code>`,
    `Account ID: ${htmlEscape(group?.locked_by_account_id ?? "?")}`,
    `Locked at: <code>${htmlEscape(group?.locked_at ?? "?")}</code>`,
    `Expires at: <code>${htmlEscape(group?.expires_at ?? "?")}</code>`,
    `Last error: ${htmlEscape(group?.last_error ?? "n/a")}`,
    "",
    `Resolve via: POST /v1/groups/${htmlEscape(group?.name ?? "")}/release  OR  PUT /v1/groups/${htmlEscape(group?.name ?? "")} {status:"AVAILABLE"}`,
  ].join("\n");
  return sendTelegram(msg, cfg);
}

export async function notifyLeaseOrphan({ account, dseq, error }, cfg) {
  const msg = [
    "🛑 <b>LEASE ORPHAN — chain lease succeeded but DB tx failed</b>",
    `<code>${new Date().toISOString()}</code>`,
    "",
    `Account: <b>${htmlEscape(account?.name ?? "?")}</b>`,
    `dseq: <code>${htmlEscape(dseq ?? "?")}</code>`,
    `Error: ${htmlEscape(error ?? "unknown")}`,
    "",
    "Akash is accruing cost on this deployment with no local record.",
    "Action: close via console UI or scripts/ops/close-test-leases.js.",
  ].join("\n");
  return sendTelegram(msg, cfg);
}

export async function notifySweepRelease(count, cfg) {
  return sendTelegram(`🧹 Sweeper released ${Number(count) || 0} group lock(s).`, cfg);
}

export async function notifyAllDepleted(accountsCount, cfg) {
  const msg = [
    "🛑 <b>Akash Bidder Stopping</b>",
    `All ${Number(accountsCount) || 0} accounts have balance &lt; $5.`,
    "Top up and restart.",
  ].join("\n");
  return sendTelegram(msg, cfg);
}

export async function notifyAuthFail(account, cfg) {
  const msg = [
    "⚠️ <b>Account Auth Failed</b>",
    `${htmlEscape(account?.name ?? "?")} returned 401. Marked exhausted.`,
  ].join("\n");
  return sendTelegram(msg, cfg);
}

export async function notifySdlFail(error, cfg) {
  return notifyFatal("SDL Load Failed", error, cfg);
}

export async function notifyFatal(title, error, cfg) {
  const msg = [
    `❌ <b>${htmlEscape(title)}</b>`,
    htmlEscape(error?.message ?? String(error)),
    "Daemon exiting before loop.",
  ].join("\n");
  return sendTelegram(msg, cfg);
}

export async function notifyCrash(error, cfg) {
  const stack = error?.stack ? error.stack.split("\n").slice(0, 5).join("\n") : String(error);
  const msg = [
    "💥 <b>Akash Bidder Crashed</b>",
    `<code>${htmlEscape(truncate(stack, 1500))}</code>`,
    "Exiting with code 1.",
  ].join("\n");
  return sendTelegram(msg, cfg);
}

export const __test = { htmlEscape, truncate };
