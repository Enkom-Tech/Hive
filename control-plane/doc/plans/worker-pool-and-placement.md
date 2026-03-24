# Worker pool, agent placement, and migration (target vs today)

## Terminology

- **Agents / employees:** Board identities (COO, engineer, etc.). They are the same concept as the **runtime** that executes when work is assigned (memories, tools, models): the board row and the coding agent are the same **agent** at different layers.
- **Drones:** `hive-worker` processes — execution capacity and harness. They hold credentials, talk to the control plane, and spawn or host agent workloads.

## Implemented today

- Each **`managed_worker` agent** (agent/employee) on the board is the unit the scheduler assigns work to. **Enrollment tokens** and the WebSocket link (`GET /api/workers/link`) authenticate **that agent id** (one link per enrolled identity on the wire at a time).
- **`worker_instances`** and **`worker_instance_agents`** bind agents to a stable **drone identity** (`instanceId` from `hive-worker` **hello**). The Workers UI groups by instance when bindings exist; operators can mint an **instance-scoped** link enrollment token from each drone row (**Instance link token**) — see `doc/MANAGED-WORKER-ARCHITECTURE.md` (agent vs instance mint table).
- One **hive-worker process** can open **multiple** WebSocket links (one per board agent) using **`HIVE_WORKER_LINKS_JSON`**, sharing one **`instanceId`** file when **`HIVE_WORKER_STATE_DIR`** (or the default config dir) is shared. Otherwise one process still enrolls as **one** agent identity by default.
- The runtime can still spawn **many agent runs / CLI processes** under that harness (see [MANAGED-WORKER-ARCHITECTURE.md](../MANAGED-WORKER-ARCHITECTURE.md)).
- There is **no** automatic **assignment** of arbitrary logical work across drones beyond this grouping, and **no** productized **migration** of an agent’s workload from host A to host B beyond manual revoke + re-enroll.

## Target (product / backend epic)

- **Agents/employees** (board identities) remain the units of **work assignment**. Their **runtime** (coding agent — memories, tools, models) is **instantiated on drone capacity** when tasks are assigned or on heartbeat.
- **Drones** form a **pool** (machines or containers with capacity, region, version). **Placement** chooses which drone runs which work; optionally **auto-balancing** as load or cost changes.
- Agents/employees are **drone-agnostic**: they are deployed, run, and controlled on systems where a drone runs, **woken** when assigned tasks or on heartbeat, and receive only what is **necessary** for their **identity/role** (context, tools, secrets).
- **Migration / drain / rebalance:** move workloads between drones with clear rules for in-flight runs, credentials, and downtime. An agent/employee is **not** permanently tied to a single `hive-worker` process.
- **Worker instances** as first-class resources in the data model and UI (capacity, health, assignments) — not only a flat list of `managed_worker` agents.

## Why this is not a UI-only change

Placement and migration need **data model** and **API** work (and likely **protocol** or multi-identity worker behavior), not just copy on the Workers page. The Workers deployment guide describes **how to install** hive-worker; this note scopes **what is not built yet**.

## Release B (in progress): placement v1

First shipped slice:

- **ADR:** [002-placement-registry-option-a.md](../adr/002-placement-registry-option-a.md) — Option A registry (`Map<agentId, ws>`), `run_placements`, optional run fields.
- **Policy / threats / SLO:** [placement-policy-and-threat-model.md](./placement-policy-and-threat-model.md).
- **Feature flag:** `HIVE_PLACEMENT_V1_ENABLED` (default off). Operators enable after DB migration and worker fleet supports placement ack / `expectedWorkerInstanceId`.

Full pool semantics (Option B) and automatic migration remain **future** work.

**Phase C (ADR 005, shipped in control plane):** HTTP **PATCH** on `worker_instances` for drain/labels/capacity; optional **auto-evacuation** of **automatic** bindings off a draining drone (`HIVE_DRAIN_AUTO_EVACUATE_ENABLED`). In-flight run migration policy remains covered by placement docs, not automatic host moves.

## References

- [MANAGED-WORKER-ARCHITECTURE.md](../MANAGED-WORKER-ARCHITECTURE.md) — harness and parallel agents.
- [SPEC.md](../SPEC.md) — checklist items around agent CRUD and worker assignment (future).
- [infra/worker/RELEASES.md](../../../infra/worker/RELEASES.md) — artifacts and pipe installers.
