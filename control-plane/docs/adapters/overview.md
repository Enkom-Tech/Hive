---
title: Adapters Overview
summary: How agents connect to Hive via the managed worker
---

Agents run under a **managed worker**. The control plane does not spawn agent processes directly; it talks to the worker (run, stop, status). The worker invokes and controls agent runtimes and reports back.

## How It Works

1. The control plane sends run requests to the worker over a WebSocket link (the worker connects to the control plane).
2. The worker spawns or calls the agent runtime and passes context.
3. The worker captures stdout, parses usage/cost data, and sends status and log stream over the same WebSocket to the control plane.

Agent identity and config (name, role, heartbeat policy) are stored in the control plane. The worker connects to the control plane via WebSocket; connection URL and auth are configured per deployment (see DRONE-SPEC). See [doc/MANAGED-WORKER-ARCHITECTURE.md](../../doc/MANAGED-WORKER-ARCHITECTURE.md) for the full design.

## Single Adapter Type

The control plane supports one adapter type: **managed_worker**. There is no registry of process, HTTP, or local-CLI adapters. All invocation and status flow through the worker over a single WebSocket link.
