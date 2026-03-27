# Cluster / GitOps

Layout of `infra/cluster/` and how ArgoCD syncs Hive infra from the repo.

## Bootstrap (app-of-apps)

- **Path:** `infra/cluster/bootstrap/argocd-app-of-apps.yaml`
- **Role:** Single ArgoCD Application that points at `infra/cluster/applications`. Install this Application once (e.g. `kubectl apply -f infra/cluster/bootstrap/argocd-app-of-apps.yaml` from repo root against a cluster that already has ArgoCD). ArgoCD then syncs the `applications/` directory; each YAML there becomes a child Application.

The bootstrap Application uses:
- **repoURL:** `https://github.com/Enkom-Tech/Hive`
- **path:** `infra/cluster/applications`
- **targetRevision:** HEAD

## Applications

Everything under `cluster/applications/` is an ArgoCD Application manifest. The app-of-apps syncs this directory, so each file defines one Application.

| File | Application name | Source | Destination |
|------|------------------|--------|-------------|
| operator.yaml | hive-operator | Repo `infra/manifests/operator` | namespace hive-system |
| storage.yaml | hive-storage | Repo `infra/manifests/storage` (Kustomize: RustFS + Dragonfly + `juicefs-sc` by default) | namespace hive-storage |
| observability.yaml | hive-observability | Helm chart kube-prometheus-stack (prometheus-community) | namespace monitoring |
| metrics-server.yaml | metrics-server | Helm chart metrics-server (Bitnami) | namespace kube-system |

So after bootstrap, ArgoCD manages: operator deployment, storage (RustFS + DragonflyDB for JuiceFS by default; optional overlays under `infra/manifests/storage/overlays/`), observability stack, and metrics-server from this repo (and the two Helm charts at the versions pinned in those files). JuiceFS CSI itself is installed via Helm (see `infra/manifests/storage/juicefs-csi.yaml`), not by the storage Kustomize bundle.

To use **MinIO** instead of RustFS, point the `hive-storage` Application `spec.source.path` at `infra/manifests/storage/overlays/object-minio` (only one storage bundle per cluster). For **managed HA backends** (replicated Redis + S3), use `overlays/fully-external` after editing `juicefs-storageclass.yaml` placeholders. Other overlays: `meta-external`, `object-external-s3` — see [Scripts reference — JuiceFS storage stack](scripts.md#juicefs-storage-stack-defaults-and-overlays).

## Tenants

- **Path:** `infra/cluster/tenants/example/`
- **Role:** Example HiveCompany and HiveWorkerPool CRs. These are plain Kubernetes manifests, not ArgoCD Applications. Use them as templates; apply manually (e.g. `kubectl apply -f infra/cluster/tenants/example/` from repo root) or via scripts (e.g. `infra/scripts/create-tenant.sh`). Tenant CRs live in `hive-system` and are reconciled by the Hive operator.

Optional LLM stack (vLLM, model gateway, worker model URL) and deploy order are described in [control-plane/doc/K3S-LLM-DEPLOYMENT.md](../control-plane/doc/K3S-LLM-DEPLOYMENT.md).

**HiveIndexer / HiveDocIndexer:** status **conditions** include **`IndexerDegraded`** (True when required Deployments have no ready replicas, including the MCP gateway when `gatewayImage` is set). Correlate with [control-plane security runbook — Alerts: worker MCP and indexers](../control-plane/docs/deploy/security-runbook.md) and `HiveWorkerPool` **MCPCodeGateway** / **MCPDocsGateway** conditions.
