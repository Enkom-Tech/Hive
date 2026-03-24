# Placement policy, threat model, and SLO (Release B)

This document gates turning on **`HIVE_PLACEMENT_V1_ENABLED`** in production. It complements [worker-pool-and-placement.md](./worker-pool-and-placement.md) and [ADR 002](../adr/002-placement-registry-option-a.md).

## Placement policy (B.1)

- **Assignment unit:** Board agents / employees remain the unit of work assignment; `heartbeat_runs` represent executed work.
- **Binding:** Each connected drone reports a stable `instanceId` in `hello`; the control plane binds the board agent to a `worker_instances` row via `worker_instance_agents`. The link registry on each API process also records that instance id after hello; if it **differs** from the board binding when dispatching (stale socket after rebinding), dispatch fails with `PLACEMENT_CONNECTION_MISMATCH` before sending the run.
- **When placement is evaluated:** When placement v1 is enabled, before dispatching a managed-worker run the server resolves the agent’s current `worker_instance_id` from the binding. If the instance has **`drain_requested_at` set**, new runs are **not** dispatched (`DRAINING` / no worker).
- **Changing drones:** Operators move an agent to another host by enrolling the worker link on the new machine; binding updates on the next successful `hello`. There is **no** automatic in-flight run migration in B.1.
- **In-flight runs:** Runs already dispatched continue on the drone that accepted them; cancel paths unchanged. A rejected placement ack fails the run early on the control plane.
- **Role-specific rules (CEO vs engineer):** No special casing in B.1; future policy can use `labels` or company policy tables.

## Threat model (addendum)

| Threat | Mitigation (B.1) |
|--------|-------------------|
| Cross-tenant access | All placement queries scoped by `company_id` from the run/agent row; never trust client-supplied instance ids for **authorization**, only for **equality checks** on the worker. |
| Forged `instanceId` in `hello` | Hello is authenticated as the board agent; binding ties agent to instance. Another tenant’s instance id in another company’s namespace does not grant access. |
| Malicious drone accepts another agent’s run | Option A: worker connects **as** one agent id; control plane sends runs only on that agent’s socket. Worker verifies `expectedWorkerInstanceId` against local disk. |
| Token theft | Short-lived link enrollment; API key rotation; existing rate limits on enrollment mint. |
| Multi-replica split brain | WebSocket may land on instance A while API instance B dispatches — use sticky LB or shared registry (ADR 002). |
| Placement retry abuse | DB-backed placement rows; avoid unbounded retries (use `next_attempt_at` and caps in a future iteration). |

## SLO and degradation

- **Dispatch timeout:** If no WebSocket is connected for the agent, behavior matches today (`NO_WORKER`). Placement adds **early failure** when the instance is draining or the worker rejects placement.
- **User-visible behavior:** Run fails with a clear error code (`DRAINING`, `PLACEMENT_MISMATCH`) in logs and run status where applicable.
- **When placement v1 is off:** No `run_placements` rows created; dispatch unchanged from Release A.

## Option B (pool workers) — planning artifacts

Future instance-scoped links and multi-agent drones are **out of scope** for Release B.1 (ADR 002 Option A). When that epic ships, use:

- [threat-model-managed-worker-pool.md](./threat-model-managed-worker-pool.md) — STRIDE, trust boundaries, multi-replica delivery options.
- [authz-matrix-managed-worker-pool.md](./authz-matrix-managed-worker-pool.md) — per-route AuthZ and test checklist.

## References

- [002-placement-registry-option-a.md](../adr/002-placement-registry-option-a.md)
- [DRONE-SPEC.md](../DRONE-SPEC.md) §11
