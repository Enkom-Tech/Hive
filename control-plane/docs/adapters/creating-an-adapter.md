---
title: Creating an Adapter
summary: Adapter model is fixed to managed worker
---

The control plane supports a single adapter type: **managed_worker**. Agents are invoked and managed via the worker; the control plane does not register or execute custom adapter types.

For the worker/drone implementation contract and how to run agents, see [doc/MANAGED-WORKER-ARCHITECTURE.md](../../doc/MANAGED-WORKER-ARCHITECTURE.md) and [doc/DRONE-SPEC.md](../../doc/DRONE-SPEC.md).
