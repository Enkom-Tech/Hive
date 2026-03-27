# Changelog

## Unreleased

- **Worker API issue create - opaque idempotency:** optional header `X-Hive-Worker-Idempotency-Key` on `POST /api/worker-api/issues` (DB-backed replay of the first **201**). MCP `issue.create` optional `idempotencyKey`. Migration `0046_worker_api_idempotency`.

### Worker API — issue create/update and agent hire (MCP)

- **HTTP (worker JWT):** `POST /api/worker-api/issues`, `PATCH /api/worker-api/issues/:issueId` (no `status` in body — use existing transition route), `POST /api/worker-api/agent-hires`. Board-parity validation, activity (`worker_api.issue_create`, `worker_api.issue_update`, `worker_api.agent_hire`), and permission gates (`assign` for assignee changes, `agents:create` for hires).
- **hive-worker MCP:** `issue.create`, `issue.update`, `agent.requestHire` proxy to the same routes via `CPClient`.
- **Prometheus:** `hive_worker_api_*` route labels include `issue_create`, `issue_update`, `agent_hire`.
- **Docs:** [DRONE-SPEC.md](doc/DRONE-SPEC.md) §7 matrix; [workers.md](docs/api/workers.md).

### Drone full automation (identity catalogue + placement)

- **PostgreSQL:** `worker_identity_desired_slots`, `agents.worker_identity_slot_id`, `agents.last_automatic_placement_failure*` (migration `0041`).
- **HTTP (board):** `GET/POST/PATCH/DELETE /api/companies/:companyId/worker-identity-slots`, `GET .../worker-identity-automation/status`, `GET .../drone-auto-deploy/profile`.
- **Behavior:** Provision `hello` and periodic timer reconcile **desired-state identities** then **automatic placement** (`reconcileAutomationForCompany`). Env: **`HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED`** (default on), **`HIVE_WORKER_AUTOMATION_RECONCILE_INTERVAL_MS`** (default 5m; `0` disables timer).
- **Placement:** Automatic bind prefers **least-loaded** eligible drones; failed auto-bind sets **`last_automatic_placement_failure`** on the agent.
- **Assets:** [`infra/worker/auto-deploy/`](../infra/worker/auto-deploy/).

### Managed worker provisioning and worker API (MCP)

- **HTTP:** `GET /api/worker-downloads/provision-manifest` — operator-defined runtime manifest (`HIVE_WORKER_PROVISION_MANIFEST_JSON` / `HIVE_WORKER_PROVISION_MANIFEST_FILE`). Sensitive rate limit when API limits apply.
- **HTTP:** `GET /api/companies/:companyId/worker-runtime/manifest` — effective manifest (company `workerRuntimeManifestJson` overrides global). Auth: board, same-company agent, or unconsumed `hive_dpv_` for that company.
- **HTTP:** `POST /api/worker-api/*` — **worker-instance JWT** only (`HIVE_WORKER_JWT_SECRET`); agents no longer use API keys for these tools. **`hive-worker mcp`** stdio MCP proxies to worker-api. Removed `POST /api/worker-tools/bridge` and **`HIVE_WORKER_TOOL_BRIDGE_ALLOWED_ACTIONS`**. Activity `worker_api.*`.
- **hive-worker:** `HIVE_PROVISION_MANIFEST_BEARER`; manifest fetch sends `Authorization: Bearer` from bearer env or link credentials. Optional `HIVE_PROVISION_MANIFEST_HOOKS=1` runs `aptPackages` / `npmGlobal` / `dockerImages` from the manifest at startup (non-distroless images only). Optional **`HIVE_PROVISION_MANIFEST_PUBLIC_KEY`** enforces **`X-Hive-Manifest-Signature`** (Ed25519) on manifest HTTP responses. **Server signing:** optional **`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE`** / **`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY`** adds **`X-Hive-Manifest-Signature`** to manifest GET responses.
- **Docs:** [`infra/worker/PROVISIONER-SPLIT.md`](../infra/worker/PROVISIONER-SPLIT.md), [worker MCP guide](docs/guides/agent-developer/mcp-worker-bridge.md). **`scripts/mcp-worker-bridge.mjs`** is deprecated (use `hive-worker mcp`).

### Fleet / identity / assignment (ADR 005)

