# Integrating Bifrost as the Hive model gateway

[Bifrost](https://github.com/maximhq/bifrost) (vendored as `bifrost/` when present, or clone from GitHub) is an OpenAI-compatible gateway with governance (virtual keys, budgets, rate limits), streaming, and Helm support. Workers still use **`HIVE_MODEL_GATEWAY_URL`** pointing at Bifrost’s `/v1` base ([`control-plane/doc/MODEL-GATEWAY.md`](../../control-plane/doc/MODEL-GATEWAY.md)).

Architecture decision and threat model: [`control-plane/doc/adr/006-bifrost-model-gateway.md`](../../control-plane/doc/adr/006-bifrost-model-gateway.md).

## Source of truth and reconciliation

Hive and Bifrost each persist **different shapes** of the same business concepts:

| Artifact | Hive (Postgres / board) | Bifrost (config store / Helm) |
|----------|-------------------------|-------------------------------|
| Chat routes | `inference_models` (`model_slug`, `base_url`) | Provider `keys[].models` + `network_config.base_url` |
| Tenant gateway secrets | `gateway_virtual_keys` (`hive_gvk_*` → hash) | Governance `virtualKeys` (`sk-bf-*` values) |
| Usage / cost | Internal metering API (Go router) | Governance budgets + logs DB |

**Recommended default (hybrid):**

1. **Product / audit SoT:** Keep using the board for **`inference_models`** and **`gateway_virtual_keys`** so the operator UI and API remain consistent with deployment-scoped policy ([`MODEL-GATEWAY.md`](../../control-plane/doc/MODEL-GATEWAY.md)).
2. **Runtime SoT for Bifrost:** Treat Bifrost’s config store (or Git-managed `config.json` + Helm bootstrap) as **authoritative for what the gateway actually routes**. Reconcile on a schedule or after every catalog change.

**Reconciliation patterns (pick one per environment):**

- **Manual / GitOps:** Operator runs `GET /api/companies/{companyId}/inference-router-config`, translates rows into Bifrost provider entries (see §3), applies Helm or Bifrost HTTP API, then rolls the gateway Deployment. Document the translator steps in your internal wiki; this repo does not ship an automated exporter yet.
- **Scheduled job (future):** CronJob or controller polls the board API with a service account, diffs desired routes, calls Bifrost admin APIs. Requires secure network path and board credentials with minimal scope.
- **Bifrost-only lab:** For sandboxes, configure Bifrost solely via UI and treat Hive catalog as documentation-only until you automate sync.

**Rollback:** If a bad sync breaks routing, revert the previous Bifrost ConfigMap / Helm revision or restore `config.db` snapshot; workers can temporarily point `HIVE_MODEL_GATEWAY_URL` back to `hive-model-gateway-go` if that Deployment is kept available.

## 1. Worker contract (unchanged)

- Set **`HIVE_MODEL_GATEWAY_URL`** to the in-cluster Service, e.g. `http://bifrost.<namespace>.svc.cluster.local:8080/v1` (port matches your Helm `service.port`; default **8080**).
- Requests must include a **`model`** field matching a model Bifrost accepts for the configured provider keys (same logical ids you use today, e.g. `vllm:llama-3.1-8b`).

## 2. Deploy Bifrost

Use the chart under `bifrost/helm-charts/bifrost/` (see `bifrost/helm-charts/bifrost/README.md` and `values-examples/`).

- Start from **`values-examples/providers-and-virtual-keys.yaml`** for providers + governance.
- Pick **storage**: SQLite + PVC is simplest; use external Postgres for HA / shared config if you need multiple replicas and a single source of truth for keys and budgets.
- Pin **`image.tag`** to a released version (see chart defaults and Docker Hub tags).

## 3. Map Hive “models” to Bifrost providers

Hive’s catalog is **`id` + backend `base_url`** per model. In Bifrost, each OpenAI-compatible backend is usually an **`openai` provider** with **`network_config.base_url`** set to that backend’s root (include `/v1` if that is how your backend expects it—match what you used in `models.json`).

For each backend (vLLM, SGLang, LM Studio proxy, cloud):

1. Under **`bifrost.providers.openai`** (or a separate logical provider block if you split them—Bifrost allows multiple keys per provider), set **`network_config.base_url`** to the backend URL.
2. Add at least one **`keys`** entry with a **`value`** (real API key, dummy string for keyless local vLLM—whatever the backend requires).
3. On each key, set **`models`** to the **exact** `model` strings workers send (e.g. `vllm:llama-3.1-8b`). This replaces the Go router’s `id` → `base_url` table.

If you use **multiple physical clusters** of the same logical model, use multiple keys with **`weight`** for load balancing.

Reference schema: `bifrost/transports/config.schema.json` (`network_config`, `provider`, `providerKey`).

## 4. Virtual keys vs `infra/model-gateway-go`

The Go router accepts **any** bearer token and maps **`sha256(token)` → `company_id`** via `virtual_keys.json` ([`SYNC-INFERENCE-CONFIG.md`](SYNC-INFERENCE-CONFIG.md)).

Bifrost governance uses **its own** virtual keys. Parsed from headers only when:

- **`x-bf-vk: sk-bf-...`**, or  
- **`Authorization: Bearer sk-bf-...`** (or `x-api-key` / `x-goog-api-key` with the same prefix),

see `bifrost/plugins/governance` (`VirtualKeyPrefix = "sk-bf-"`) and `bifrost/transports/bifrost-http/lib/ctx.go`.

**Proper integration options:**

| Approach | Notes |
|----------|--------|
| **A. Bifrost-native keys (recommended for greenfield)** | Mint **Bifrost** virtual keys per company (UI, governance API, or Helm `governance.virtualKeys`). Distribute the **`sk-bf-...`** secret to workers the same way you distribute gateway keys today. Enable **`is_vk_mandatory: true`** and set **`allowDirectKeys: false`** in client config so raw provider keys never arrive from clients. |
| **B. Keep Hive catalog as SoT** | Add a **sync job** (or one-off export) that translates `inference-router-config` into Bifrost config / ConfigStore updates. You still must **issue `sk-bf-` virtual keys** in Bifrost unless you fork governance to understand Hive’s hashed tokens. |
| **`allowDirectKeys: true` (not recommended for multi-tenant edge)** | Clients may send a **provider API key** in `Authorization`; Bifrost will treat non-`sk-bf-` bearer tokens as direct keys. Fine only behind a trusted network with a single tenant. |

### OpenBao / Vault and External Secrets (optional)

**Worker `OPENAI_API_KEY` (Bifrost VK):** After the board returns a one-time **`sk-bf-*`**, persist it in OpenBao/Vault KV (e.g. `kv/hive/{deployment}/{company}/model-gateway` with key `OPENAI_API_KEY` or `token`). Use **External Secrets Operator** to sync into the **tenant** namespace as a normal `Secret`; reference that Secret from **`HiveWorkerPool.spec.modelGatewayCredentialSecret`**. Never commit the token to Git or paste it into the CRD.

**Control plane secrets:** Store **`HIVE_BIFROST_ADMIN_TOKEN`**, **`HIVE_INTERNAL_OPERATOR_SECRET`**, and auth secrets the same way (ESO → cluster Secret → env on the board Deployment). The CP process only needs the Bifrost governance token at runtime; it does not belong in the UI or logs.

**Example manifests:** [`bifrost/external-secrets.example.yaml`](bifrost/external-secrets.example.yaml) (adjust `SecretStore`, paths, and namespaces).

**Network path:** Bifrost pods calling **`/api/internal/hive/*`** must be allowed to reach the board Service (see [`bifrost/networkpolicy-board-egress.example.yaml`](bifrost/networkpolicy-board-egress.example.yaml)).

## 5. Metering

See dedicated spec: [`BIFROST-METERING.md`](BIFROST-METERING.md) (options: plugin, ETL from logs, or accept Bifrost-only until integrated).

## 6. Security checklist

- **`allowDirectKeys: false`** and **`plugins.governance.config.is_vk_mandatory: true`** for production multi-tenant setups.
- Do not expose Bifrost’s UI/admin API on the public internet without auth and network policy.
- Restrict **`network_config.base_url`** targets to cluster-internal Services or known endpoints (SSRF risk if config is ever attacker-controlled).
- Use **TLS** where traffic leaves the mesh; use **`ca_cert_pem`** or proper cluster CA for private backends.

## 7. Health and rollout

- Probes: chart defaults use **`GET /health`** on the HTTP port—align with your Service name and port.
- Roll workers **after** Bifrost is up and models/virtual keys are configured; only **`HIVE_MODEL_GATEWAY_URL`** (and optionally client headers if you adopt `x-bf-vk`) need to change.

## 8. Docker (local dev)

Official quickstart: [Bifrost — Setting up (Docker)](https://docs.getbifrost.ai/quickstart/gateway/setting-up#docker). Pin an image tag, mount a volume on `/app/data`, set `APP_HOST=0.0.0.0` when workers reach the container from another host. Point `HIVE_MODEL_GATEWAY_URL` at `http://<host>:<port>/v1`.

## 9. Further reading

- Bifrost agent-oriented layout (when vendored): `bifrost/AGENTS.md`  
- k3s LLM ordering: [`control-plane/doc/K3S-LLM-DEPLOYMENT.md`](../../control-plane/doc/K3S-LLM-DEPLOYMENT.md)  
- Operations: [`BIFROST-RUNBOOK.md`](BIFROST-RUNBOOK.md)  
- Rollout checklist: [`bifrost/ROLLOUT-CHECKLIST.md`](bifrost/ROLLOUT-CHECKLIST.md)  
- Greenfield ordering: [`bifrost/GREENFIELD-CHECKLIST.md`](bifrost/GREENFIELD-CHECKLIST.md)
