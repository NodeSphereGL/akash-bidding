// Typed errors raised across the daemon. AkashApiError represents a server-side
// non-2xx (NOT retriable via proxy fallback). AllExhaustedError is thrown by the
// rotator when every account is in the exhausted set — orchestrator catches it
// to shut down cleanly.

// Keys redacted before storing on AkashApiError.body. Keep this list small;
// the goal is to avoid logs leaking creds if a misbehaving gateway echoes a
// request header in an error envelope.
const SENSITIVE_KEYS = /^(x-?api-?key|authorization|cookie|set-cookie|token|secret|password)$/i;
const MAX_BODY_LEN = 2000;

function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > MAX_BODY_LEN ? value.slice(0, MAX_BODY_LEN) + "…" : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(redact);
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

export class AkashApiError extends Error {
  constructor(status, code, body) {
    super(`Akash API ${status}: ${code ?? "unknown"}`);
    this.name = "AkashApiError";
    this.status = status;
    this.code = code;
    this.body = redact(body);
  }
}

export class AllExhaustedError extends Error {
  constructor(message = "all accounts exhausted") {
    super(message);
    this.name = "AllExhaustedError";
  }
}
