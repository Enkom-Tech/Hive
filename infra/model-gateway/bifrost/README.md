# Hive-oriented Bifrost Kubernetes assets

These files complement the upstream Helm chart ([`maximhq/bifrost`](https://github.com/maximhq/bifrost), path `helm-charts/bifrost` when you clone or vendor the repo).

## Install

```bash
# From repo root, when bifrost/ is present:
helm upgrade --install bifrost ./bifrost/helm-charts/bifrost \
  --namespace hive-llm --create-namespace \
  -f infra/model-gateway/bifrost/values-hive.example.yaml
```

If `bifrost/` is not vendored, clone the upstream repository and point `helm install` at its `helm-charts/bifrost` directory, merging `-f values-hive.example.yaml`.

## Files

| File | Purpose |
|------|---------|
| `values-hive.example.yaml` | Hardening defaults: `allowDirectKeys: false`, mandatory virtual keys, placeholder providers — **replace** dummy keys and image tag before production. |
| `networkpolicy.yaml` | Example **NetworkPolicy** — restrict ingress to worker pods and egress to DNS + LLM backends (edit namespaces and labels). |
| `ROLLOUT-CHECKLIST.md` | Canary / rollback steps for `HIVE_MODEL_GATEWAY_URL`. |

Secrets (provider API keys, `sk-bf-*` material for CI/CD) must come from **Kubernetes Secrets** or external vaults — never commit real values.
