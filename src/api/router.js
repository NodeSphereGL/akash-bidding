// Tiny method+regex router. No Express. Returns { handler, params } or null.

import * as groups from "./routes/groups.js";
import * as accounts from "./routes/accounts.js";
import * as deployments from "./routes/deployments.js";
import * as health from "./routes/health.js";

const routes = [
  { method: "GET",    pattern: /^\/health$/,                              handler: health.get },

  { method: "GET",    pattern: /^\/v1\/groups$/,                          handler: groups.list },
  { method: "POST",   pattern: /^\/v1\/groups$/,                          handler: groups.create },
  { method: "POST",   pattern: /^\/v1\/groups\/([^/]+)\/release$/,        handler: groups.release },
  { method: "GET",    pattern: /^\/v1\/groups\/([^/]+)$/,                 handler: groups.get },
  { method: "PUT",    pattern: /^\/v1\/groups\/([^/]+)$/,                 handler: groups.update },
  { method: "DELETE", pattern: /^\/v1\/groups\/([^/]+)$/,                 handler: groups.remove },

  { method: "GET",    pattern: /^\/v1\/accounts$/,                        handler: accounts.list },
  { method: "POST",   pattern: /^\/v1\/accounts$/,                        handler: accounts.create },
  { method: "GET",    pattern: /^\/v1\/accounts\/(\d+)$/,                 handler: accounts.get },
  { method: "PUT",    pattern: /^\/v1\/accounts\/(\d+)$/,                 handler: accounts.update },
  { method: "DELETE", pattern: /^\/v1\/accounts\/(\d+)$/,                 handler: accounts.remove },

  { method: "GET",    pattern: /^\/v1\/deployments$/,                     handler: deployments.list },
  { method: "GET",    pattern: /^\/v1\/deployments\/([^/]+)$/,            handler: deployments.get },
];

export function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.pattern);
    if (m) return { handler: r.handler, params: m.slice(1) };
  }
  return null;
}
