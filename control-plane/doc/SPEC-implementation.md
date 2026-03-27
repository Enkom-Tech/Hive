# Hive Implementation Spec

Hive is a control plane for AI-agent companies. This document is the implementation contract for Hive.

Status: Implementation contract for first release
Date: 2026-02-17
Audience: Product, engineering, and agent-integration authors
Source inputs: `GOAL.md`, `PRODUCT.md`, `SPEC.md`, `DATABASE.md`, current monorepo code

## 1. Document Role

`SPEC.md` remains the long-horizon product spec.
This document is the concrete, build-ready implementation contract.
When there is a conflict, `SPEC-implementation.md` controls implementation behavior.

## 2. Outcomes

Hive must provide a full control-plane loop for autonomous agents:

1. A human board creates a company and defines goals.
2. The board creates and manages agents in an org tree.
3. Agents receive and execute tasks via heartbeat invocations.
4. All work is tracked through tasks/comments with audit visibility.
5. Token/cost usage is reported and budget limits can stop work.
6. The board can intervene anywhere (pause agents/tasks, override decisions).

Success means one operator can run a small AI-native company end-to-end with clear visibility and control.

## 3. Explicit Product Decisions

These decisions close open questions from `SPEC.md`.

| Topic | Decision |
|---|---|
| Tenancy | Single-tenant deployment, multi-company data model |
| Company model | Company is first-order; all business entities are company-scoped |
| Board | Single human board operator per deployment |
| Org graph | Strict tree (`reports_to` nullable root); no multi-manager reporting |
| Visibility | Full visibility to board and all agents in same company |
| Communication | Tasks + comments only (no separate chat system) |
| Task ownership | Single assignee; atomic checkout required for `in_progress` transition |
| Recovery | No automatic reassignment; work recovery stays manual/explicit |
| Agent adapters | Single managed-worker adapter; control plane talks only to the worker. See [doc/MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md). |
| Auth | Worker-held credentials for control-plane API; agents do not hold API keys. Board auth unchanged (mode-dependent: `local_trusted` implicit board; authenticated mode uses sessions). |
| Budget period | Monthly UTC calendar window |
| Budget enforcement | Soft alerts + hard limit auto-pause |
| Deployment modes | Canonical model is `local_trusted` + `authenticated` with `private/public` exposure policy (see `doc/DEPLOYMENT-MODES.md`) |

## 4. Current Baseline (Repo Snapshot)

As of 2026-02-17, the repo already includes:

- Node + TypeScript backend with REST CRUD for `agents`, `projects`, `goals`, `issues`, `activity`
- React UI pages for dashboard/agents/projects/goals/issues lists
- PostgreSQL schema via Drizzle with embedded PostgreSQL fallback when `DATABASE_URL` is unset

Implementation extends this baseline into a company-centric, governance-aware control plane.

## 5. Scope

## 5.1 In Scope

- Company lifecycle (create/list/get/update/archive)
- Goal hierarchy linked to company mission
- Agent lifecycle with org structure and worker assignment (no per-agent adapter type/config beyond what the worker needs)
- Task lifecycle with parent/child hierarchy and comments
- Atomic task checkout and explicit task status transitions
- Board approvals for hires and CEO strategy proposal
- Heartbeat invocation, status tracking, and cancellation (control plane requests run from worker; worker reports status)
- Cost event ingestion and rollups (agent/task/project/company)
- Budget settings and hard-stop enforcement
- Board web UI for dashboard, org chart, tasks, agents, approvals, costs
- Worker-mediated API contract (task read/write, heartbeat report, cost report) — worker calls on behalf of agents
- Company-scoped SSE stream (`GET /companies/:companyId/events`) for broad real-time updates (activity, heartbeat, agent events)
- Workload/capacity API (`GET /companies/:companyId/workload`) for throttle signals (normal | throttle | shed | pause) so agents and gateways can back off when under load
- Auditable activity log for all mutating actions
- **Multi-human RBAC:** viewer / operator / admin membership roles, `PermissionKey` enforcement on board routes (`assertCompanyPermission`), `tasks:assign_scope` chain-of-command evaluation, join inbox visibility for all company readers with approve actions gated by `joins:approve` (see `doc/plans/rbac-route-matrix.md`, `doc/plans/humans-and-permissions.md`).
- **Plugin platform (MVP):** deployment-scoped registry (`plugin_packages` / `plugin_instances`), board lifecycle APIs under `plugins:manage`, live-event fan-out bridge for OOP supervisors, internal Bearer RPC (`HIVE_PLUGIN_HOST_SECRET`), worker-api **read-only** plugin tool catalog, versioned `@hive/plugin-sdk` (manifest + RPC client). See `doc/plugins/PLUGIN_SPEC.md`, `doc/plans/threat-model-plugins.md`.

### 5.1.1 Execution workspace

