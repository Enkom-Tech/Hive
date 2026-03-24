# ADR 005: Fleet, identity, and assignment (harness capacity)

## Status

Accepted. Supersedes informal assumptions documented in [004](004-drone-first-provisioning.md) where “static employee” wording conflicted with harnessed execution.

## Context

Board **agents** (`managed_worker`) are **execution identities**: schedulable work runs on **drone** (`hive-worker`) **harness capacity** ([MANAGED-WORKER-ARCHITECTURE.md](../MANAGED-WORKER-ARCHITECTURE.md), [DRONE-SPEC.md](../DRONE-SPEC.md)). Two concerns must stay **orthogonal**:

1. **Fleet** — Register and observe drones (`worker_instances`, hello telemetry, drain, labels).
2. **Assignment** — Which identity may run on which drone (`worker_instance_agents`), changed only via the **worker-assignment** service ([`services/worker-assignment/`](../../server/src/services/worker-assignment/)).

Previously, **agent-scoped** `hello` could **insert** `worker_instance_agents`, coupling capacity registration to identity assignment. That path is **removed**; `hello` updates metadata only.

## Decision

1. **Single writer** — All mutations to `worker_instance_agents` go through [`worker-assignment`](../../server/src/services/worker-assignment/); [`agents.ts`](../../server/src/services/agents.ts) delegates and does not persist assignment rows itself.
2. **No hello → binding** — [`applyWorkerHello`](../../server/src/workers/worker-hello.ts) does not write `worker_instance_agents`. Provision and instance upsert paths remain as in ADR 004.
3. **Placement metadata** — `assignment_source` (`manual` | `automatic`) on bindings; `worker_placement_mode` and `operational_posture` on `agents` for policy and lifecycle gates (see migrations).
4. **Registry** — After assignment changes, [`syncWorkerInstanceBindings`](../../server/src/workers/worker-link-registry.ts) keeps the in-memory link registry aligned with Postgres (ADR 004).
5. **Pool mobility** — Board `POST .../agents/{agentId}/worker-pool/rotate` advances `worker_placement_mode=automatic` bindings to the next **eligible** drone (same filters as automatic placement: non-draining, labels, sandbox). Unbound automatic identities get a first automatic bind when eligible drones exist. Implementation: [`worker-assignment-service`](../../server/src/services/worker-assignment/worker-assignment-service.ts).
6. **Drain + evacuation (Phase C)** — Board `PATCH .../worker-instances/{id}` can set **`drain_requested_at`**. When **`HIVE_DRAIN_AUTO_EVACUATE_ENABLED=true`**, transitioning a row into draining triggers rebinding of **`worker_instance_agents`** rows with **`assignment_source = automatic`** (and agent `worker_placement_mode = automatic`) onto other eligible drones; manual bindings stay until the operator moves them.

## Consequences

- Operators attach identities via board APIs or **automatic placement** (when enabled) rather than inferring assignment from `hello`.
- Docs and UI describe **deploy drone → assign identity**, consistent with harness engineering (drone = harness; identity = workload routed onto harness).

## Harness engineering (control-plane role)

In this product, **`hive-worker` is the harness**: credentials, WebSocket to the control plane, and process/container orchestration for board identities. **Fleet** registration (`worker_instances`, hello, drain, labels) is capacity; **assignment** (`worker_instance_agents`) is which identity may execute on which harness. **Operational posture** (active / hibernate / archived / sandbox) and **placement mode** (manual / automatic) are **governance** inputs: they gate heartbeat claims, managed-worker execute, and bind APIs so reliability and security policies stay consistent with worker-side harness behavior (see [MANAGED-WORKER-ARCHITECTURE.md](../MANAGED-WORKER-ARCHITECTURE.md), [DRONE-SPEC.md](../DRONE-SPEC.md)). Deeper harness concerns (tool paths, MCP, worktrees) remain documented in worker specs and are not duplicated here.

## References

- [002-placement-registry-option-a.md](002-placement-registry-option-a.md)
- [004-drone-first-provisioning.md](004-drone-first-provisioning.md)
- [worker-pool-and-placement.md](../plans/worker-pool-and-placement.md)
