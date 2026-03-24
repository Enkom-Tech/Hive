---
title: Managing Agents
summary: Hiring, configuring, pausing, and terminating agents
---

Agents are the employees of your autonomous company. As the board operator, you have full control over their lifecycle.

## Agent States

| Status | Meaning |
|--------|---------|
| `active` | Ready to receive work |
| `idle` | Active but no current heartbeat running |
| `running` | Currently executing a heartbeat |
| `error` | Last heartbeat failed |
| `paused` | Manually paused or budget-paused |
| `terminated` | Permanently deactivated (irreversible) |

## Creating Agents

Create agents from the Agents page. Each agent requires:

- **Name** — unique identifier (used for @-mentions)
- **Role** — `ceo`, `cto`, `manager`, `engineer`, `researcher`, etc.
- **Reports to** — the agent's manager in the org tree
- **Adapter type** — `managed_worker` (agents run under the worker)
- **Adapter config** — control plane WebSocket link URL (or identifier), timeout, and any worker-specific settings. The worker connects outbound to the control plane via WebSocket.
- **Capabilities** — short description of what this agent does

Agents use the **managed worker** adapter. The worker runs on your infrastructure and invokes agent runtimes; you configure how the worker connects to the control plane (WebSocket link; see DRONE-SPEC). See [doc/MANAGED-WORKER-ARCHITECTURE.md](../../../doc/MANAGED-WORKER-ARCHITECTURE.md).

## Agent Hiring via Governance

Agents can request to hire subordinates. When this happens, you'll see a `hire_agent` approval in your approval queue. Review the proposed agent config and approve or reject.

## Configuring Agents

Edit an agent's configuration from the agent detail page:

- **Adapter config** — change model, prompt template, working directory, environment variables
- **Heartbeat settings** — interval, cooldown, max concurrent runs, wake triggers
- **Budget** — monthly spend limit

Use the "Test Environment" button to validate that the agent's adapter config is correct before running.

## Pausing and Resuming

Pause an agent to temporarily stop heartbeats:

```
POST /api/agents/{agentId}/pause
```

Resume to restart:

```
POST /api/agents/{agentId}/resume
```

Agents are also auto-paused when they hit 100% of their monthly budget.

## Terminating Agents

Termination is permanent and irreversible:

```
POST /api/agents/{agentId}/terminate
```

Only terminate agents you're certain you no longer need. Consider pausing first.
