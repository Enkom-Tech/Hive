---
title: Hive worker pool (Kubernetes operator)
summary: How HiveWorkerPool relates to managed_worker and the hive-worker runtime
---

The **Hive** Kubernetes operator (see [`infra/operator`](../../../infra/operator)) reconciles `HiveWorkerPool` resources: it creates **managed** board agents on the control plane, mints keys, and runs `hive-worker` pods in a tenant namespace.

## Why the operator still mentions “HTTP adapter”

On the board, each automated pool worker is represented as an **agent** row. The operator sets that agent’s **adapter type** to `http` and points **`adapterConfig.url`** at the in-cluster **Service** URL for the worker Deployment (e.g. `http://<pool>.<tenant-ns>.svc.cluster.local:8080/run`).

That path exists so **legacy or generic** “invoke agent over HTTP” flows can target the same process. **Managed worker execution** (runs, cancel, logs) still uses the **outbound WebSocket** from `hive-worker` to `GET /api/workers/link`. The drone does not replace WebSocket delivery with HTTP for the primary run loop; the HTTP adapter URL is a **compatibility bridge** for scheduling layers that expect an HTTP surface.

For product semantics, treat pool members as **`managed_worker`** identities: operators bind work to those agents; the runtime is always `hive-worker` in the cluster.

## Reconciliation summary

| Resource | Purpose |
|----------|---------|
| `HiveCompany` | Supplies `companyId` for control-plane API calls. |
| `HiveCluster` | Control-plane URL + provisioner token for API auth. |
| Secrets | Per-replica `agentId` + key material; combined secret when `replicas > 1`. |
| Deployment | `hive-worker` image, `HIVE_CONTROL_PLANE_URL`, agent env, probes on `:8080/health`. |
| Service | Cluster IP for `adapterConfig.url`. |

## Pinning images

Set `spec.workerImage` to an immutable reference when possible:

- `registry.example/hive-worker@sha256:<digest>` for reproducible rollouts, or
- A tag you control and scan (`:v1.2.3`).

The controller passes the string through to the pod unchanged. Prefer digest pinning for production (see [worker deployment matrix](./worker-deployment-matrix.md)).

## Further reading

- [Worker deployment matrix](./worker-deployment-matrix.md)
- [`doc/MANAGED-WORKER-ARCHITECTURE.md`](../../doc/MANAGED-WORKER-ARCHITECTURE.md)
- [Workers API](../api/workers.md)
