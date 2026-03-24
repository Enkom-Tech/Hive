---
title: MCP shim for the worker tool bridge
summary: Map MCP tools to POST /api/worker-tools/bridge without bypassing allowlists
---

The control plane exposes a **narrow HTTP bridge** for agents: [`POST /api/worker-tools/bridge`](../../api/workers.md) with **`HIVE_WORKER_TOOL_BRIDGE_ALLOWED_ACTIONS`**. There is no generic proxy.

For MCP-capable hosts (e.g. Cursor), you can run a **stdio MCP server** that forwards tool calls to that endpoint using the same **agent Bearer** credential.

## Reference script

[`scripts/mcp-worker-bridge.mjs`](../../../scripts/mcp-worker-bridge.mjs) implements a minimal MCP server with one tool, **`hive.worker_bridge`**, with arguments `{ "action": "<allowlisted-id>", "input": { ... } }`.

Environment:

- **`HIVE_CONTROL_PLANE_URL`** — HTTPS API base (e.g. `https://board.example.com`)
- **`HIVE_AGENT_KEY`** — agent API key or enrollment secret used as `Authorization: Bearer`

The server still enforces the allowlist and agent auth; the MCP layer does not elevate privileges.

## Security

- Do not embed long-lived keys in client-visible configs if the MCP host is shared.
- Prefer short-lived enrollment tokens where the product allows it.
