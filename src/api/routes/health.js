// Liveness + DB ping. Returns 503 if the pool can't serve a SELECT 1.

import { ping } from "../../db/pool.js";
import { sendJson } from "../json-body.js";

export async function get(req, res) {
  try {
    await ping();
    sendJson(res, 200, { ok: true, db: "connected" });
  } catch (err) {
    sendJson(res, 503, { ok: false, db: "down", error: err.message });
  }
}
