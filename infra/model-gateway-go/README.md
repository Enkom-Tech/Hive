# Model gateway (Go)

OpenAI-compatible HTTP router using **Go stdlib only** (no FastAPI/httpx). Same contract as [control-plane/doc/MODEL-GATEWAY.md](../../control-plane/doc/MODEL-GATEWAY.md): `/health`, `/v1/models`, `/v1/*` proxied by `model` in the JSON body.

## Build

```bash
cd infra/model-gateway-go
go build -o model-gateway .
```

## Docker

```bash
docker build -t model-gateway:latest .
```

Point Kubernetes `HiveWorkerPool` / worker env at this image instead of `infra/model-gateway` when you want a smaller runtime dependency graph.

## Configuration

- `CONFIG_PATH` — JSON file (default `/etc/model-gateway/models.json`), same shape as `infra/model-gateway` (`models` array with `id`, `base_url`, optional `api_key_env`).
- `MODELS_JSON` — inline JSON (overrides file when set).
- `LISTEN_ADDR` — default `:8080`.
- **Virtual keys:** `VIRTUAL_KEYS_PATH` or `VIRTUAL_KEYS_JSON` — JSON `{"keys":[{"sha256":"<hex>","company_id":"<uuid>"}]}`. If the client `Authorization: Bearer` token’s SHA-256 (UTF-8) matches an entry, the gateway strips that header and uses the model’s `api_key_env` for the upstream call only.
- **Usage reporting:** `METERING_URL` — full URL to `POST .../api/internal/hive/inference-metering` on the control plane; `METERING_BEARER` — `Authorization` secret (same as `HIVE_INTERNAL_OPERATOR_SECRET` / `INTERNAL_OPERATOR_SECRET` on the server). When a virtual key matches and the upstream returns JSON with `usage`, the gateway posts `source: gateway_aggregate` asynchronously.
