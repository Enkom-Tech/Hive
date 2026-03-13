# Cluster / GitOps

Layout of `infra/cluster/` and how ArgoCD syncs Hive infra from the repo.

## Bootstrap (app-of-apps)

- **Path:** `infra/cluster/bootstrap/argocd-app-of-apps.yaml`
- **Role:** Single ArgoCD Application that points at `infra/cluster/applications`. Install this Application once (e.g. `kubectl apply -f infra/cluster/bootstrap/argocd-app-of-apps.yaml` from repo root against a cluster that already has ArgoCD). ArgoCD then syncs the `applications/` directory; each YAML there becomes a child Application.

The bootstrap Application uses:
- **repoURL:** `https://github.com/enkom/paperclip`
- **path:** `infra/cluster/applications`
- **targetRevision:** HEAD

## Applications

Everything under `cluster/applications/` is an ArgoCD Application manifest. The app-of-apps syncs this directory, so each file defines one Application.

| File | Application name | Source | Destination |
|------|------------------|--------|-------------|
| operator.yaml | hive-operator | Repo `infra/manifests/operator` | namespace hive-system |
| storage.yaml | hive-storage | Repo `infra/manifests/storage` | namespace hive-storage |
| observability.yaml | hive-observability | Helm chart kube-prometheus-stack (prometheus-community) | namespace monitoring |
| metrics-server.yaml | metrics-server | Helm chart metrics-server (Bitnami) | namespace kube-system |

So after bootstrap, ArgoCD manages: operator deployment, storage (MinIO, DragonflyDB, JuiceFS CSI), observability stack, and metrics-server from this repo (and the two Helm charts at the versions pinned in those files).

## Tenants

- **Path:** `infra/cluster/tenants/example/`
- **Role:** Example HiveCompany and HiveWorkerPool CRs. These are plain Kubernetes manifests, not ArgoCD Applications. Use them as templates; apply manually (e.g. `kubectl apply -f infra/cluster/tenants/example/` from repo root) or via scripts (e.g. `infra/scripts/create-tenant.sh`). Tenant CRs live in `hive-system` and are reconciled by the Hive operator.
