---
summary: Worker-mediated MCP via hive-worker mcp (stdio)
---

# Drone MCP → control plane

Agents do **not** call the control plane with agent API keys for task/cost tools. The **`hive-worker`** process receives a **`worker_api_token`** (HS256 JWT) over the WebSocket after instance registration; it persists **`worker-jwt`** under `HIVE_WORKER_STATE_DIR` (or the default config dir). The agent subprocess runs with **`HIVE_AGENT_ID`**, **`HIVE_RUN_ID`**, and a **`.mcp.json`** in the workspace pointing at **`hive-worker mcp`**.

Control plane routes (Bearer **worker** JWT only): **`/api/worker-api/*`** — see [Workers API](../../api/workers.md#worker-api-drone).

Server env: **`HIVE_WORKER_JWT_SECRET`** (required to mint/verify worker JWTs).

**Concurrency:** By default (**`HIVE_MCP_MAX_CONCURRENT=1`** or unset), **`hive-worker mcp`** handles stdio JSON-RPC **sequentially** (one in-flight handler at a time). With **`HIVE_MCP_MAX_CONCURRENT` > 1** (up to 64), multiple handlers may run in parallel; responses may be emitted **out of order** on stdout (each line is still one JSON object with the matching **`id`**). WASM skills are serialized when concurrency is greater than 1. For isolation, you can still split agents across processes.

**Operations:** JWT rotation, gateway Secret rotation, and indexer alert cues: [Security runbook](../../deploy/security-runbook.md) (*Worker-instance JWT*, *HiveIndexer / HiveDocIndexer gateway tokens*, *Alerts: worker MCP and indexers*).
