# ADR 003: Unified managed-worker links (instance-keyed registry)

## Status

Accepted — supersedes dual-stack Option A/B delivery. [ADR 002](./002-placement-registry-option-a.md) remains historical context for placement fields; **dispatch authority** is unified here.

## Context

Per-agent `Map<agentId, WebSocket>` and a separate pool `Map<instanceId, …>` imply two code paths, double tests, and flags to switch implementations. Operators need both:

- **Single-agent container:** agent-scoped link enrollment (familiar UX).
- **Multi-agent host:** one `hive-worker`, one socket, many board agents on the same `worker_instances` row.

## Decision

1. **Registry keys:** `worker_instances.id` (internal UUID). At most one open socket per instance id on a given API process.
2. **Agent-scoped enrollment:** unchanged HTTP mint; on connect the socket is **pending** by `agentId` until `hello` persists binding; then the connection is registered on the instance key and `agentId → instanceId` maps are updated.
3. **Instance-scoped enrollment:** new hashed token table `worker_instance_link_enrollment_tokens`; upgrade verifies `companyId` + `worker_instance_id`; connection registers immediately on instance key with `agentIds` loaded from `worker_instance_agents`.
4. **Dispatch:** `sendRunToWorker(agentId, …)` resolves `agentId → instance` (DB binding + in-memory maps) and sends on that instance’s socket. Envelope always includes `agentId` for the worker.
5. **Multi-replica:** optional `HIVE_WORKER_DELIVERY_BUS_URL`. When set, undelivered local sends are published on a **Redis-protocol** pub/sub bus (`ioredis`); subscribers on each replica attempt local `ws.send`. Single-replica installs omit it. The URL targets any **RESP-compatible** server operators choose (managed **Redis**, **Dragonfly**, **Valkey**, cloud “Redis API”, etc.); validate pub/sub and TLS in staging before production.

## Consequences

- **Breaking:** coordinated release of control plane + `hive-worker` that sends `agentId` on status/log when running multi-agent workloads.
- **Threat model:** [threat-model-managed-worker-pool.md](../plans/threat-model-managed-worker-pool.md) applies; pool blast radius mitigated by server binding + worker `expectedWorkerInstanceId` checks.

## References

- [authz-matrix-managed-worker-pool.md](../plans/authz-matrix-managed-worker-pool.md)
- [DRONE-SPEC.md](../DRONE-SPEC.md)
