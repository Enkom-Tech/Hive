# Canary rollout and rollback — `HIVE_MODEL_GATEWAY_URL` → Bifrost

Use this when switching workers from `hive-model-gateway-go` (or direct URLs) to Bifrost.

**Greenfield (no existing gateway):** use [GREENFIELD-CHECKLIST.md](GREENFIELD-CHECKLIST.md) instead — same security targets, ordered for first deploy.

## Preconditions

- [ ] Bifrost Deployed; `GET /health` returns OK from inside the cluster.
- [ ] Provider keys and **`models[]`** match worker `model` strings (e.g. `vllm:llama-3.1-8b`).
- [ ] Bifrost virtual keys (`sk-bf-*`) minted; **`allowDirectKeys: false`**, **`is_vk_mandatory: true`**.
- [ ] Worker pods have **`OPENAI_API_KEY`** (or equivalent) set to the Bifrost VK; **`OPENAI_BASE_URL`** or **`HIVE_MODEL_GATEWAY_URL`** points at `http://bifrost.../v1`.
- [ ] Prefer **`HiveWorkerPool.spec.modelGatewayCredentialSecret`** (SecretKeyRef) for **`OPENAI_API_KEY`** — no raw tokens in the CRD.
- [ ] If using Hive board minted keys: `hive_deployments.model_gateway_backend = bifrost`, **`HIVE_BIFROST_ADMIN_*`** set on the control plane, and tenant Secret populated from the one-time **`sk-bf-*`** return (or ExternalSecrets from OpenBao/Vault).
- [ ] Catalog sync: **`infra/bifrost-sync`** CronJob (or equivalent) with **`HIVE_BIFROST_SYNC_*`** env; dry-run once, then live; confirm Bifrost provider keys for `hive-sync-*` names.
- [ ] Metering: Bifrost **`hive_metering`** plugin (see **`infra/bifrost-hive-metering`**) or alternate path documented in [`../BIFROST-METERING.md`](../BIFROST-METERING.md); **`HIVE_INTERNAL_OPERATOR_SECRET`** matches plugin **`operator_bearer`**.
- [ ] [`networkpolicy.yaml`](networkpolicy.yaml) applied (or equivalent firewall rules), including egress to the control plane URL used for metering.

## Canary

1. Select **one** worker pool or Deployment (low-traffic tenant).
2. Patch `HiveWorkerPool` **`modelGatewayURL`** (or env) to the Bifrost Service URL ending in **`/v1`**.
3. Run a **single** chat completion from that pool; verify Bifrost logs / upstream vLLM receive traffic.
4. Monitor error rate and latency for 15–60 minutes.
5. Expand to remaining pools in waves.

## Rollback

1. Revert **`modelGatewayURL`** to the previous value (e.g. `http://model-gateway:8080/v1`).
2. Roll worker Deployment if env is baked into Pod spec: `kubectl rollout undo deployment/...`.
3. If Bifrost misconfiguration caused partial outages, keep **`hive-model-gateway-go`** Deployment scaled to ≥1 for instant fallback.

## Verification commands (examples)

```bash
kubectl -n hive-llm get pods,svc -l app.kubernetes.io/name=bifrost
kubectl -n hive-workers exec deploy/hive-worker -- wget -qO- http://bifrost.hive-llm.svc.cluster.local:8080/health
```

## Post-rollout

- Record chosen metering option in [`../BIFROST-METERING.md`](../BIFROST-METERING.md).
- Update internal diagram: worker → Bifrost → vLLM.
