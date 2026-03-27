# Model gateway spec

Thin OpenAI-compatible router so Hive and drones use a single URL for LLM inference. Backends can be vLLM, SGLang, LM Studio (e.g. via proxy), or cloud APIs.

## New production installs (greenfield)

**Default path:** [Bifrost](https://github.com/maximhq/bifrost) as the LLM edge — governance virtual keys (`sk-bf-*`), catalog sync, and metering per [ADR 006](adr/006-bifrost-model-gateway.md), [006b](adr/006b-greenfield-default-gateway.md), and [`BIFROST-INTEGRATION.md`](../../infra/model-gateway/BIFROST-INTEGRATION.md). Follow [`GREENFIELD-CHECKLIST.md`](../../infra/model-gateway/bifrost/GREENFIELD-CHECKLIST.md).

**Lab / minimal / exception:** `infra/model-gateway-go` remains the **small, auditable reference** for the same OpenAI-compatible contract with **`hive_gvk_*`** tokens. Use it for local dev or when architecture approves an [006b exception](adr/006b-greenfield-default-gateway.md) (documented per environment). Do not run Go router and Bifrost as **dual production edges** for the same tenants without a deliberate migration plan.

## Relationship to Hive policy, MCP, and third-party gateways

- **Deployment vs in-app company:** `hive_deployments` groups **companies** that share the same control-plane install and operator-scoped resources (e.g. model catalog, gateway virtual keys via `deployment_id`). The column **`model_gateway_backend`** selects **`bifrost`** vs **`hive_router`** minting on the board. In-app **companies** remain org units for issues, agents, and cost rows keyed by `company_id`. See [MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md) (*Deployment vs company*).
- **Product vs data plane:** The control plane should ultimately own *which* models are allowed, company/agent budgets, and audit trails. Per-run model selection is part of the worker contract: the WebSocket **run** payload may include `model` / `modelId` (see [DRONE-SPEC.md](DRONE-SPEC.md)). The service defined in this document is the **reference data plane**: a static registry (e.g. ConfigMap) mapping logical model ids to `base_url` values. The board can manage `inference_models` and export router JSON via `GET /api/companies/{companyId}/inference-router-config`; see `infra/model-gateway/SYNC-INFERENCE-CONFIG.md`.
- **Go reference router:** `infra/model-gateway-go` implements this spec with optional **virtual keys** (hashed bearer → `company_id`) and optional async **usage reporting** to `POST /api/internal/hive/inference-metering` (`HIVE_INTERNAL_OPERATOR_SECRET` / `INTERNAL_OPERATOR_SECRET`). Prefer it **over the legacy Python router** on the edge when you are **not** using Bifrost.

- **Third-party AI gateways:** Operators may use Envoy AI Gateway, Bifrost, Plano, or any other component that exposes an OpenAI-compatible `/v1/...` entrypoint and routes by `model` in the request body, while workers keep `HIVE_MODEL_GATEWAY_URL` unchanged. For Bifrost (vendored at repo root as `bifrost/` when present), see `infra/model-gateway/BIFROST-INTEGRATION.md` and [ADR 006](adr/006-bifrost-model-gateway.md) for providers, virtual keys (`sk-bf-...`), tenant-key strategy, and metering via `infra/bifrost-hive-metering`.

- **Not MCP:** This gateway forwards **LLM** HTTP only (`/v1/chat/completions`, `/v1/completions`). It does not implement MCP. For RAG MCP vs future drone MCP for control-plane APIs, see [MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md) (subsection *LLM routing and MCP surfaces*).

## Contract

- **Endpoints:** HTTP service exposing OpenAI-compatible `/v1/chat/completions` and `/v1/completions`. Forward request body and relevant headers to the backend selected by model id.
- **Config:** Registry of models (e.g. `models.yaml` or ConfigMap). Each entry: `id` (model name used by clients), `base_url` (backend base URL, e.g. `http://vllm-llama:8000/v1`), optional `api_key_env` (env var name for API key for that backend).
- **Routing:** On each request, read `model` from the request; look up the backend for that id; proxy to `base_url` with the same path and body. Return the backend response.

## Single env for Hive

Workers (and thus agents) get one base URL, e.g. `HIVE_MODEL_GATEWAY_URL=http://model-gateway:8080/v1`. All model requests from the drone/executor use this URL; the gateway routes by model id.

## Example config (models.yaml)

```yaml
models:
  - id: lmstudio:qwen2.5-7b
    base_url: http://lmstudio-proxy:1234/v1
  - id: vllm:llama-3.1-8b
    base_url: http://vllm-llama:8000/v1
  - id: sglang:llama-3.1-8b-structured
    base_url: http://sglang-structured:3000/v1
  - id: openai:gpt-4.1-mini
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
```

## Deployment

- **Greenfield / production:** Bifrost Helm chart + [`BIFROST-INTEGRATION.md`](../../infra/model-gateway/BIFROST-INTEGRATION.md) + [GREENFIELD-CHECKLIST.md](../../infra/model-gateway/bifrost/GREENFIELD-CHECKLIST.md).
- **Lab / Go-only:** [K3S-LLM-DEPLOYMENT.md](K3S-LLM-DEPLOYMENT.md), `infra/model-gateway/` (k8s manifests default image **hive-model-gateway-go**), and `infra/model-gateway-go/`.