Execution workspace is optional. Projects may define an execution workspace policy; issues may request isolated mode. When a run uses project/issue context that requests isolated execution, the control plane realizes an execution workspace (today: git worktree under the project repo; future: adapter-managed or remote workspace), injects `context.hiveWorkspace` (cwd, worktreePath, branchName, strategy, etc.) for the agent, and runs a project-defined provision command in that workspace when configured. When the project policy sets `cleanupPolicy.mode` to **`on_done`**, the control plane runs the configured teardown command (if any) and removes the git worktree after the issue reaches **`done`** or **`cancelled`**. Mode **`on_merged`** runs the same teardown for **`done`** only (skips **cancelled**). GitHub **merge** webhooks (`HIVE_VCS_GITHUB_WEBHOOK_ENABLED`) can drive `on_merged` teardown when `issues.execution_workspace_branch` matches the merged head ref; automatic remote branch deletion remains future work — see `doc/experimental/issue-worktree-support.md` and `doc/plans/workspace-strategy-and-git-worktrees.md` (Phase 8).

## 5.2 Out of Scope

- Revenue/expense accounting beyond model/token costs
- Knowledge base subsystem
- Plugin marketplace, third-party arbitrary DB migrations, and iframe UI slots in plugins (v1 deferred per `PLUGIN_SPEC.md`)
- Full OOP plugin process supervisor with cgroups/mTLS (host RPC + schema/SDK shipped; hardening phases documented in `threat-model-plugins.md`)

### 5.2.1 RBAC and plugins — done criteria

- **RBAC:** Every board mutating route declares a `PermissionKey` (or documented `assertBoard` / `assertInstanceAdmin` exception); integration tests cover viewer-deny / operator-allow patterns for representative routes; `doc/plans/rbac-route-matrix.md` updated when routes change.
- **Plugins:** Migration `0050_plugin_registry` applied; operators can register manifests via board API; `rpc.ping` succeeds only when `rpc.ping` capability is stored; worker-api exposes plugin tool names without bypassing route-scoped checks.

## 6. Architecture

## 6.1 Runtime Components

- `server/`: REST API, auth, orchestration services
- `ui/`: Board operator interface
- `packages/db/`: Drizzle schema, migrations, DB clients (Postgres)
- `packages/shared/`: Shared API types, validators, constants

## 6.2 Data Stores

- Primary: PostgreSQL
- Local default: embedded PostgreSQL at `~/.hive/instances/default/db` (or `%USERPROFILE%\.hive\instances\default\db` on Windows)
- Optional local prod-like: Docker Postgres
- Optional hosted: Supabase/Postgres-compatible
- File/object storage:
  - local default: `~/.hive/instances/default/data/storage` (`local_disk`)
  - cloud: S3-compatible object storage (`s3`)

## 6.3 Background Processing

A lightweight scheduler/worker in the server process handles:

- heartbeat trigger checks
- stuck run detection
- budget threshold checks

Separate queue infrastructure is not required for this release.

## 7. Canonical Data Model

All core tables include `id`, `created_at`, `updated_at` unless noted.

## 7.0 Auth Tables

Human auth tables (`users`, `sessions`, and provider-specific auth artifacts) are managed by the selected auth library. This spec treats them as required dependencies and references `users.id` where user attribution is needed.

## 7.1 `companies`

- `id` uuid pk
- `name` text not null
- `description` text null
- `status` enum: `active | paused | archived`
- `require_quality_review_for_done` boolean not null default false (default for task-level quality gate when issue.requires_quality_review is null)
- `model_training_runner_url` text null (overrides deployment default for training dispatch)
- `identity_self_tune_policy` text not null default `disabled` (`disabled` | `approval_required` | `auto_dispatch` — reserved for worker-initiated flows)
- `require_approval_for_model_promotion` boolean not null default false

Invariant: every business record belongs to exactly one company.

## 7.2 `agents`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `role` text not null
- `title` text null
- `status` enum: `active | paused | idle | running | error | terminated`
- `reports_to` uuid fk `agents.id` null
- `capabilities` text null
- `adapter_type` enum: `managed_worker` (invocation is via worker only)
- `adapter_config` jsonb (worker-related config only, e.g. worker endpoint id or null if agent is logical and worker is registered separately)
- `context_mode` enum: `thin | fat` default `thin`
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- `last_heartbeat_at` timestamptz null
- `identity_self_tune_policy` text null (inherits company when null)

Invariants:

- agent and manager must be in same company
- no cycles in reporting tree
- `terminated` agents cannot be resumed

## 7.3 `agent_api_keys` (worker credentials)

- `id` uuid pk
- `agent_id` uuid fk `agents.id` not null
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `key_hash` text not null
- `last_used_at` timestamptz null
- `revoked_at` timestamptz null

Used by the worker when acting for an agent; agents do not hold or see keys. Plaintext key shown once at creation; only hash stored.

