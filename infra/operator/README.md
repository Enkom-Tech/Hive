# Hive Kubernetes operator

Reconciles `HiveCompany`, `HiveCluster`, and `HiveWorkerPool` custom resources: tenant namespaces, control-plane provisioning, and worker Deployments.

**Worker pools and the `managed_worker` model:** The operator creates board agents and points their HTTP adapter at the in-cluster worker Service. Primary execution still uses the **outbound WebSocket** from `hive-worker` to the control plane. See `control-plane/docs/deploy/hive-worker-kubernetes-operator.md` in the repository (published docs: Hive → Deploy).

## CRD / code generation

- **`make manifests`** — regenerate `config/crd/bases` (requires **bash**, e.g. Git Bash, MSYS2, or WSL).
- **Windows (PowerShell):** `.\manifests.ps1` — same as `make manifests`, uses `go run` with **controller-gen v0.20.1** (compatible with **Go 1.26**; older controller-gen v0.15.x does not build on 1.26).
- **Full generate (DeepCopy + CRDs):** `make generate` or `.\generate.ps1`.
- Override tool version: `CONTROLLER_GEN_VERSION=v0.20.1 make manifests` or `$env:CONTROLLER_GEN_VERSION='v0.20.1'; .\manifests.ps1`.

Integration tests (`make test-integration`) still expect a Unix-like environment and **setup-envtest**; use WSL or Linux for those.

**Envtest (Ginkgo):** `go test ./controllers/...` without `-short` (see repo CI *Integration tests (operator envtest)*) runs the controller suite, including **`HiveIndexer IndexerDegraded integration`** — asserts `IndexerDegraded` flips from **True** (no ready Deployment replicas) to **False** after the Deployment status subresource reports ready replicas and the `HiveIndexer` is patched to reconcile.

## IndexerDegraded status condition

`HiveIndexer` and `HiveDocIndexer` set **`IndexerDegraded`** on `status.conditions` for kubectl/SRE visibility. It is **not** a replacement for worker-side `hive_mcp_indexer_*` metrics or `HiveWorkerPool` MCP gateway conditions.

| `IndexerDegraded` | Data plane (indexer / worker Deployments) | MCP gateway (`gatewayImage` set) |
|-------------------|-------------------------------------------|----------------------------------|
| **False** | All required Deployments have `readyReplicas > 0` | Gateway not configured *or* gateway Deployment has ready replicas |
| **True** | Any required Deployment missing or has no ready replicas | Gateway configured but gateway Deployment has no ready replicas |

Reasons: **`DataPlaneNotReady`**, **`GatewayDeploymentNotReady`**, or **`IndexerHealthy`** (False status). Correlate with [control-plane security runbook — Alerts: worker MCP and indexers](../../control-plane/docs/deploy/security-runbook.md).
