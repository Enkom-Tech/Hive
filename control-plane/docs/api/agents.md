---
title: Agents
summary: Agent lifecycle, configuration, keys, and heartbeat invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Worker connection status

```
GET /api/agents/{agentId}/worker-connection
```

Returns whether a managed worker is currently connected for this agent over the WebSocket link (`/api/workers/link`). Same company access rules as `GET /api/agents/{agentId}`.

Per-process caveat: see [Workers API](./workers.md#multi-instance--load-balancing).

**Response:**

```json
{ "connected": true }
```

## Drones / board-agent overview (company)

```
GET /api/companies/{companyId}/drones/overview
```

Board agents, optional drone grouping (`instances`), link metadata, and hello fields. See [Workers](./workers.md).

## Mint link enrollment token (board)

```
POST /api/agents/{agentId}/link-enrollment-tokens
Content-Type: application/json

{ "ttlSeconds": 900 }
```

`ttlSeconds` is optional (default 900), range 120–3600. **Board / instance admin only** (same as creating API keys).

Returns a **one-time** secret for the worker WebSocket link. The plaintext `token` is shown only in this response; the server stores only a SHA-256 hash. When the worker presents the token on `/api/workers/link`, the server checks agent eligibility, then **consumes** the token in the same request (before completing the WebSocket upgrade). Concurrent retries use an atomic update so only one connection wins. Long-lived agent API keys remain supported for automation.

For **instance-scoped** mint (shared host / one token per `worker_instances` row), see [Workers](./workers.md) (section *Mint instance link enrollment token*) — same JSON body and response shape.

**Response (201):**

```json
{
  "token": "hive_wen_…",
  "expiresAt": "2025-03-20T12:30:00.000Z"
}
```

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "managed_worker",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent. The control plane delivers the run to the worker via the worker's WebSocket link; the worker spawns the agent and sends status/log over the same link.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for the adapter type (e.g. `managed_worker`). Behavior is defined by the worker implementation (communication is WebSocket-only; see DRONE-SPEC).

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