## 7.4 `goals`

- `id` uuid pk
- `company_id` uuid fk not null
- `title` text not null
- `description` text null
- `level` enum: `company | team | agent | task`
- `parent_id` uuid fk `goals.id` null
- `owner_agent_id` uuid fk `agents.id` null
- `status` enum: `planned | active | achieved | cancelled`

Invariant: at least one root `company` level goal per company.

## 7.5 `projects`

- `id` uuid pk
- `company_id` uuid fk not null
- `goal_id` uuid fk `goals.id` null
- `name` text not null
- `description` text null
- `status` enum: `backlog | planned | in_progress | completed | cancelled`
- `lead_agent_id` uuid fk `agents.id` null
- `target_date` date null

## 7.6 `issues` (core task entity)

- `id` uuid pk
- `company_id` uuid fk not null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `parent_id` uuid fk `issues.id` null
- `title` text not null
- `description` text null
- `status` enum: `backlog | todo | in_progress | in_review | quality_review | done | blocked | cancelled`
- `priority` enum: `critical | high | medium | low`
- `requires_quality_review` boolean null (per-task override; null = use company default)
- `assignee_agent_id` uuid fk `agents.id` null
- `created_by_agent_id` uuid fk `agents.id` null
- `created_by_user_id` uuid fk `users.id` null
- `request_depth` int not null default 0
- `billing_code` text null
- `started_at` timestamptz null
- `completed_at` timestamptz null
- `cancelled_at` timestamptz null

Invariants:

- single assignee only
- task must trace to company goal chain via `goal_id`, `parent_id`, or project-goal linkage
- `in_progress` requires assignee
- terminal states: `done | cancelled`

## 7.7 `issue_comments`

- `id` uuid pk
- `company_id` uuid fk not null
- `issue_id` uuid fk `issues.id` not null
- `author_agent_id` uuid fk `agents.id` null
- `author_user_id` uuid fk `users.id` null
- `body` text not null

