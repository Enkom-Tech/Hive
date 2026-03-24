#!/usr/bin/env node
/**
 * Minimal MCP (stdio JSON-RPC) shim over POST /api/worker-tools/bridge.
 * Env: HIVE_CONTROL_PLANE_URL (https://board), HIVE_AGENT_KEY (Bearer).
 *
 * Exposes one tool: hive.worker_bridge — args: { action: string, input?: object }
 * Does not bypass server allowlists (HIVE_WORKER_TOOL_BRIDGE_ALLOWED_ACTIONS).
 */
import readline from "node:readline";

const base = (process.env.HIVE_CONTROL_PLANE_URL ?? "").replace(/\/+$/, "");
const token = process.env.HIVE_AGENT_KEY ?? "";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function bridge(action, input) {
  const url = `${base}/api/worker-tools/bridge`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, input: input ?? {} }),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`bridge ${res.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  const method = msg.method;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "hive-worker-bridge", version: "0.1.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "hive.worker_bridge",
            description: "Call allowlisted POST /api/worker-tools/bridge actions",
            inputSchema: {
              type: "object",
              properties: {
                action: { type: "string" },
                input: { type: "object" },
              },
              required: ["action"],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name !== "hive.worker_bridge") {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } });
      return;
    }
    if (!base || !token) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Set HIVE_CONTROL_PLANE_URL and HIVE_AGENT_KEY" },
      });
      return;
    }
    try {
      const out = await bridge(String(args.action), args.input);
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(out) }] },
      });
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      });
    }
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported method ${method}` } });
});
