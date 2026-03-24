# ADR 002: Run placement registry (Option A)

## Status

Accepted — Release B.1 implements placement with **per-agent WebSocket links** unchanged.

## Context

Release A aligned naming (drones overview, link enrollment, `worker_instances` prep columns). **Placement** chooses which drone executes work for a board agent. Two registry models were considered:

- **Option A:** Keep `Map<agentId, WebSocket>`; enrollment remains “connect as this `managed_worker`.” Placement records a **target `worker_instances` row**; dispatch verifies the connected drone’s stable `instanceId` matches that target (via DB binding from `hello`).
- **Option B:** `Map<workerInstanceId, WebSocket>` (or equivalent) and workers accept runs for **multiple** board agents — new auth, larger blast radius for cross-agent mix-ups.

## Decision

Ship **Option A** first.

- Placement rows (`run_placements`) reference `heartbeat_runs.id` and `worker_instances.id`.
- Run WebSocket messages may include `placementId` and `expectedWorkerInstanceId` (stable UUID from drone `hello`) when `HIVE_PLACEMENT_V1_ENABLED=true`.
- Drones reject runs when `expectedWorkerInstanceId` is set and does not match the local persisted instance id.

## Multi-replica control plane

The in-memory link registry is **per API process**. Placement state in Postgres is authoritative. Operators must either:

- Use **sticky sessions** for `GET /api/workers/link` WebSocket upgrades, or
- Add a **shared registry** (e.g. Redis) in a follow-up (not part of B.1).

## Rejected / deferred

- Option B pool worker without per-agent WebSocket — separate epic; planning artifacts: [threat-model-managed-worker-pool.md](../plans/threat-model-managed-worker-pool.md), [authz-matrix-managed-worker-pool.md](../plans/authz-matrix-managed-worker-pool.md).
- Automatic live migration of in-flight runs across hosts without a written policy — blocked until [placement-policy-and-threat-model.md](../plans/placement-policy-and-threat-model.md) is extended.

## References

- [001-drone-agent-naming.md](./001-drone-agent-naming.md)
- [placement-policy-and-threat-model.md](../plans/placement-policy-and-threat-model.md)
- [worker-pool-and-placement.md](../plans/worker-pool-and-placement.md)
- [threat-model-managed-worker-pool.md](../plans/threat-model-managed-worker-pool.md)
- [authz-matrix-managed-worker-pool.md](../plans/authz-matrix-managed-worker-pool.md)