## 7.8 `heartbeat_runs`

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `invocation_source` enum: `scheduler | manual | callback`
- `status` enum: `queued | running | succeeded | failed | cancelled | timed_out`
- `started_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null
- `external_run_id` text null
- `context_snapshot` jsonb null

## 7.9 `cost_events`

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk `agents.id` not null
- `issue_id` uuid fk `issues.id` null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `billing_code` text null
- `provider` text not null
- `model` text not null
- `input_tokens` int not null default 0
- `output_tokens` int not null default 0
- `cost_cents` int not null
- `occurred_at` timestamptz not null

Invariant: each event must attach to agent and company; rollups are aggregation, never manually edited.

## 7.10 `approvals`

- `id` uuid pk
- `company_id` uuid fk not null
- `type` enum: `hire_agent | approve_ceo_strategy | quality_review | promote_model`
- `requested_by_agent_id` uuid fk `agents.id` null
- `requested_by_user_id` uuid fk `users.id` null
- `status` enum: `pending | approved | rejected | cancelled`
- `payload` jsonb not null
- `decision_note` text null
- `decided_by_user_id` uuid fk `users.id` null
- `decided_at` timestamptz null

## 7.11 `activity_log`

- `id` uuid pk
- `company_id` uuid fk not null
- `actor_type` enum: `agent | user | system`
- `actor_id` uuid/text not null
- `action` text not null
- `entity_type` text not null
- `entity_id` uuid/text not null
- `details` jsonb null
- `created_at` timestamptz not null default now()

## 7.12 `company_secrets` + `company_secret_versions`

- Secret values are not stored inline in `agents.adapter_config.env`.
- Agent env entries should use secret refs for sensitive values.
- `company_secrets` tracks identity/provider metadata per company.
- `company_secret_versions` stores encrypted/reference material per version.
- Default provider in local deployments: `local_encrypted`.

Operational policy:

- Config read APIs redact sensitive plain values.
- Activity and approval payloads must not persist raw sensitive values.
- Config revisions may include redacted placeholders; such revisions are non-restorable for redacted fields.

## 7.13 Required Indexes

- `agents(company_id, status)`
- `agents(company_id, reports_to)`
- `issues(company_id, status)`
- `issues(company_id, assignee_agent_id, status)`
- `issues(company_id, parent_id)`
- `issues(company_id, project_id)`
- `cost_events(company_id, occurred_at)`
- `cost_events(company_id, agent_id, occurred_at)`
- `heartbeat_runs(company_id, agent_id, started_at desc)`
- `approvals(company_id, status, type)`
- `activity_log(company_id, created_at desc)`
- `assets(company_id, created_at desc)`
- `assets(company_id, object_key)` unique
- `issue_attachments(company_id, issue_id)`
- `company_secrets(company_id, name)` unique
- `company_secret_versions(secret_id, version)` unique
- `intents(company_id, canonical_key)` unique (for deterministic folding lookup)
- `intent_links(intent_id)`
- `intent_links(company_id, entity_type, entity_id)`

## 7.14 `assets` + `issue_attachments`

- `assets` stores provider-backed object metadata (not inline bytes):
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `provider` enum/text (`local_disk | s3`)
  - `object_key` text not null
  - `content_type` text not null
  - `byte_size` int not null
  - `sha256` text not null
  - `original_filename` text null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
- `issue_attachments` links assets to issues/comments:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `asset_id` uuid fk not null
  - `issue_comment_id` uuid fk null

## 7.15 `intents` + `intent_links` (deterministic intent folding)

Deterministic intent folding normalizes and folds user/agent requests into canonical intents. See [doc/INTENT-FOLDING.md](INTENT-FOLDING.md) for the full design.

- **intents:** `id` uuid pk, `company_id` uuid fk not null, `source` text (e.g. `board` | `agent` | `api`), `raw_text` text, `normalized_text` text, `intent_type` text (e.g. `create_issue`), `state` text (`open` | `folded` | `closed` | `rejected`), `canonical_key` text not null, `created_at` / `updated_at` timestamptz. Invariant: company-scoped; folding matches on (company_id, canonical_key) for open intents.
- **intent_links:** `id` uuid pk, `intent_id` uuid fk intents not null, `company_id` uuid fk not null, `entity_type` text (`issue` | `goal` | `project` | `heartbeat_run` | …), `entity_id` text, `link_type` text (`primary` | `duplicate` | `related`), `created_at` timestamptz. Invariant: writes to intents and intent_links occur in the same transaction as the linked entity (e.g. issue creation).

## 7.16 `model_training_runs` (identity model improvement)

Orchestrated fine-tuning / RL jobs that promote new OpenAI-compatible inference routes per company. See [adr/008-model-training-runs.md](adr/008-model-training-runs.md).

- `id` uuid pk, `company_id` fk, `deployment_id` fk (denormalized), optional `agent_id`, optional `source_inference_model_id` fk `inference_models`, `proposed_model_slug` text, `status` (`queued` | `dispatched` | `running` | `succeeded` | `failed` | `cancelled` | `promoted`), `runner_kind`, optional `runner_target_url`, `external_job_ref`, `result_base_url`, `result_metadata` jsonb, `last_callback_digest`, optional `promoted_inference_model_id`, `promoted_at`, `error`, `callback_token_hash` (SHA-256 of per-run secret), optional `dataset_filter_spec`, optional `idempotency_key` (unique per company when set), timestamps.
- **Dataset export** (board or callback token): NDJSON stream of `type: heartbeat_run` lines, then one `type: cost_aggregate` line (`cost_events` sums; window from `dataset_filter_spec.costOccurredAfter` / `costOccurredBefore` or default 90 days). Other `dataset_filter_spec` keys include `maxRuns` (heartbeat row cap).

## 8. State Machines

## 8.1 Agent Status

Allowed transitions:

- `idle -> running`
- `running -> idle`
- `running -> error`
- `error -> idle`
- `idle -> paused`
- `running -> paused` (requires cancel flow)
- `paused -> idle`
- `* -> terminated` (board only, irreversible)

## 8.2 Issue Status

Allowed transitions:

- `backlog -> todo | cancelled`
- `todo -> in_progress | blocked | cancelled`
- `in_progress -> in_review | blocked | done | cancelled`
- `in_review -> in_progress | done | cancelled`
- `blocked -> todo | in_progress | cancelled`
- terminal: `done`, `cancelled`

Side effects:

- entering `in_progress` sets `started_at` if null
- entering `done` sets `completed_at`
- entering `cancelled` sets `cancelled_at`

## 8.3 Approval Status

- `pending -> approved | rejected | cancelled`
- terminal after decision

## 9. Auth and Permissions

## 9.1 Board Auth

- Session-based auth for human operator
- Board has full read/write across all companies in deployment
- Every board mutation writes to `activity_log`

## 9.2 Agent Auth

- Bearer API key mapped to one agent and company
- Agent key scope:
  - read org/task/company context for own company
  - read/write own assigned tasks and comments
  - create tasks/comments for delegation
  - report heartbeat status
  - report cost events
- Agent cannot:
  - bypass approval gates
  - modify company-wide budgets directly
  - mutate auth/keys

## 9.3 Permission Matrix

| Action | Board | Agent |
|---|---|---|
| Create company | yes | no |
| Hire/create agent | yes (direct) | request via approval |
| Pause/resume agent | yes | no |
| Create/update task | yes | yes |
| Force reassign task | yes | limited |
| Approve strategy/hire requests | yes | no |
| Approve quality review (task sign-off) | yes | no |
| Report cost | yes | yes |
| Set company budget | yes | no |
| Set subordinate budget | yes | yes (manager subtree only) |

## 10. API Contract (REST)

All endpoints are under `/api` and return JSON.

## 10.1 Companies

- `GET /companies`
- `POST /companies`
- `GET /companies/:companyId`
- `PATCH /companies/:companyId`
- `POST /companies/:companyId/archive`

## 10.2 Goals

- `GET /companies/:companyId/goals`
- `POST /companies/:companyId/goals`
- `GET /goals/:goalId`
- `PATCH /goals/:goalId`
- `DELETE /goals/:goalId` (soft delete optional, hard delete board-only)

## 10.3 Agents

- `GET /companies/:companyId/agents`
- `POST /companies/:companyId/agents`
- `GET /agents/:agentId`
- `PATCH /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`
- `POST /agents/:agentId/keys` (worker registration / credential binding: worker gets a token to call API on behalf of one or more agents; no key given to the agent process)
- `POST /agents/:agentId/heartbeat/invoke` — Control plane triggers a run by sending a run request to the worker over the worker's WebSocket link (worker spawns the agent and sends status/log over the same link). The control plane does not spawn processes directly.
- `GET /agents/me/attribution` — When caller is the worker on behalf of an agent, returns that agent’s attribution (cost, activity, runs). Same response shape as `GET /agents/:id/attribution` with `id` = authenticated agent. Worker uses worker credentials plus agent context.
- `GET /agents/:agentId/attribution` — Attribution report for one agent. Query: `from`, `to` (ISO date range), `activityLimit` (default 50, max 500), `runsLimit` (default 20, max 100), `privileged=1` (board only, adds company cost comparison). Auth: worker may request on behalf of an agent it hosts; board may request any agent in an accessible company. Response: `agentId`, `companyId`, `cost` (spendCents, budgetCents, utilizationPercent, optional period), `activity` (array), `runs` (array); with `privileged=1`, `companySpendCents` and `companyBudgetCents`.

### 10.3.1 Attribution (worker or board)

Worker can call `GET /agents/me/attribution` or `GET /agents/:id/attribution` on behalf of an agent it hosts (worker credentials + agent id). Board can request any agent's attribution and use `?privileged=1` for company-level comparison.

## 10.4 Tasks (Issues)

- `GET /companies/:companyId/issues`
- `POST /companies/:companyId/issues`
- `GET /issues/:issueId`
- `GET /issues/:issueId/quality-review` — Returns the current quality_review approval for the issue (pending or approved), or null if none.
- `PATCH /issues/:issueId`
- `POST /issues/:issueId/checkout`
- `POST /issues/:issueId/release`
- `POST /issues/:issueId/comments`
- `GET /issues/:issueId/comments`
- `POST /companies/:companyId/issues/:issueId/attachments` (multipart upload)
- `GET /issues/:issueId/attachments`
- `GET /attachments/:attachmentId/content`
- `DELETE /attachments/:attachmentId`

### 10.4.1 Atomic Checkout Contract

`POST /issues/:issueId/checkout` request:

```json
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked"]
}
```

Server behavior:

1. single SQL update with `WHERE id = ? AND status IN (?) AND (assignee_agent_id IS NULL OR assignee_agent_id = :agentId)`
2. if updated row count is 0, return `409` with current owner/status
3. successful checkout sets `assignee_agent_id`, `status = in_progress`, and `started_at`

## 10.5 Projects

- `GET /companies/:companyId/projects`
- `POST /companies/:companyId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`

## 10.6 Approvals

- `GET /companies/:companyId/approvals?status=pending`
- `POST /companies/:companyId/approvals`
- `POST /approvals/:approvalId/approve`
- `POST /approvals/:approvalId/reject`

## 10.7 Cost and Budgets

- `POST /companies/:companyId/cost-events`
- `GET /companies/:companyId/costs/summary`
- `GET /companies/:companyId/costs/by-agent` — When caller is agent, response contains only that agent’s row.
- `GET /companies/:companyId/costs/by-project`
- `GET /companies/:companyId/costs/series?from=&to=&bucket=day|week` — Time-series rollups for charts (date, costCents, inputTokens, outputTokens per bucket). Max range 366 days.
- `GET /companies/:companyId/costs/by-model?from=&to=` — Cost and token breakdown by model (and provider).
- `PATCH /companies/:companyId/budgets`
- `PATCH /agents/:agentId/budgets`

## 10.8 Activity, Dashboard, Real-Time Updates, and Workload

This section covers activity log access, dashboard summary, the company-scoped real-time event stream (SSE), and the workload/capacity API for throttle signals.

- `GET /companies/:companyId/activity` — When caller is agent, response is restricted to that agent’s activity only (query `agentId` is ignored).
- `GET /companies/:companyId/dashboard`
- `GET /companies/:companyId/standup` — Standup report: per-agent buckets (completed, in progress, assigned, review, blocked), team accomplishments (done in last 24h), blockers, and overdue (stale in-progress tasks, i.e. `started_at` older than 1h; issues have no due date). Auth: same as dashboard (`assertCompanyAccess`).

### 10.8.1 Company events stream (SSE) — broad real-time updates

Hive provides **broad real-time updates** for a company via a Server-Sent Events (SSE) stream. Clients subscribe once and receive live activity, heartbeat run state changes, and agent lifecycle events for that company without polling. The worker's connection to the control plane is a **separate** WebSocket (worker link) used for run/cancel/status/log; see §11.

- `GET /companies/:companyId/events` — Server-Sent Events stream for live activity, heartbeat, and agent events for the given company. Auth at connection start only: board (session or local_trusted) or worker (Bearer token or query `?token=` for EventSource). Agents do not connect directly; the worker may subscribe for the company. Optional query `token` allows browser `EventSource(url)` to authenticate without custom headers; prefer HTTPS and short-lived tokens when using query auth. Response: `Content-Type: text/event-stream`; each event is `data: <JSON>\n\n` (initial connected payload, then `LiveEvent` objects); comment heartbeats every 30s to keep the connection alive. Use this endpoint for dashboards and UIs that need to stay in sync with activity, run status, and agent changes. WebSocket remains at `GET /api/companies/:companyId/events/ws` for existing clients. The board UI uses WebSocket by default and may fall back to SSE when WebSocket is unavailable (e.g. after repeated connection failures). An optional **Live Feed** strip in the board UI merges recent activity, run status, and agent events from this stream (and optionally hydrates from `GET /companies/:companyId/activity` on first open).

Dashboard payload must include:

- active/running/paused/error agent counts
- open/in-progress/blocked/done issue counts
- month-to-date spend and budget utilization
- pending approvals count

### 10.8.2 Workload / capacity (throttle signals)

- `GET /companies/:companyId/workload` — Returns company-scoped workload metrics and a single recommendation: `normal`, `throttle`, `shed`, or `pause`. Auth: same as dashboard (`assertCompanyAccess`); board may call any company, worker credentials only its own company. Response includes `timestamp`, `companyId`, `capacity` (active issues, active runs, error rate in window), `queue` (total pending, by status/priority, optional oldest age and estimated wait), `agents` (total, online, busy, idle, busy_ratio), `recommendation` (action, reason, details, submit_ok, suggested_delay_ms), and `thresholds` (current env-derived values). Agents and gateways should back off when `recommendation.action` is not `normal` and may honor `recommendation.suggested_delay_ms` before submitting new work. Thresholds are configured via env: `HIVE_WORKLOAD_QUEUE_DEPTH_NORMAL`, `HIVE_WORKLOAD_QUEUE_DEPTH_THROTTLE`, `HIVE_WORKLOAD_QUEUE_DEPTH_SHED`, `HIVE_WORKLOAD_BUSY_RATIO_THROTTLE`, `HIVE_WORKLOAD_BUSY_RATIO_SHED`, `HIVE_WORKLOAD_ERROR_RATE_THROTTLE`, `HIVE_WORKLOAD_ERROR_RATE_SHED`, `HIVE_WORKLOAD_RECENT_WINDOW_SECONDS`, `HIVE_WORKLOAD_ERROR_RATE_ENABLED`.

### 10.8.3 Connect (CLI / worker)

- `POST /companies/:companyId/connect` — Board registers or links a worker (or worker self-registers). Body: `toolName` (required), `toolVersion` (optional), `agentName` (required). Auth: board only; `assertCompanyAccess` + `assertBoard`. Resolves agent by company and name (idempotent by name); if missing, creates an agent with `adapterType: managed_worker` and `metadata: { toolName, toolVersion }`. Response includes worker-facing URLs (e.g. WebSocket link URL for the worker to connect, `sseUrl` for company events), `workItems: { tasks: Issue[] }`. No API key is given to the CLI/agent process; the worker holds credentials. Base URL is derived from the request (Host / X-Forwarded-*) or `HIVE_PUBLIC_URL`. The worker connects to the control plane via WebSocket and uses its credentials for run/status/log and work-items; the CLI runs under the worker.

### 10.8.4 Work-items

- `GET /agents/:agentId/work-items` — Returns tasks assigned to the agent in workable status (`todo`, `in_progress`). Auth: worker may request work-items for agents it hosts (worker credentials + agent id); board may request any agent in an accessible company. Response: `{ tasks: Issue[] }`. Used by the worker to drive the agent work loop; combine with heartbeat and WebSocket for live updates.

## 10.9 Error Semantics

- `400` validation error
- `401` unauthenticated
- `403` unauthorized
- `404` not found
- `409` state conflict (checkout conflict, invalid transition)
- `422` semantic rule violation
- `500` server error

## 11. Heartbeat and Control Plane – Worker Contract

## 11.1 Control plane – worker contract

The **only** transport between control plane and worker is a **WebSocket** connection **initiated by the worker**. The control plane does not spawn agent processes directly. It sends run and cancel as messages over that link; the worker spawns and controls agents and sends status and log stream over the same WebSocket.

- **Run:** Control plane sends a run message over the worker's WebSocket link. The run message may include an optional `model` field; the worker passes it to the agent runtime, and status reports may include the model used. Worker spawns the agent and sends status and log messages over the same link.
- **Status and logs:** Worker sends run status (running / done / failed / cancelled) and log stream over the WebSocket. No HTTP callback or polling. Payload contract in [doc/DRONE-SPEC.md](DRONE-SPEC.md) §3.

- **Cancel:** Control plane sends a cancel message over the WebSocket; the worker performs graceful termination then force kill if needed.

See [doc/MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md) for the full target architecture.

### 11.1.1 Managed worker adapter

The control plane has a single adapter type: **managed worker**. There is no registry of process/http/claude-local/codex-local/cursor/openclaw_gateway adapters. All invocation and status flows go through the worker. All communication uses a single WebSocket link (worker connects to control plane); see DRONE-SPEC and MANAGED-WORKER-ARCHITECTURE. The drone (worker) implementation contract is in [doc/DRONE-SPEC.md](DRONE-SPEC.md).

**Worker MCP and `/api/worker-api` contract matrix** (tools, transports, authz, shipped vs deferred): [DRONE-SPEC.md §7](DRONE-SPEC.md#7-tools--mcp-agents-to-control-plane-via-drone) (*Worker MCP and worker-api contract matrix*). Issue create/patch (non-status) and agent hire are on worker-api with board parity; **request_deploy** is **optional** behind `HIVE_REQUEST_DEPLOY_ENABLED` (grant-based pull; see [ADR 006](adr/006-request-deploy.md)). **Alerts:** worker-api 401/403 and indexer MCP — [docs/deploy/security-runbook.md](docs/deploy/security-runbook.md) (*Alerts: worker MCP and indexers*).

## 11.2 Context Delivery

Context is sent to the worker for a run (worker passes it to the agent as needed):

- `thin`: send IDs and pointers only; agent fetches context via API (worker mediates)
- `fat`: include current assignments, goal summary, budget snapshot, and recent comments

## 11.3 Work available

When work is available for an agent, the control plane notifies the worker via the WebSocket (e.g. run message or a dedicated work-available message). No per-agent webhook URL; the worker is the single endpoint.

## 11.4 Scheduler Rules

Per-agent schedule fields in `adapter_config` (or worker config):

- `enabled` boolean
- `intervalSec` integer (minimum 30)
- `maxConcurrentRuns` fixed at `1`

The trigger is "control plane sends run over the worker's WebSocket link". Scheduler must skip requesting a run when:

- agent is paused/terminated
- an existing run is active
- hard budget limit has been hit

## 12. Governance and Approval Flows

## 12.1 Hiring

1. Agent or board creates `approval(type=hire_agent, status=pending, payload=agent draft)`.
2. Board approves or rejects.
3. On approval, server creates agent row and initial API key (optional).
4. Decision is logged in `activity_log`.

Board can bypass request flow and create agents directly via UI; direct create is still logged as a governance action.

## 12.2 CEO Strategy Approval

1. CEO posts strategy proposal as `approval(type=approve_ceo_strategy)`.
2. Board reviews payload (plan text, initial structure, high-level tasks).
3. Approval unlocks execution state for CEO-created delegated work.

Before first strategy approval, CEO may only draft tasks, not transition them to active execution states.

## 12.3 Board Override

Board can at any time:

- pause/resume/terminate any agent
- reassign or cancel any task
- edit budgets and limits
- approve/reject/cancel pending approvals

## 13. Cost and Budget System

## 13.1 Budget Layers

- company monthly budget
- agent monthly budget
- optional project budget (if configured)

## 13.2 Enforcement Rules

- soft alert default threshold: 80%
- hard limit: at 100%, trigger:
  - set agent status to `paused`
  - block new checkout/invocation for that agent
  - emit high-priority activity event

Board may override by raising budget or explicitly resuming agent.

## 13.3 Cost Event Ingestion

`POST /companies/:companyId/cost-events` body:

```json
{
  "agentId": "uuid",
  "issueId": "uuid",
  "provider": "openai",
  "model": "gpt-5",
  "inputTokens": 1234,
  "outputTokens": 567,
  "costCents": 89,
  "occurredAt": "2026-02-17T20:25:00Z",
  "billingCode": "optional"
}
```

Validation:

- non-negative token counts
- `costCents >= 0`
- company ownership checks for all linked entities

## 13.4 Rollups

Read-time aggregate queries are acceptable for this release.
Materialized rollups can be added later if query latency exceeds targets.

## 14. UI Requirements (Board App)

UI routes:

- `/` dashboard
- `/companies` company list/create
- `/companies/:id/org` org chart and agent status
- `/companies/:id/tasks` task list/kanban
- `/companies/:id/agents/:agentId` agent detail
- `/companies/:id/costs` cost and budget dashboard
- `/companies/:id/approvals` pending/history approvals
- `/companies/:id/activity` audit/event stream

Required UX behaviors:

- global company selector
- quick actions: pause/resume agent, create task, approve/reject request
- conflict toasts on atomic checkout failure
- no silent background failures; every failed run visible in UI

## 15. Operational Requirements

## 15.1 Environment

- Node 20+
- `DATABASE_URL` optional
- if unset, auto-use PGlite and push schema

## 15.2 Migrations

- Drizzle migrations are source of truth
- no destructive migration in-place for upgrade path
- provide migration script from existing minimal tables to company-scoped schema

## 15.3 Logging and Audit

- structured logs (JSON in production)
- request ID per API call
- every mutation writes `activity_log`

## 15.4 Reliability Targets

- API p95 latency under 250 ms for standard CRUD at 1k tasks/company
- run request to worker acknowledged within 2 s
- no lost approval decisions (transactional writes)

## 16. Security Requirements

- store only hashed worker credentials
- redact secrets in logs (`adapter_config`, auth headers, env vars)
- CSRF protection for board session endpoints
- rate limit auth and key-management endpoints
- strict company boundary checks on every entity fetch/mutation

## 17. Testing Strategy

## 17.1 Unit Tests

- state transition guards (agent, issue, approval)
- budget enforcement rules
- control-plane to worker run/stop/status semantics

## 17.2 Integration Tests

- atomic checkout conflict behavior
- approval-to-agent creation flow
- cost ingestion and rollup correctness
- pause: control plane signals worker to stop run; worker performs graceful then force kill

## 17.3 End-to-End Tests

- board creates company -> hires CEO -> approves strategy -> CEO receives work
- agent reports cost -> budget threshold reached -> auto-pause occurs
- task delegation across teams with request depth increment

## 17.4 Regression Suite Minimum

A release candidate is blocked unless these pass:

1. auth boundary tests
2. checkout race test
3. hard budget stop test
4. agent pause/resume test
5. dashboard summary consistency test

## 18. Delivery Plan

## Milestone 1: Company Core and Auth

- add `companies` and company scoping to existing entities
- add board session auth and worker credentials
- migrate existing API routes to company-aware paths

## Milestone 2: Task and Governance Semantics

- implement atomic checkout endpoint
- implement issue comments and lifecycle guards
- implement approvals table and hire/strategy workflows

## Milestone 3: Heartbeat and Managed Worker

- implement managed-worker adapter and control-plane to worker contract
- persist heartbeat runs and statuses from worker reports

## Milestone 4: Cost and Budget Controls

- implement cost events ingestion
- implement monthly rollups and dashboards
- enforce hard limit auto-pause

## Milestone 5: Board UI Completion

- add company selector and org chart view
- add approvals and cost pages

## Milestone 6: Hardening and Release

- full integration/e2e suite
- seed/demo company templates for local testing
- release checklist and docs update

## 19. Acceptance Criteria (Release Gate)

Implementation is complete only when all criteria are true:

1. A board user can create multiple companies and switch between them.
2. A company can run at least one active heartbeat-enabled agent.
3. Task checkout is conflict-safe with `409` on concurrent claims.
4. Worker can update tasks/comments and report costs on behalf of agents using worker credentials; agents do not hold API keys.
5. Board can approve/reject hire and CEO strategy requests in UI.
6. Budget hard limit auto-pauses an agent and prevents new invocations.
7. Dashboard shows accurate counts/spend from live DB data.
8. Every mutation is auditable in activity log.
9. App runs with embedded PostgreSQL by default and with external Postgres via `DATABASE_URL`.

## 20. Deferred Backlog (Explicitly Deferred)

- plugin architecture
- richer workflow-state customization per team
- milestones/labels/dependency graph depth beyond minimum
- realtime transport optimization (UI: SSE/WebSocket). Worker link is already WebSocket-only.
- public template marketplace integration (ClipHub)

## 21. Company Portability Package (Addendum)

Company import/export is supported using a portable package contract:

- exactly one JSON entrypoint: `hive.manifest.json`
- all other package files are markdown with frontmatter
- agent convention:
  - `agents/<slug>/AGENTS.md` (required for export/import)
  - `agents/<slug>/HEARTBEAT.md` (optional, import accepted)
  - `agents/<slug>/*.md` (optional, import accepted)

Export/import behavior:

- export includes company metadata and/or agents based on selection
- export strips environment-specific paths (`cwd`, local instruction file paths)
- export never includes secret values; secret requirements are reported
- import supports target modes:
  - create a new company
  - import into an existing company
- import supports collision strategies: `rename`, `skip`, `replace`
- import supports preview (dry-run) before apply
