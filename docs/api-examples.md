# Admin API examples

The daemon binds the admin API to `127.0.0.1:${API_PORT}` (default `8088`).
No auth. Use SSH-tunnel for remote access:

```bash
ssh -L 8088:127.0.0.1:8088 user@your-server
# then curl localhost:8088 from your laptop
```

## Health

```bash
curl -s http://127.0.0.1:8088/health
# 200 {"ok":true,"db":"connected"}
# 503 {"ok":false,"db":"down","error":"..."}
```

## Groups

```bash
# list all
curl -s http://127.0.0.1:8088/v1/groups | jq

# filter by status
curl -s 'http://127.0.0.1:8088/v1/groups?status=AVAILABLE' | jq
curl -s 'http://127.0.0.1:8088/v1/groups?status=PUT_FAILED' | jq

# filter by workspace
curl -s 'http://127.0.0.1:8088/v1/groups?workspace=validator247' | jq
curl -s 'http://127.0.0.1:8088/v1/groups?workspace=DEFAULT&status=AVAILABLE' | jq

# re-tag a group's workspace (takes effect next lock cycle even if currently LOCKED)
curl -s -X PUT http://127.0.0.1:8088/v1/groups/v247_group_01 \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"validator247"}'

# single
curl -s http://127.0.0.1:8088/v1/groups/group_01_vast_ai | jq

# create
curl -s -X POST http://127.0.0.1:8088/v1/groups \
  -H 'Content-Type: application/json' \
  -d '{"name":"group_99_test","branch":"release/group_99_test","notes":"experimental"}'

# disable a bad v247 group so daemon stops picking it
curl -s -X PUT http://127.0.0.1:8088/v1/groups/v247_group_05 \
  -H 'Content-Type: application/json' \
  -d '{"status":"DISABLED"}'

# force-release a stuck lock (PUT_FAILED, dead deployment, etc.)
curl -s -X POST http://127.0.0.1:8088/v1/groups/group_03_b100/release

# delete (rare — usually disable instead)
curl -s -X DELETE http://127.0.0.1:8088/v1/groups/group_99_test
```

## Accounts

```bash
# list enabled only
curl -s 'http://127.0.0.1:8088/v1/accounts?enabled=true' | jq

# single (includes apiKey — loopback only!)
curl -s http://127.0.0.1:8088/v1/accounts/1 | jq

# add account (workspace optional; defaults to "DEFAULT")
curl -s -X POST http://127.0.0.1:8088/v1/accounts \
  -H 'Content-Type: application/json' \
  -d '{"name":"alpha","apiKey":"sk_xxx","proxy":"http://user:pass@host:port","enabled":true,"workspace":"validator247"}'

# disable
curl -s -X PUT http://127.0.0.1:8088/v1/accounts/3 \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'

# move account to a different workspace
curl -s -X PUT http://127.0.0.1:8088/v1/accounts/3 \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"validator247"}'
```

## Deployments (audit log)

```bash
# most recent 200
curl -s http://127.0.0.1:8088/v1/deployments | jq

# filter
curl -s 'http://127.0.0.1:8088/v1/deployments?status=PUT_FAILED' | jq
curl -s 'http://127.0.0.1:8088/v1/deployments?account_id=2&limit=20' | jq

# single
curl -s http://127.0.0.1:8088/v1/deployments/123456 | jq
```

## Error envelope

All non-2xx responses share the same shape:

```json
{ "error": "human message", "code": "MACHINE_CODE" }
```

Common codes: `NOT_FOUND` (404), `VALIDATION` (400), `INVALID_JSON` (400),
`UNSUPPORTED_MEDIA_TYPE` (415), `PAYLOAD_TOO_LARGE` (413), `INTERNAL` (500).
