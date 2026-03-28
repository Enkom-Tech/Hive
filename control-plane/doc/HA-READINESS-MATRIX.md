# API high availability — subsystem matrix

This document maps each **single-process** subsystem documented in [CONTROL-PLANE-SCALING-AND-HA.md](./CONTROL-PLANE-SCALING-AND-HA.md) to a **target** for multi-replica or HA deployments. No code changes are implied until product commits to horizontal API scaling.

| Subsystem | Code location | Target backing / strategy | Effort (indicative) |
|-----------|---------------|---------------------------|---------------------|
| Storage service cache | `server/src/storage/index.ts` | Inject `StorageService` per request or process; or external object store only (no process cache) | Low–medium |
| Run log store | `server/src/services/run-log-store.ts` | Shared object store + handles keyed by run id; or sticky sessions + single writer | Medium |
| Live events (SSE) | `server/src/services/live-events.ts` | Redis/SSE fan-out; or WebSocket gateway; subscribers must not rely on in-process emitters | Medium–high |
| Board claim challenge | `server/src/board-claim.ts` | Sticky routing to claim issuer; or move challenge state to Redis/DB with TTL | Low–medium |
| Placement / Prometheus | `server/src/placement-metrics.ts` | Push gateway or per-replica scrape with external aggregation | Low |
| Plugin supervisor | `server/src/services/plugin-supervisor.ts` | Single “plugin host” replica or out-of-process supervisor service | High |
| Workspace runtime leases | `server/src/services/workspace-runtime/` | Distributed locks (DB advisory locks, Redis); or pin workspace ops to one replica | High |
| Worker WebSocket delivery | `workers/worker-link.ts`, Redis bus | **Already:** `HIVE_WORKER_DELIVERY_BUS_URL` for cross-replica publish | Done (when configured) |

**Product gate:** Confirm **single-replica-only** vs **N API replicas** before implementing rows above. Sticky sessions reduce scope but do not fix SSE or in-memory caches by themselves.
