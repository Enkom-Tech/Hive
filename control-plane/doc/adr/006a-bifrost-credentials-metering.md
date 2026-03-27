# ADR 006a: Bifrost credentials, sync, and Hive metering (addendum)

## Status

Accepted. Extends [006-bifrost-model-gateway.md](006-bifrost-model-gateway.md).

## Credential lifecycle

1. **Board** creates a gateway virtual key via `POST /api/companies/:id/gateway-virtual-keys`.
2. When the company’s **`hive_deployments.model_gateway_backend`** is `bifrost` and **`HIVE_BIFROST_ADMIN_BASE_URL`** (+ auth) is configured, the control plane calls **Bifrost** `POST /api/governance/virtual-keys` and persists the returned **`virtual_key.id`** and **SHA-256 of `virtual_key.value`** (same table as `hive_router` keys). The plaintext `sk-bf-*` is returned **once** in the API response, like `hive_gvk_*` today.
3. **Never** store gateway bearer material in `HiveWorkerPool` CRD strings. Workers receive **`OPENAI_API_KEY`** via **`secretKeyRef`** ([`HiveWorkerPoolSpec.modelGatewayCredentialSecret`](../../../infra/operator/api/v1alpha1/hiveworkerpool_types.go)); operators or a future controller materialize the Kubernetes Secret from the one-time token or from OpenBao/External Secrets.
4. **`hive_router`** keys remain **`hive_gvk_*`** and work only with `infra/model-gateway-go`.

## Threat model additions

| Risk | Mitigation |
|------|------------|
| Stolen Bifrost admin credentials | Short-lived tokens; network-restrict CP → Bifrost; separate admin auth env vars |
| Sync job overwrites wrong Bifrost config | Company-scoped sync; base_url allowlist; dry-run logs |
| Metering bearer leaked | Dedicated `HIVE_INTERNAL_OPERATOR_SECRET`; egress NetworkPolicy to CP only |
| SSRF via `inference_models.base_url` | Sync allowlist (suffixes / host regex) before pushing to Bifrost |

## Metering

- Bifrost does not POST to Hive. A **Hive metering plugin** (see `infra/bifrost-hive-metering/`) runs inside a **Bifrost build** and calls `POST /api/internal/hive/inference-metering` with the same body shape as [`model-gateway-go`](../../../infra/model-gateway-go/main.go).
- Optional: extend the internal route to resolve **`virtualKeySha256`** when `companyId` is omitted (implemented in `internal-hive.ts`).

## References

- Bifrost governance API: `POST /api/governance/virtual-keys` (upstream handler registers this route).
- [`infra/model-gateway/BIFROST-METERING.md`](../../../infra/model-gateway/BIFROST-METERING.md)
