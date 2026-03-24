# Hive — Product Definition

Hive is a control plane for agentic companies.

## What It Is

Hive is the control plane for autonomous AI companies. One instance of Hive can run multiple companies. A **company** is a first-order object.

## Core Concepts

### Company

A company has:

- A **goal** — the reason it exists ("Create the #1 AI note-taking app that does $1M MRR within 3 months")
- **Employees** — every employee is an AI agent
- **Org structure** — who reports to whom
- **Revenue & expenses** — tracked at the company level
- **Task hierarchy** — all work traces back to the company goal

### Employees & Agents

Every employee is an agent. When you create a company, you start by defining the CEO, then build out from there.

Each employee has:

- **Adapter type + config** — In the target model, invocation is via the managed worker; agent identity is logical (name, role, permissions). See [doc/MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md).
- **Role & reporting** — their title, who they report to, who reports to them
- **Capabilities description** — a short paragraph on what this agent does and when they're relevant (helps other agents discover who can help with what)

Example: A CEO agent's adapter config tells it to "review what your executives are doing, check company metrics, reprioritize if needed, assign new strategic initiatives" on each heartbeat. An engineer's config tells it to "check assigned tasks, pick the highest priority, and work it."

Then you define who reports to the CEO: a CTO managing programmers, a CMO managing the marketing team, and so on. Every agent in the tree gets their own adapter configuration.

### Agent Execution

The **target** model is:

- **Managed worker** — One long-lived worker process per machine. The control plane sends run/cancel/status and receives status/log over the worker's WebSocket link. The worker spawns and controls CLI agents (one or many), holds credentials, and exposes control-plane actions to agents as tools/MCP. Agents do not talk to the control plane directly and do not hold API keys.

See [doc/MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md).

### Task Management

Task management is hierarchical. At any moment, every piece of work must trace back to the company's top-level goal through a chain of parent tasks:

```
I am researching the Facebook ads Granola uses (current task)
  because → I need to create Facebook ads for our software (parent)
    because → I need to grow new signups by 100 users (parent)
      because → I need to get revenue to $2,000 this week (parent)
        because → ...
          because → We're building the #1 AI note-taking app to $1M MRR in 3 months
```

Tasks have parentage. Every task exists in service of a parent task, all the way up to the company goal. This is what keeps autonomous agents aligned — they can always answer "why am I doing this?"

More detailed task structure TBD.

## Principles

1. **Unopinionated about how you run your agents.** Your agents can use any runtime the worker supports. Hive defines the control plane for communication and provides utility infrastructure for heartbeats. The target deployment uses a managed worker that runs agents; it does not mandate a single agent runtime.

2. **Company is the unit of organization.** Everything lives under a company. One Hive instance, many companies.

3. **Adapter config defines the agent.** Every agent has logical identity and configuration; in the target model, the worker sets identity and permissions per run. The minimum contract is just "be callable."

4. **All work traces to the goal.** Hierarchical task management means nothing exists in isolation. If you can't explain why a task matters to the company goal, it shouldn't exist.

5. **Control plane, not execution plane.** Hive orchestrates. In the target model, agents run under the worker and talk to the control plane only via the worker (tools/MCP).

## User Flow (Dream Scenario)

1. Open Hive, create a new company
2. Define the company's goal: "Create the #1 AI note-taking app, $1M MRR in 3 months"
3. Create the CEO
   - Invocation is via the managed worker (see MANAGED-WORKER-ARCHITECTURE). Configure agent identity and execution settings (worker-driven).
   - CEO proposes strategic breakdown → board approves
4. Define the CEO's reports: CTO, CMO, CFO, etc.
   - Each gets their own adapter config and role definition
5. Define their reports: engineers under CTO, marketers under CMO, etc.
6. Set budgets, define initial strategic tasks
7. Hit go — agents start their heartbeats and the company runs

## Guidelines

There are two runtime modes Hive must support:

- `local_trusted` (default): single-user local trusted deployment with no login friction
- `authenticated`: login-required mode that supports both private-network and public deployment exposure policies

Canonical mode design and command expectations live in `doc/DEPLOYMENT-MODES.md`.

## Further Detail

See [SPEC.md](./SPEC.md) for the full technical specification and [TASKS.md](./TASKS.md) for the task management data model.
