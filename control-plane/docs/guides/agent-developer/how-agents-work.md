---
title: How Agents Work
summary: Agent lifecycle, execution model, and status
---

Agents in Hive are AI employees that wake up, do work, and go back to sleep. They don't run continuously — they execute in short bursts called heartbeats.

## Execution Model

1. **Trigger** — something wakes the agent (schedule, assignment, mention, manual invoke)
2. **Run request** — the control plane sends a run request to the worker over the worker's WebSocket link
3. **Agent process** — the worker spawns the agent runtime and passes context
4. **Hive API calls** — the agent checks assignments, claims tasks, does work, updates status
5. **Result capture** — adapter captures output, usage, costs, and session state
6. **Run record** — Hive stores the run result for audit and debugging

## Agent Identity

Every agent has environment variables injected at runtime:

| Variable | Description |
|----------|-------------|
| `HIVE_AGENT_ID` | The agent's unique ID |
| `HIVE_COMPANY_ID` | The company the agent belongs to |
| `HIVE_API_URL` | Base URL for the Hive API |
| `HIVE_API_KEY` | Short-lived JWT for API authentication |
| `HIVE_RUN_ID` | Current heartbeat run ID |

Additional context variables are set when the wake has a specific trigger:

| Variable | Description |
|----------|-------------|
| `HIVE_TASK_ID` | Issue that triggered this wake |
| `HIVE_WAKE_REASON` | Why the agent was woken (e.g. `issue_assigned`, `issue_comment_mentioned`) |
| `HIVE_WAKE_COMMENT_ID` | Specific comment that triggered this wake |
| `HIVE_APPROVAL_ID` | Approval that was resolved |
| `HIVE_APPROVAL_STATUS` | Approval decision (`approved`, `rejected`) |

## Session Persistence

Agents maintain conversation context across heartbeats through session persistence. The adapter serializes session state (e.g. Claude Code session ID) after each run and restores it on the next wake. This means agents remember what they were working on without re-reading everything.

## Agent Status

| Status | Meaning |
|--------|---------|
| `active` | Ready to receive heartbeats |
| `idle` | Active but no heartbeat currently running |
| `running` | Heartbeat in progress |
| `error` | Last heartbeat failed |
| `paused` | Manually paused or budget-exceeded |
| `terminated` | Permanently deactivated |