- **PostgreSQL:** `worker_instance_agents.assignment_source`, `agents.worker_placement_mode`, `agents.operational_posture` (migration `0039`).
- **Behavior:** `applyWorkerHello` no longer inserts or updates `worker_instance_agents`; bindings go through `services/worker-assignment` only.
- **Env:** `HIVE_AUTO_PLACEMENT_ENABLED` (default `false`) gates automatic binding for agents with `worker_placement_mode=automatic`.
- **Execute:** Managed-worker dispatch enforces `operational_posture` (archived/hibernate block), validates **sandbox** bindings (`labels.sandbox` on the drone), optional auto-bind before placement v1 path.
- **Heartbeat:** Queued runs are not claimed when the agent is **hibernate**, **archived** posture, or **terminated** (fail fast before claim).
- **Bind API:** Sandbox posture rejects bind to drones without `labels.sandbox: true`.
- **API:** `PATCH /api/agents/:id` accepts `workerPlacementMode`, `operationalPosture`; activity `agent.worker_execution_policy_updated` when those change. Drones overview includes placement/posture/assignment fields on board agent rows.
- **UI:** Agent configure (managed worker) — harness placement mode and operational posture selectors; Workers table **Rotate pool** for `worker_placement_mode=automatic`.
- **API:** `POST /api/companies/:companyId/agents/:agentId/worker-pool/rotate` — circular advance among eligible drones (or first automatic bind if unassigned). Activity `worker_instance.agent_pool_rotated`; metric / log `placement_mobility`.
- **Phase C — drain:** `PATCH /api/companies/:companyId/worker-instances/:workerInstanceId` updates labels, capacity hint, display label, and drain flag. Env **`HIVE_DRAIN_AUTO_EVACUATE_ENABLED`** (default `false`): when set `true`, first transition to draining runs automatic-assignment evacuation to other eligible drones. Activity `worker_instance.updated`. **UI:** Request drain / Clear drain on Workers drone rows.

### Drone-first provisioning (ADR 004)

- **PostgreSQL:** `drone_provisioning_tokens` (migration `0038_drone_provisioning_tokens`).
- **HTTP:** `POST /api/companies/:companyId/drone-provisioning-tokens` mints `hive_dpv_…` (consumed on first provision `hello`, not at WebSocket upgrade). `PUT /api/companies/:companyId/worker-instances/:workerInstanceId/agents/:agentId` and `DELETE .../worker-instances/agents/:agentId` bind/unbind `managed_worker` identities; updates in-memory worker link registry via `syncWorkerInstanceBindings` (no host SSH).
- **WebSocket:** `/api/workers/link` accepts provision tokens before agent/instance enrollment rows.
- **hive-worker:** `HIVE_DRONE_PROVISION_TOKEN` (optional; with `HIVE_CONTROL_PLANE_URL` / WS URL) for bootstrap without `HIVE_AGENT_ID`.
- **UI (Workers):** “Generate host bootstrap token”, “Attach identity” on grouped drone rows.
- **Activity:** `company.drone_provisioning_token_created`, `worker_instance.agent_bound`, `worker_instance.agent_unbound`, `worker_instance.agent_pool_rotated` (automatic pool rotate), `worker_instance.updated` (drone row patch / drain).

### Breaking / coordinated (managed worker unified dispatch — ADR 003)

- **WebSocket delivery:** Run/cancel messages are delivered on the connection registered for the target **`worker_instances` row** (internal id), not a separate per-agent socket map. **Multi-replica API:** set `HIVE_WORKER_DELIVERY_BUS_URL` to a **Redis-protocol** endpoint (managed Redis, Dragonfly, Valkey, or compatible) or runs may not reach a worker connected to another replica.
- **HTTP:** `POST /api/companies/:companyId/worker-instances/:workerInstanceId/link-enrollment-tokens` mints short-lived **instance-scoped** link enrollment (pool / shared host). Activity: `worker_instance.link_enrollment_token_created`.
- **Placement v1:** Failed dispatch when the worker is temporarily unreachable may **schedule retry** (`run_placements.next_attempt_at`, capped attempts) and **requeue** the heartbeat run instead of immediately failing.
- **Metrics:** `HIVE_METRICS_ENABLED=true` exposes **`GET /api/metrics`** (Prometheus text); protect at the network layer (no app auth on that path by default).
- **hive-worker:** `status` / `log` WebSocket payloads include **`agentId`**; optional **`HIVE_LINK_AGENT_ALLOWLIST`** rejects other agent ids on a shared instance. `hello.capabilities.pool = "v1"`.

