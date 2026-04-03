# Bifrost gateway — operations runbook

Companion to [`BIFROST-INTEGRATION.md`](BIFROST-INTEGRATION.md) and [ADR 006](../../control-plane/doc/adr/006-bifrost-model-gateway.md). Net-new installs: follow [`bifrost/GREENFIELD-CHECKLIST.md`](bifrost/GREENFIELD-CHECKLIST.md).

## Upgrades

1. Read upstream [Bifrost releases](https://github.com/maximhq/bifrost/releases) / changelog for breaking config or DB migration notes.
2. Bump **`image.tag`** (or digest) in your Helm values; keep **dev → staging → prod** order.
3. If `config_store` uses Postgres, take a **backup** before upgrade when release notes require migrations.
4. Roll the Deployment; watch **`/health`** and error rate from workers.
5. Roll back by reapplying the previous Helm revision: `helm rollback <release> <revision>`.

## Virtual key rotation

1. Mint a new Bifrost virtual key (`sk-bf-…`) with the same provider restrictions as the old key.
2. Distribute the new secret to workers (e.g. update Kubernetes Secret mounted as **`OPENAI_API_KEY`**, or patch worker Deployment env).
3. Verify traffic on the new key (staging first).
4. Revoke the old key in Bifrost governance UI/API.
5. **Hive `hive_gvk_*` keys** are unrelated; if you still use the Go router in parallel, rotate those via the board API separately.

## Provider key rotation

1. Add the new provider API key to Bifrost (second key with weight), validate traffic.
2. Remove or disable the old key; ensure no virtual key references only the removed key.

## Incident: bypass gateway (emergency)

**Risk:** Workers talk directly to vLLM/OpenAI; **no** central VK enforcement or Hive metering.

1. Get explicit approval (on-call / security).
2. Set worker env to the upstream base URL and a **short-lived** provider key from a sealed secret.
3. Restore **`HIVE_MODEL_GATEWAY_URL`** to Bifrost as soon as the gateway is healthy.
4. Post-incident: review logs for abuse during the bypass window.

## Observability

- **Bifrost:** Prometheus metrics (when telemetry plugin enabled per your values); request logs in Bifrost logs DB.
- **Workers:** `GET /metrics` on the drone HTTP port; alert on 4xx/5xx from LLM clients if exposed.
- **Control plane:** Existing run and cost dashboards; note metering gaps per [`BIFROST-METERING.md`](BIFROST-METERING.md).

## Network and admin access

- Restrict who can reach Bifrost **port 8080** (inference + UI) with `NetworkPolicy` — see [`bifrost/networkpolicy.yaml`](bifrost/networkpolicy.yaml).
- Do not expose the Bifrost UI on the public internet without authentication in front.
- When the **`hive_metering`** plugin is enabled, Bifrost pods must reach the control plane **`GET/POST /api/internal/hive/*`** (same host as the board API). Tighten the example egress stanza in [`bifrost/networkpolicy.yaml`](bifrost/networkpolicy.yaml) to that Service or IP range; keep **kube-dns** egress for resolving the board hostname.

## Control plane: Bifrost virtual keys

1. Set **`hive_deployments.model_gateway_backend`** to **`bifrost`** for the deployment row used by target companies (SQL or your ops process).
2. Set **`HIVE_BIFROST_ADMIN_BASE_URL`** (gateway root, e.g. `http://bifrost.hive-llm.svc.cluster.local:8080`) and **`HIVE_BIFROST_ADMIN_TOKEN`** on the board API process (governance API bearer).
3. **`POST /api/companies/:id/gateway-virtual-keys`** returns a one-time **`sk-bf-*`** token; store it in a namespace Secret and reference it from **`HiveWorkerPool.spec.modelGatewayCredentialSecret`**.

## Catalog sync (`bifrost-sync`)

- Build: from [`../bifrost-sync`](../bifrost-sync) run `go build -o bifrost-sync .`
- Required env: **`HIVE_BIFROST_SYNC_BOARD_BASE_URL`**, **`HIVE_BIFROST_SYNC_BOARD_TOKEN`** (board JWT with access to each company), **`HIVE_BIFROST_SYNC_COMPANY_IDS`** (comma-separated UUIDs), **`HIVE_BIFROST_SYNC_BIFROST_BASE_URL`**, **`HIVE_BIFROST_SYNC_BIFROST_TOKEN`**.
- Optional: **`HIVE_BIFROST_SYNC_DRY_RUN=true`**, **`HIVE_BIFROST_SYNC_ALLOWED_HOST_SUFFIXES`** (default `.svc.cluster.local,.svc`), **`HIVE_BIFROST_SYNC_PROVIDER_KEY_VALUE`** (dummy provider key string for keyless backends).
- Example manifest: [`bifrost-sync/k8s/cronjob.example.yaml`](../bifrost-sync/k8s/cronjob.example.yaml).

## Metering plugin (`hive_metering`)

- Source: [`../bifrost-hive-metering`](../bifrost-hive-metering). Build on **Linux** with the same Go version as Bifrost: `make -C ../bifrost-hive-metering plugin` or `CGO_ENABLED=1 go build -buildmode=plugin -o hive_metering.so ./plugin` from that directory.
- Plugin JSON config must include **`control_plane_base_url`** (board API origin) and **`operator_bearer`** (same secret as **`HIVE_INTERNAL_OPERATOR_SECRET`** on the server).
- Register the `.so` in Bifrost **`config.json`** plugins list per upstream docs.

### Metering source (record per environment)

Document which Hive metering approach each environment uses (see options in [`BIFROST-METERING.md`](BIFROST-METERING.md)). Update this table when the choice changes.

| Environment | Option | Notes |
|---------------|--------|--------|
| **Dev** | 3 (default) | Accept incomplete Hive rows for Bifrost-routed traffic until plugin or ETL is wired; fine for local experimentation. |
| **Staging** | 1 (target) | Build and load **`hive_metering.so`** from [`../bifrost-hive-metering`](../bifrost-hive-metering); validate VK hash → company mapping and POST metering. |
| **Prod** | 1 (target) | Same as staging; do not rely on Option 3 once spend or budgets depend on gateway traffic. |

- **Option 1** — Bifrost **`hive_metering`** plugin posts aggregates to the control plane (recommended when Hive Postgres is authoritative).
- **Option 2** — ETL from Bifrost logs/metrics into Hive on a schedule.
- **Option 3** — Accept incomplete Hive cost rows until Option 1 or 2 is adopted.

**Record:** owner / date of last review (e.g. in your change-management ticket or wiki link).

## OpenBao / Vault (optional)

- To avoid storing **`sk-bf-*`** only in Kubernetes: use **External Secrets Operator** (or similar) to sync from OpenBao path e.g. **`kv/hive/<deployment>/<company>/model-gateway`** into the tenant Secret referenced by **`modelGatewayCredentialSecret`**. The board can still mint keys via the API; automation writes the material to OpenBao out of band.

## References

- [Bifrost Docker setup](https://docs.getbifrost.ai/quickstart/gateway/setting-up#docker)
- [Bifrost governance / virtual keys](https://docs.getbifrost.ai/features/governance/virtual-keys)
- [Bifrost Kubernetes deployment](https://docs.getbifrost.ai/deployment-guides/k8s)
