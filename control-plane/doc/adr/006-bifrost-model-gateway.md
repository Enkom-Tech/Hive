# ADR 006: Bifrost as optional model gateway (Hive)

## Status

Accepted (architecture and security constraints). Implementation is incremental: operators may adopt Bifrost per environment; the minimal router in `infra/model-gateway-go` remains the reference implementation.

## Context

Hive workers use a single OpenAI-compatible base URL (`HIVE_MODEL_GATEWAY_URL`) and route by `model` in the request body ([`MODEL-GATEWAY.md`](../MODEL-GATEWAY.md)). The control plane stores chat routes in `inference_models` and mints gateway virtual keys (`hive_gvk_*`, hashed at rest) for the Go router ([`companies.ts`](../../server/src/routes/companies.ts)).

[Bifrost](https://github.com/maximhq/bifrost) is a high-performance gateway with governance (virtual keys, budgets, rate limits), streaming, and Helm charts. Its governance layer recognizes virtual keys prefixed with `sk-bf-` in `Authorization: Bearer …`, `x-bf-vk`, or related headers. When `allowDirectKeys` is true, bearer tokens **not** starting with `sk-bf-` may be treated as **direct provider API keys** and forwarded upstream — dangerous if workers send `hive_gvk_*` tokens.

## Decision

1. **Production multi-tenant path (Option A):** Prefer **Bifrost-native virtual keys** (`sk-bf-…`) for inference when using Bifrost. Operators configure **`allowDirectKeys: false`** and **`is_vk_mandatory: true`**. Workers (or adapter containers) receive the Bifrost virtual key as **`OPENAI_API_KEY`** (OpenAI SDK convention) and **`HIVE_MODEL_GATEWAY_URL`** / **`OPENAI_BASE_URL`** pointing at Bifrost’s `/v1`.
2. **Control plane `hive_gvk_*` keys** remain the contract for **`infra/model-gateway-go`** and the board export [`inference-router-config`](../../server/src/routes/companies.ts). They are **not** interchangeable with Bifrost VKs without an adapter or sync that mints `sk-bf-` secrets in Bifrost and distributes them to workers.
3. **Option B** (future): A thin adapter or Bifrost plugin validates `hive_gvk_*` and maps to tenant context — only if product requires a single token format across gateways.
4. **Option C** (lab only): Single-tenant clusters may use relaxed settings only behind strict network controls and with explicit risk acceptance documented in the environment runbook.

## Threat model (gateway path, STRIDE)

| Category | Risk | Mitigation |
|----------|------|------------|
| Spoofing | Client presents another tenant’s key | Mandatory VK; short-lived rotation; never `allowDirectKeys` with untrusted clients |
| Tampering | Malicious `base_url` in config (SSRF) | Allowlist internal Service DNS / known hosts; restrict who can change Bifrost config |
| Repudiation | No audit of who called which model | Bifrost logs store + governance; align retention with policy |
| Information disclosure | Keys or prompts in logs | Log redaction policy; avoid debug in production |
| Denial of service | Gateway or upstream overload | Rate limits (Bifrost governance); worker backoff |
| Elevation | Admin UI exposed publicly | NetworkPolicy, Ingress auth, no public exposure of Bifrost UI |

## Consequences

- Operators choosing Bifrost **must** read [`infra/model-gateway/BIFROST-INTEGRATION.md`](../../../infra/model-gateway/BIFROST-INTEGRATION.md) and [`BIFROST-RUNBOOK.md`](../../../infra/model-gateway/BIFROST-RUNBOOK.md).
- Hive metering via `POST /api/internal/hive/inference-metering` is **not** implemented by Bifrost; see [`BIFROST-METERING.md`](../../../infra/model-gateway/BIFROST-METERING.md).
- Documentation and worker container behavior **pass through** `HIVE_MODEL_GATEWAY_URL` and OpenAI-compatible env vars into adapter containers so containerized agents see the same contract as process-based executors.

## References

- [006b — Greenfield default: Bifrost edge](006b-greenfield-default-gateway.md)
- [006a — Credentials, sync, metering](006a-bifrost-credentials-metering.md)
- [`MODEL-GATEWAY.md`](../MODEL-GATEWAY.md)
- [`K3S-LLM-DEPLOYMENT.md`](../K3S-LLM-DEPLOYMENT.md)
- [`DRONE-SPEC.md`](../DRONE-SPEC.md)
- Bifrost docs: [Setting up (Docker)](https://docs.getbifrost.ai/quickstart/gateway/setting-up#docker), [Governance / virtual keys](https://docs.getbifrost.ai/features/governance/virtual-keys)
