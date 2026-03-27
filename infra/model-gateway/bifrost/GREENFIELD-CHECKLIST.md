# Greenfield checklist — Hive LLM edge (Bifrost)

Use this for **first production** (or first shared staging) when no legacy `hive-model-gateway-go` edge exists. Companion to [ADR 006b](../../control-plane/doc/adr/006b-greenfield-default-gateway.md), [BIFROST-INTEGRATION.md](../BIFROST-INTEGRATION.md), and [ROLLOUT-CHECKLIST.md](ROLLOUT-CHECKLIST.md).

## 0. Foundations (order matters)

1. [ ] **Postgres** (managed recommended); run all DB migrations through the latest tag (includes `model_gateway_backend` / `key_kind`).
2. [ ] **Secrets generated** (store in Kubernetes Secrets or External Secrets → OpenBao/Vault):
   - `BETTER_AUTH_SECRET` / `HIVE_AGENT_JWT_SECRET` (authenticated board)
   - `HIVE_INTERNAL_OPERATOR_SECRET` — metering + `gateway-virtual-key-lookup` ([`internal-hive.ts`](../../../control-plane/server/src/routes/internal-hive.ts))
   - `HIVE_BIFROST_ADMIN_TOKEN` (+ board env `HIVE_BIFROST_ADMIN_BASE_URL`) — governance API from control plane only
   - Long-lived **board JWT** for `bifrost-sync` (minimal company scope)
   - **Bifrost governance** bearer for sync `PUT /api/providers/openai`
3. [ ] **TLS** on ingress to the board API; Bifrost admin/UI **not** on the public internet without auth.
4. [ ] **Default deployment backend:** after migrations, confirm `hive_deployments.model_gateway_backend` is **`bifrost`** for the default row (`a0000000-0000-4000-8000-000000000001`). If you use **only** the Go router, set **`hive_router`** explicitly ([006b](../../control-plane/doc/adr/006b-greenfield-default-gateway.md)).

## 1. Control plane

5. [ ] Deploy board API in **authenticated** mode; smoke-test login.
6. [ ] Set `HIVE_BIFROST_ADMIN_BASE_URL` and `HIVE_BIFROST_ADMIN_TOKEN` on the API deployment.
7. [ ] Define **`inference_models`** (chat) for at least one model slug workers will send.

## 2. Cluster LLM + Bifrost

8. [ ] Deploy **vLLM/SGLang** (or upstream) as internal Services.
9. [ ] Deploy **Bifrost** with **`allowDirectKeys: false`**, **`is_vk_mandatory: true`** ([values example](values-hive.example.yaml)).
10. [ ] Apply [`networkpolicy.yaml`](networkpolicy.yaml); add **board egress** via [networkpolicy-board-egress.example.yaml](networkpolicy-board-egress.example.yaml) or equivalent so the metering plugin can reach `https://<board>/api/internal/hive/*`.

## 3. Catalog sync

11. [ ] Deploy **`bifrost-sync`** CronJob ([example](../../bifrost-sync/k8s/cronjob.example.yaml)); set `HIVE_BIFROST_SYNC_ALLOWED_HOST_SUFFIXES` to your cluster DNS suffixes only.
12. [ ] Run with **`HIVE_BIFROST_SYNC_DRY_RUN=true`** once; inspect logs.
13. [ ] Run live; confirm Bifrost shows **`hive-sync-*`** provider keys and models match board slugs.

## 4. Workers + keys

14. [ ] **`HiveWorkerPool`**: `modelGatewayURL` → `http://bifrost.<ns>.svc.cluster.local:8080/v1` (adjust port/path to your chart).
15. [ ] **`modelGatewayCredentialSecret`** → Secret key holding **`sk-bf-*`** (minted once from board); never put the token in the CRD.
16. [ ] Mint **`POST /api/companies/:id/gateway-virtual-keys`**; write material to Secret (or ESO from OpenBao — [external-secrets.example.yaml](external-secrets.example.yaml)).

## 5. Metering

17. [ ] Build **Linux** plugin [`infra/bifrost-hive-metering`](../../bifrost-hive-metering); register in Bifrost config with `control_plane_base_url` and `operator_bearer` = `HIVE_INTERNAL_OPERATOR_SECRET`.
18. [ ] Run one chat completion; verify **`cost_events`** (or your cost API) shows a row with `source: gateway_aggregate` and expected `companyId`.

## 6. Optional: indexes / embeddings

19. [ ] **CocoIndex / DocIndex** use `COCOINDEX_EMBEDDING_URL` / `DOCINDEX_EMBEDDING_URL` — decide explicitly if embeddings go through Bifrost `/v1/embeddings` or a dedicated embedding service (not automatic from `HIVE_MODEL_GATEWAY_URL`).

## Verification SQL (examples)

```sql
-- Deployment backend
SELECT id, label, model_gateway_backend FROM hive_deployments;

-- Recent gateway aggregate costs (adjust time window)
SELECT id, company_id, source, provider, model, input_tokens, output_tokens, created_at
FROM cost_events
WHERE source = 'gateway_aggregate'
ORDER BY created_at DESC
LIMIT 20;
```

## References

- [BIFROST-RUNBOOK.md](../BIFROST-RUNBOOK.md)
- [BIFROST-METERING.md](../BIFROST-METERING.md)
- [bifrost-sync README](../../bifrost-sync/README.md) (pinned Bifrost API compatibility)
