---
title: Drone (VPS/Docker) identity bootstrap
summary: How board identities get onto a new drone — provision token vs operator-created agents and automatic placement
---

The **drone** (`hive-worker`) registers **fleet capacity** (`worker_instances`). It does **not** create `managed_worker` agent rows. Assignment (`worker_instance_agents`) is always explicit policy or operator action ([ADR 005](../../doc/adr/005-fleet-identity-assignment.md)).

## Recommended patterns

### A — Drone-first, identities already exist (typical)

1. Operators create **`managed_worker`** agents on the board (or import them).
2. Set **`worker_placement_mode = automatic`** on agents that should float across the pool, and enable **`HIVE_AUTO_PLACEMENT_ENABLED`** on the server.
3. Mint **`POST .../drone-provisioning-tokens`**, deploy the worker with **`HIVE_DRONE_PROVISION_TOKEN`**.
4. On first successful provision **`hello`**, the control plane registers the drone and runs **automatic assignment reconcile** for unbound automatic agents in that company.
5. Remaining identities: **bind manually** via **`PUT .../worker-instances/.../agents/...`** or rotate pool as needed.

### B — Kubernetes operator path

**`HiveWorkerPool`** can create agents, keys, and **`hive-worker`** pods ([hive-worker-kubernetes-operator.md](./hive-worker-kubernetes-operator.md)). Treat pool members as **`managed_worker`** harnesses even if an HTTP adapter URL exists for legacy schedulers.

### C — Declarative “N agents” API (not shipped)

A single “desired state” API (e.g. “ensure three codex workers for this company”) is **not** implemented in the control plane today. Use **A** or **B**, or automate agent creation via **board API/CLI** under your own IaC.

## Checklist

- [ ] Agents exist (`managed_worker`) before or after drone online; provision flow does not create them.
- [ ] If using automatic placement: server flag + agent `worker_placement_mode` + eligible non-draining drones.
- [ ] If using manual bind: use Workers UI or bind API after the drone appears in **`drones/overview`**.

See also: [worker deployment matrix](./worker-deployment-matrix.md), [Workers API](../api/workers.md).
