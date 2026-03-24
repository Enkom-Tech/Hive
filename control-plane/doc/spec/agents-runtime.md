# Agent Runtime Guide

Status: User-facing guide  
Last updated: 2026-02-17  
Audience: Operators setting up and running agents in Hive

## 1. What this system does

Agents in Hive do not run continuously.  
They run in **heartbeats**: short execution windows triggered by a wakeup.

The control plane does not run agent processes directly. It sends run/stop/status to a **managed worker**; the worker spawns and controls the agent (e.g. CLI) and reports back. See [doc/MANAGED-WORKER-ARCHITECTURE.md](../MANAGED-WORKER-ARCHITECTURE.md).

Each heartbeat:

1. The control plane sends a run request to the worker over the worker's WebSocket link.
2. The worker starts the agent with the current prompt/context.
3. The agent runs until it exits, times out, or is cancelled.
4. The worker sends status, token usage, errors, and log stream over the same WebSocket to the control plane.
5. The UI updates live.

Operators configure the worker and agent identity (name, role, permissions). The worker manages working directory, timeouts, and CLI invocation; agents do not hold API keys and talk to the control plane only via the worker (e.g. tools/MCP).

## 2. When an agent wakes up

An agent can be woken up in four ways:

- `timer`: scheduled interval (for example every 5 minutes)
- `assignment`: when work is assigned/checked out to that agent
- `on_demand`: manual wakeup (button/API)
- `automation`: system-triggered wakeup for future automations

If an agent is already running, new wakeups are merged (coalesced) instead of launching duplicate runs.

## 3. What to configure per agent

### 3.1 Runtime behavior

In agent runtime settings, configure heartbeat policy:

- `enabled`: allow scheduled heartbeats
- `intervalSec`: timer interval (0 = disabled)
- `wakeOnAssignment`: wake when assigned work
- `wakeOnOnDemand`: allow ping-style on-demand wakeups
- `wakeOnAutomation`: allow system automation wakeups

### 3.2 Worker and execution

The worker is configured with its endpoint, run path, and any execution limits (timeout, working directory). Those are set at the worker; per-agent config in the control plane is logical (identity, prompt template, heartbeat policy).

### 3.3 Prompt templates

You can set:

- `promptTemplate`: used for every run (first run and resumed sessions)

Templates support variables like `{{agent.id}}`, `{{agent.name}}`, and run context values.

## 4. Session resume behavior

Hive stores resumable session state per `(agent, taskKey)` (per run; worker is implied).
`taskKey` is derived from wakeup context (`taskKey`, `taskId`, or `issueId`).

- A heartbeat for the same task key reuses the previous session for that task.
- Different task keys for the same agent keep separate session state.
- If restore fails, the worker/agent process should retry once with a fresh session and continue.
- You can reset all sessions for an agent or reset one task session by task key.

Use session reset when:

- you significantly changed prompt strategy
- the agent is stuck in a bad loop
- you want a clean restart

## 5. Logs, status, and run history

For each heartbeat run you get:

- run status (`queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`)
- error text and stderr/stdout excerpts
- token usage/cost when reported by the worker
- full logs (stored outside core run rows, optimized for large output)

Full logs are stored under the configured run-log path (e.g. on disk in local/dev).

## 6. Live updates in the UI

Hive pushes runtime/activity updates to the browser in real time.

You should see live changes for:

- agent status
- heartbeat run status
- task/activity updates caused by agent work
- dashboard/cost/activity panels as relevant

If the connection drops, the UI reconnects automatically.

## 7. Common operating patterns

### 7.1 Simple autonomous loop

1. Enable timer wakeups (for example every 300s)
2. Keep assignment wakeups on
3. Use a focused prompt template
4. Watch run logs and adjust prompt/config over time

### 7.2 Event-driven loop (less constant polling)

1. Disable timer or set a long interval
2. Keep wake-on-assignment enabled
3. Use on-demand wakeups for manual nudges

### 7.3 Safety-first loop

1. Short timeout (configured at the worker)
2. Conservative prompt
3. Monitor errors + cancel quickly when needed
4. Reset sessions when drift appears

## 8. Troubleshooting

If runs fail repeatedly:

1. Confirm the worker is running and reachable from the control plane.
2. Inspect run error + stderr excerpt, then full log.
3. Check worker-side config (timeout, working directory, CLI availability).
4. Reset session and retry.
5. Pause agent if it is causing repeated bad updates.

Typical failure causes:

- worker unreachable or misconfigured
- worker-side CLI not installed or not authenticated
- timeout or working directory issues on the worker
- prompt too broad or missing constraints

## 9. Security and risk notes

The worker runs agent processes; it may run them unsandboxed on the host. Prompt instructions, credentials, and working directory permissions are sensitive. Start with least privilege where possible, and avoid exposing secrets in broad reusable prompts unless intentionally required.
