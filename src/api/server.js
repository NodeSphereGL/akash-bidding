// node:http listener bound to 127.0.0.1 (loopback only, no auth). Each
// request: match route → optionally parse JSON body → call handler. Top-level
// try/catch ensures handler crashes don't kill the daemon process.

import { createServer } from "node:http";
import { match } from "./router.js";
import { parseJsonBody, sendJson, sendError, HttpError } from "./json-body.js";

const NEEDS_BODY = new Set(["POST", "PUT", "PATCH"]);

async function handle(req, res, deps) {
  const { logger } = deps;
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const route = match(req.method, url.pathname);
  if (!route) return sendError(res, 404, "NOT_FOUND", `${req.method} ${url.pathname} not found`);

  let body = null;
  if (NEEDS_BODY.has(req.method)) {
    try {
      body = await parseJsonBody(req);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      throw err;
    }
  }

  try {
    await route.handler(req, res, {
      params: route.params,
      query: url.searchParams,
      body,
      deps,
    });
  } catch (err) {
    if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
    logger?.error?.("api.handler.error", {
      method: req.method,
      path: url.pathname,
      error: err.message,
    });
    sendError(res, 500, "INTERNAL", err.message || "internal error");
  }
}

export function startApiServer({ config, logger, abortSignal }) {
  const host = config.API_HOST || "127.0.0.1";
  const port = config.API_PORT || 8088;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    logger?.warn?.("api.bind.non-loopback", { host });
  }

  const server = createServer((req, res) => {
    handle(req, res, { logger }).catch((err) => {
      logger?.error?.("api.unhandled", { error: err.message });
      try { sendError(res, 500, "INTERNAL", "unhandled error"); } catch { /* response already sent */ }
    });
  });

  server.on("error", (err) => {
    logger?.error?.("api.server.error", { error: err.message, code: err.code });
  });

  server.listen(port, host, () => {
    logger?.info?.("api.listen", { host, port });
  });

  abortSignal?.addEventListener("abort", () => {
    server.close();
  }, { once: true });

  return server;
}
