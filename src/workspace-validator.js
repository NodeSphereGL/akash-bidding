// Single source of truth for workspace value rules. Applied at every
// boundary that ingests a workspace value: HTTP API, accounts.json loader,
// import scripts.

export const WORKSPACE_MAX = 64;
export const WORKSPACE_RE = /^[a-z0-9_-]+$/i;

export function isValidWorkspace(v) {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= WORKSPACE_MAX &&
    WORKSPACE_RE.test(v)
  );
}
