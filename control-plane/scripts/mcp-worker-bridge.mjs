#!/usr/bin/env node
/**
 * Deprecated. The agent HTTP tool bridge was removed in favor of worker-mediated MCP.
 * Use the hive-worker binary: `hive-worker mcp` (stdio JSON-RPC), with worker JWT from the
 * control plane WebSocket `worker_api_token` message (persisted as worker-jwt).
 */
console.error(
  "mcp-worker-bridge.mjs is deprecated. Use `hive-worker mcp` and /api/worker-api/* (worker JWT).",
);
process.exit(1);