Upgrade: apply DB migrations (including `worker_instance_link_enrollment_tokens`, `run_placements.dispatch_attempt_count` if not already present), deploy control plane + UI, then roll worker binaries that speak the updated link protocol. See `infra/worker/RELEASES.md` and `doc/adr/003-unified-managed-worker-links.md`.

### Breaking (API and database)

- **HTTP:** `GET /api/companies/:companyId/workers/overview` removed — use `GET .../drones/overview`.
- **HTTP:** `POST /api/agents/:id/worker-enrollment-tokens` removed — use `POST .../link-enrollment-tokens`.
- **JSON (drones overview):** `agents` → `boardAgents`, `unassignedAgents` → `unassignedBoardAgents`, `instances[].agents` → `instances[].boardAgents`. Nested drone rows include `labels`, `drainRequestedAt`, `capacityHint` on `worker_instances`.
- **Activity:** mint action `agent.worker_enrollment_token_created` replaced by `agent.link_enrollment_token_created`.
- **PostgreSQL:** table `worker_enrollment_tokens` renamed to `managed_worker_link_enrollment_tokens` (indexes and FK names updated). `worker_instances` gains `labels`, `drain_requested_at`, `capacity_hint`.

Upgrade: run DB migrations, then deploy API and UI together. See `doc/adr/001-drone-agent-naming.md`.

### Docs and tests (ADR 003 follow-up)

- **UI (Workers):** **Instance link token** on grouped drone rows mints instance-scoped enrollment; placement **labels** / **drain** / **capacity** shown when set on `worker_instances`. Per–identity row action **Assign to drone** (was “Enroll drone”) and copy clarify: deploy/install binary first, then link that identity to a running worker.
- **Docs / runbook:** Agent vs instance enrollment table (`doc/MANAGED-WORKER-ARCHITECTURE.md`), API `workers.md` instance mint section, managed worker pool **go-live checklist** in `docs/deploy/security-runbook.md`.
- **Env / ADR:** `HIVE_WORKER_DELIVERY_BUS_URL` documented as Redis-protocol (not a single vendor); deploy hardening (TLS, ACL, private network) in security runbook.
- **Env (breaking rename):** `HIVE_WORKER_DELIVERY_REDIS_URL` → `HIVE_WORKER_DELIVERY_BUS_URL` — neutral name for Redis/Dragonfly/Valkey; update manifests and secrets.
- **AuthZ matrix:** instance link-enrollment row + checklist; no separate pool debug route (N/A).
- **Tests:** `server/src/__tests__/worker-instance-link-enrollment.test.ts` — 403 for wrong company / agent; 201 for allowed board user.

### Tooling

- **`pnpm check:legacy-drone-api`** — scans production TypeScript (server, UI, CLI, db schema) so removed HTTP paths and renamed symbols are not reintroduced; runs in CI on control-plane PRs.

### Optional: run placement v1 (Release B)

- **PostgreSQL:** new table `run_placements` (migration `0036_run_placements`) keyed by `heartbeat_run_id`, referencing `worker_instances` when placement is recorded.
- **Env:** `HIVE_PLACEMENT_V1_ENABLED` — default `false`. When `true`, managed-worker dispatch creates a placement row (if the agent has a `worker_instance_agents` binding), refuses new runs when the instance is **draining**, skips send when the **connected** link’s hello `instanceId` disagrees with the board binding (`PLACEMENT_CONNECTION_MISMATCH`), and sends `placementId` + `expectedWorkerInstanceId` on the WebSocket `run` message.
- **WebSocket:** worker may send `{"type":"ack","status":"rejected","code":"placement_mismatch",...}`; the control plane fails the run and marks placement failed.
- **hive-worker:** compares `expectedWorkerInstanceId` to the local stable instance id; `hello` includes `capabilities.placement = "v1"`.
- **Docs:** `doc/adr/002-placement-registry-option-a.md`, `doc/plans/placement-policy-and-threat-model.md`, `doc/DRONE-SPEC.md` §11.
