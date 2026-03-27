# Syncing inference router config from the control plane

The Postgres catalog (`inference_models`, `gateway_virtual_keys`) is the source of truth. Board API:

1. `GET /api/companies/{companyId}/inference-router-config` — returns JSON suitable for the Go router:
   - `models` — object with a `models` array (`id`, `base_url`).
   - `virtualKeys` — object with `keys` (`sha256`, `company_id`).

Render two files (or one ConfigMap with two keys):

- `models.json` — set `models` field from the response (or merge with operator-only `api_key_env` entries).
- `virtual_keys.json` — use the `virtualKeys` object as-is; mount at `VIRTUAL_KEYS_PATH` or inject via `VIRTUAL_KEYS_JSON`.

Re-apply the ConfigMap and roll the model-gateway Deployment when the catalog changes. A future CronJob in-cluster can poll the API with a board service account token; this repo documents the contract only.

## After a model training promotion

When the board **promotes** a `model_training_run`, the control plane upserts `inference_models` for that company. Re-run the same export (`GET /api/companies/{companyId}/inference-router-config`) and sync the gateway so the new `model_slug` → `base_url` mapping is live. See [`control-plane/doc/adr/008-model-training-runs.md`](../../control-plane/doc/adr/008-model-training-runs.md).
