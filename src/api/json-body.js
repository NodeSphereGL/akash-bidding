// Async body parser. Caps body at 100 KB to bound JSON parse cost.

const DEFAULT_LIMIT = 100 * 1024;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function parseJsonBody(req, { limit = DEFAULT_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size === 0) return resolve(null);
      const ct = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (ct && ct !== "application/json") {
        return reject(new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", `content-type must be application/json (got ${ct})`));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new HttpError(400, "INVALID_JSON", err.message));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: message, code });
}
