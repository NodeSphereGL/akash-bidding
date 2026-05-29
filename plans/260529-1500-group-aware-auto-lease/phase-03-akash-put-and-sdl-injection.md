---
phase: 3
title: "Akash PUT and SDL Injection"
status: implemented
priority: P1
effort: "3h"
dependencies: []
---

# Phase 3: Akash PUT and SDL Injection

## Overview

Two narrow additions: (a) `akash.updateDeployment(ctx, dseq, sdlString)` that
PUTs `/v1/deployments/{dseq}`, and (b) `src/sdl.js` that loads
`akash-deploy.yaml`, replaces the `GROUP_NAME` env, returns the modified
SDL as a string ready for PUT. Pure functions; no DB, no loop logic.

Independent of Phase 1 — can develop in parallel.

## Requirements

- Functional:
  - `updateDeployment(ctx, dseq, sdl)` calls `PUT /v1/deployments/{dseq}` with
    body `{ data: { sdl } }`, reuses `request()` transport (proxy + timeout).
  - Returns full deployment object on 2xx; throws `AkashApiError` on non-2xx.
  - `src/sdl.js` exports `loadTemplate(path)` and `injectGroupName(template, groupName)`.
  - Injection sets `services.service-rpow.env = ["GROUP_NAME=<name>"]` (replaces
    placeholder, preserves all other fields).
- Non-functional:
  - SDL template parsed once at daemon start, cached in memory. Inject is pure.
  - SDL serialization preserves YAML formatting closely enough that Akash accepts it
    (no semantic differences; whitespace ok).

## Architecture

```
src/
  akash.js               ← MODIFIED: + updateDeployment(ctx, dseq, sdl)
  sdl.js                 ← NEW: loadTemplate, injectGroupName
akash-deploy.yaml        ← MODIFIED: switch to toanbk/rpow2:v1, GROUP_NAME placeholder
```

### akash.js addition (skeleton)

```js
/** PUT /v1/deployments/{dseq} with new SDL. */
export async function updateDeployment(ctx, dseq, sdl) {
  const body = await request(ctx, "PUT",
    `/v1/deployments/${encodeURIComponent(dseq)}`,
    { data: { sdl } });
  return unwrap(body);
}
```

### sdl.js (skeleton)

```js
import { readFile } from "node:fs/promises";
import YAML from "yaml";

export async function loadTemplate(path) {
  const raw = await readFile(path, "utf8");
  const parsed = YAML.parse(raw);
  // sanity: expects services.service-rpow.env array
  return { raw, parsed };
}

/**
 * Replace GROUP_NAME env in the SDL template; return YAML string ready for PUT.
 * Pure — does not mutate input.
 */
export function injectGroupName(template, groupName) {
  const clone = structuredClone(template.parsed);
  const svc = clone.services?.["service-rpow"];
  if (!svc) throw new Error("sdl: services.service-rpow missing");
  svc.env = [`GROUP_NAME=${groupName}`];
  return YAML.stringify(clone);
}
```

### akash-deploy.yaml change

```yaml
version: "2.0"
services:
  service-rpow:
    image: toanbk/rpow2:v1
    expose:
      - port: 80
        as: 80
        to:
          - global: true
    env:
      - GROUP_NAME=__PLACEHOLDER__
profiles:
  compute:
    service-rpow:
      resources:
        cpu: { units: 2 }
        memory: { size: 4gb }
        storage:
          - size: 30gb
        gpu:
          units: 1
          attributes: { vendor: { nvidia: } }
  placement:
    dcloud:
      pricing:
        service-rpow:
          denom: uact
          amount: 100000
deployment:
  service-rpow:
    dcloud:
      profile: service-rpow
      count: 1
```

Backup the existing SSH-only `akash-deploy.yaml` to `akash-deploy.ssh.yaml.bak`
before overwriting (in case operator needs to roll back).

## Related Code Files

- Create:
  - `src/sdl.js`
- Modify:
  - `src/akash.js` — add `updateDeployment`
  - `akash-deploy.yaml` — replace contents per above
- Delete: none (keep `.bak` of the SSH-only SDL during transition)

## Implementation Steps

1. Add `updateDeployment` to `src/akash.js` (after `closeDeployment`).
2. Create `src/sdl.js` with `loadTemplate` + `injectGroupName`.
3. Backup current `akash-deploy.yaml` to `akash-deploy.ssh.yaml.bak`.
4. Overwrite `akash-deploy.yaml` with the rpow2:v1 SDL from `rpow2-deploy.yaml` (already in repo as the example) + the `__PLACEHOLDER__` value.
5. Smoke-test `injectGroupName`:
   ```js
   const t = await loadTemplate("./akash-deploy.yaml");
   console.log(injectGroupName(t, "group_01_vast_ai"));
   // → assert output contains "GROUP_NAME=group_01_vast_ai"
   ```

## Success Criteria

- [ ] Calling `injectGroupName(template, "group_01_vast_ai")` produces YAML containing exactly `GROUP_NAME=group_01_vast_ai` and `image: toanbk/rpow2:v1`.
- [ ] Template object is not mutated by `injectGroupName` (idempotent for same input).
- [ ] `updateDeployment` exported and importable from `src/akash.js`.
- [ ] Manual curl test (no daemon): PUT against a live test dseq with the generated SDL returns 200 OK.

## Risk Assessment

- **YAML serializer differences** — `yaml` package may reformat (e.g., flow vs block style for env list). Akash should accept either; verify via the manual curl test.
- **Missing service key** — sdl.js throws clear error if `services.service-rpow` missing. Operator can rename in the template if they use a different service key.
- **PUT path encoding** — `encodeURIComponent(dseq)` for safety even though dseq is numeric.
- **rpow2-deploy.yaml file** — already in repo at top level; can be removed after overwriting `akash-deploy.yaml` or kept as a reference.

## Notes

- Do NOT inline the SDL string in code. Always load from file → injection → PUT.
- Don't add SDL validation against the Akash schema — KISS, Akash itself will reject bad SDL with a clear error.
