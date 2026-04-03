# Drone (worker) implementation spec

This spec defines the **drone** (worker): the single long-lived process per machine that receives run/stop/status from the control plane, spawns and controls agents, holds credentials, and exposes control-plane actions to agents (e.g. tools/MCP). The drone is the **harness**: all run, cancel, and status flows go through it; agent processes are always under the drone's control. The terms "worker" and "drone" are used interchangeably.

**Relationship to other docs:** [MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md) describes the target architecture; [SPEC-implementation.md](SPEC-implementation.md) defines the control-plane side (run request, worker credentials, heartbeat). This doc defines the **drone side** of that contract. [AUTOMATED-DEPLOYMENT-AND-RUN-LIFECYCLE.md](AUTOMATED-DEPLOYMENT-AND-RUN-LIFECYCLE.md) gives an end-to-end narrative of the automated process.

**Scope:** Control plane to drone (messages over WebSocket), drone to control plane (status and log stream over the same WebSocket), agent spawning and lifecycle, credentials, tools/MCP, build and deployment. Out of scope: control-plane API details (those stay in SPEC-implementation).

### Agent run flow

The drone connects to the control plane over **WebSocket** (outbound from the drone). The control plane sends run and cancel over that link. The drone creates a run, spawns the agent process with the given context, and sends status (running / done / failed / cancelled) and log stream over the same WebSocket. The control plane does not spawn agent processes directly. See [MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md) for the full architecture.

## 1. Build and deployment

### Single compiled binary

The drone is built as one executable (e.g. `hive-drone` or `hive-worker`). Current implementation: Go in `infra/worker`, built via `go build -o hive-worker ./cmd/worker`, CGO_ENABLED=0 for a static binary.

### Target platforms

- **Linux** (primary).
- **macOS** (build supported).
- **Windows** (if the implementation is ported).

Container: the Dockerfile in `infra/worker` produces a distroless image with the binary; default HTTP listen address `:8080` for health/metrics (override with `HIVE_WORKER_HTTP_ADDR`).

### Deployment

One drone process per machine. It can run in a container (e.g. Kubernetes, Docker Compose) or outside (bare metal, systemd). There is no requirement to run inside a container.

### One-liner install

A user MUST be able to install and run the drone on a machine with a single command (e.g. `curl -sSL <url> | sh` or equivalent). The one-liner MAY accept or embed a **token** (dynamic or long-lived) so that the drone is authenticated to the control plane when connecting via WebSocket. The spec SHALL define how the token is passed (env var, CLI arg, or baked into the install URL) and whether short-lived vs long-lived tokens are supported.

### Configuration

Environment-driven. Key env vars (current or to be specified):

- `HIVE_CONTROL_PLANE_URL` — base URL of the control plane; used to build the WebSocket link URL (e.g. `wss://control-plane/api/workers/link`).
- `HIVE_CONTROL_PLANE_TOKEN` or `HIVE_API_KEY` — credential for WebSocket auth (e.g. query param or first message). If empty, the drone cannot connect.
- `HIVE_TOOL_CMD` — default command to run per task when no adapter registry is used (legacy); see execution adapters.
- `HIVE_ADAPTER_DEFAULT_CMD` — default command for the adapter registry (overrides HIVE_TOOL_CMD when set).
- `HIVE_ADAPTER_<name>_CMD` — command for named adapter (e.g. HIVE_ADAPTER_claude_CMD=claude). Operator-configured allowlist only.
- `HIVE_ADAPTER_<name>_URL` — optional URL (HTTPS) to download adapter runtime; if set, drone provisions before first run (see §4).
- `HIVE_ADAPTER_<name>_SHA256` — optional hex checksum for provisioned artifact (when _URL is set).
- `HIVE_ADAPTER_<name>_CONTAINER` — optional; set to `1` or `true` to run this adapter in a container (see §5).
- `HIVE_ADAPTER_<name>_IMAGE` — container image when _CONTAINER is set (e.g. hive-agent-claude:latest).
- `HIVE_ADAPTER_<name>_AGENT` — optional; when set together with `_CMD=acpx`, the adapter uses the acpx (ACP) executor; see [ACPX-INTEGRATION.md](ACPX-INTEGRATION.md).
- `HIVE_CONTAINER_RUNTIME` — optional; container runtime binary (default `docker`; e.g. `podman`).
- `HIVE_WORKSPACE` — default workspace directory.
- `HIVE_PROVISION_CACHE_DIR` — directory for provisioned adapters (default `~/.hive-worker/cache` or `/tmp/hive-worker-cache`). Subdirectory **`skills/`** may hold **`*.wasm`** plus **`{base}.schema.json`** for MCP wasm tools loaded by **`hive-worker mcp`**.
- `HIVE_WORKER_STATE_DIR` — optional; directory for persisted **`link-token`** and **`worker-jwt`** (worker API JWT for `hive-worker mcp` and `/api/worker-api/*`).
- `HIVE_MCP_SERVER_COMMAND` — optional; when the agent runs in a container, path to the **`hive-worker`** binary **inside the container image** for `.mcp.json` and `HIVE_WORKER_BINARY` (host `os.Executable()` is wrong in that case).
- `HIVE_MCP_INDEXER_HTTP_TIMEOUT_MS` — optional; HTTP client timeout in ms for MCP gateway calls from **`hive-worker mcp`** (default **90000**, max **600000**).
- `HIVE_MCP_INDEXER_CB_FAILURES` — optional; consecutive gateway failures before a per-gateway **circuit breaker** opens (default **5**); **0** disables breaking.
- `HIVE_MCP_INDEXER_CB_OPEN_MS` — optional; cooldown in ms while the circuit stays open (default **30000**).
- `HIVE_WASM_SKILL_TIMEOUT_MS` / `HIVE_WASM_MEMORY_LIMIT_PAGES` / `HIVE_WASM_MAX_STDOUT_BYTES` — optional bounds for WASM skills under **`skills/`** (see §7 and MANAGED-WORKER-ARCHITECTURE).
- `HIVE_MODEL_GATEWAY_URL` — optional; when set, the single OpenAI-compatible base URL for LLM inference (e.g. model gateway or Bifrost). The drone passes it to the executor/context so agents use this endpoint; see [K3S-LLM-DEPLOYMENT.md](K3S-LLM-DEPLOYMENT.md). Router virtual keys and the model catalog are scoped by **deployment** (`hive_deployments`), which is separate from in-app **companies**; see [MANAGED-WORKER-ARCHITECTURE.md](MANAGED-WORKER-ARCHITECTURE.md) (*Deployment vs company*).
- `OPENAI_BASE_URL` / `OPENAI_API_KEY` — optional; common OpenAI-SDK env vars. When using **Bifrost** with mandatory governance, set `OPENAI_API_KEY` to a Bifrost virtual key (`sk-bf-…`) and base URL to the gateway `/v1` (often same value as `HIVE_MODEL_GATEWAY_URL`). **Process** executors inherit host env automatically; **container** executors receive `HIVE_MODEL_GATEWAY_URL`, `OPENAI_BASE_URL` (defaults to gateway URL when unset), `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` when those are set on the worker pod. See [ADR 006](adr/006-bifrost-model-gateway.md) and `infra/model-gateway/BIFROST-INTEGRATION.md`.
- `HIVE_WORKER_HTTP_ADDR` — optional TCP address for the drone’s local HTTP server (`GET /health`, `GET /metrics`). Default `:8080`. Examples: `127.0.0.1:9080`, `:9090`.
- `HIVE_WORKER_HTTP_PORT_AUTO` — when truthy, if the preferred address is **address already in use**, bind the same host on the next ports (up to 100 attempts). When this variable is **unset**: auto is **on** if `HIVE_WORKER_HTTP_ADDR` is unset or empty (try `:8080`, then `:8081`, …); auto is **off** if `HIVE_WORKER_HTTP_ADDR` is set to a non-empty value (strict). When `HIVE_WORKER_HTTP_PORT_AUTO` **is** set, its value overrides that default (e.g. `0` to fail fast on `:8080` even with no explicit addr).

The spec SHALL list required and optional env vars the drone MUST/SHOULD honor.

## 2. Control plane to drone (over WebSocket)

The **drone initiates** an outbound WebSocket connection to the control plane. The control plane sends commands over that link; the drone does not expose HTTP endpoints for run or cancel.

### Run

The control plane sends a **run** message over the WebSocket. Payload: at least `agentId`, `runId`, `context` (opaque to drone; passed to agent), and optional `adapterKey`. Payload MAY include **model** (or **modelId**): a string identifying the LLM model for this run (e.g. `claude-sonnet-4`, `gpt-4o`). When present, the drone passes it to the executor (e.g. env or context); the executor uses it for the run and reports it back in status. When absent, the managed-worker adapter resolves model order: **run `context.model` / `context.modelId`**, then **`adapterConfig.model` / `modelId`**, then **`runtime_config.defaultModelSlug`** on the agent row (set when promoting a model training run). Model can be set manually (user/operator) or autonomously (e.g. by deploying agent or policy); run payload or context carries it. The `context` object may include **hiveWorkspace** (e.g. `cwd`, `worktreePath`, `branchName`, `strategy`) set by the control plane when it realizes an execution workspace (e.g. git worktree); this is for the **agent's use** (e.g. in prompts or tooling). The run message does **not** currently include a dedicated **workspaceDir** or **workspacePath** field that the **drone** uses to set the agent process's working directory; the drone uses the `HIVE_WORKSPACE` env var or default `/workspace/repo` for the execution cwd. Optional future extension: the run payload may include `workspaceDir` or `workspacePath` so the drone can set the agent's cwd when the workspace is available on the drone (e.g. shared storage or drone-side realization). Optional `adapterKey` selects which allowlisted executor to use (e.g. `claude`, `codex`); if absent or unknown, the default executor is used. The drone responds with an acceptance (e.g. `{"type":"ack","status":"accepted"}`) and then spawns the agent; the drone sends status and log messages over the same WebSocket as the run progresses.

### Cancel

The control plane sends a **cancel** message over the WebSocket with `runId`. The drone terminates the agent process gracefully, then force-kill after a grace period if needed, and sends a final status message (cancelled).

## 3. Drone to control plane (over same WebSocket)

The drone sends run status and log stream over the **same WebSocket** connection so that heartbeat runs and the UI stay correct.

### 3.1 Hello (identity and grouping)

Immediately after a successful WebSocket upgrade, the drone SHOULD send a single JSON message:

- `type`: `"hello"`
- `hostname`: string (optional)
- `os`: string (optional, e.g. `GOOS`)
- `arch`: string (optional, e.g. `GOARCH`)
- `version`: string (optional, binary / module version)
- `instanceId`: string (optional, **stable UUID** per host; persisted locally so reconnects group under the same **worker instance** on the board)

The control plane MAY persist this on the agent row and upsert **`worker_instances`** when `instanceId` is a valid UUID. Per [ADR 005](adr/005-fleet-identity-assignment.md), `hello` does **not** write **`worker_instance_agents`**; assignment is explicit through the worker-assignment service or placement policy. Operators MAY run **one process with several outbound links** (one WebSocket per board agent / `managed_worker` identity) via `HIVE_WORKER_LINKS_JSON` on `hive-worker`; all links from the same host should share the same **`instanceId`** file (see `HIVE_WORKER_STATE_DIR` / default config dir).

### Status messages

The drone sends **status** messages with at least: `runId`, `status` (running | done | failed | cancelled), and optionally `exitCode`, `signal`, `error`. Final messages MAY include **`usage`** (`inputTokens`, `outputTokens`, `cachedInputTokens`), **`costUsd`**, **`provider`**, and **`model`** for ledger ingestion (see heartbeat cost application). Tools may write **`.hive-run-usage.json`** in the run workspace; the worker merges it into the terminal status when present. Align with what the control plane expects (see SPEC-implementation and heartbeat run schema). Sent on run start (running), on run end (done/failed/cancelled).

### Log messages

The drone sends **log** messages for live output: `runId`, `stream` (stdout | stderr), `chunk` (string), `ts` (ISO timestamp). The control plane may forward these to the UI for live run output.

Auth for the WebSocket connection uses the drone's credential (e.g. `HIVE_CONTROL_PLANE_TOKEN` or `HIVE_API_KEY`) at connect time (e.g. query param or first message).

## 4. Agent provisioning (download and setup)

A fully automated process to deploy and manage agents on one or more images SHALL include automated environment setup. Without it, operators must manually install runtimes or configure URLs per adapter; full automation is not achieved. Therefore the system SHALL provide a **provisioner** (or equivalent) that: discovers what to install (manifest or control-plane API), fetches from allowed sources with verification, and sets up the environment so the drone can run agents without manual pre-install. This may be a **separate component** (init container, sidecar, or one-shot service) that runs before or alongside the drone and writes to a shared cache or install root; the drone then only runs what that component prepared. The drone MAY retain limited built-in provisioning (single URL per adapter, binary/archive only) for backward compatibility, but full automation requires the provisioner (or equivalent) to be implemented and specified (manifest schema, API shape, per-company/per-deployment flexibility).

### Provisioner contract

When a separate provisioner (or equivalent) is used for full automation, the following contract applies. Implementers use this to build the component that runs before or alongside the drone.

- **Inputs:** Manifest (URL or path) and/or control-plane API endpoints: **`GET /api/worker-downloads/provision-manifest`** (instance-global) and **`GET /api/companies/{companyId}/worker-runtime/manifest`** (company override + same global fallback). Set `HIVE_PROVISION_MANIFEST_URL` on the worker to one of these HTTPS URLs. Optional `Authorization: Bearer` is sent using `HIVE_PROVISION_MANIFEST_BEARER` or the same secrets as the WebSocket link (agent key, control plane token, persisted `link-token`, or unconsumed `hive_dpv_` token for company-scoped URLs).
- **Manifest JSON (v1):** Top-level `version` (string, default `v1`), `adapters` (object: each value has required `url` (HTTPS) and optional `sha256`). Optional **`aptPackages`** (Debian package names), **`npmGlobal`** (npm `install -g` specs), **`dockerImages`** (`docker pull` refs). Hook lists are enforced server-side when stored on a company; the worker runs hooks only if **`HIVE_PROVISION_MANIFEST_HOOKS=1`** at startup (needs shell tools on the image — not the default distroless image).
- **Outputs:** Writes to a shared directory (install root or cache) that the drone reads via `HIVE_PROVISION_CACHE_DIR` or equivalent. Layout: one dir per adapter key; executable or entry point on PATH or at known path. When sandboxing uses container-based isolation, provisioner may pre-pull allowlisted sandbox images so the drone can start them without pulling at run time.
- **When it runs:** At least one of: (a) once at deploy (init container or one-shot job before drone starts), (b) on a schedule, (c) on manifest/API change (webhook or poll). Drone does not drive installs; it may signal "adapter X not found" (e.g. status or control-plane callback) so operator or automation can trigger provisioner; explicit drone–provisioner API is optional.
- **Security:** Provisioner fetches only from allowlisted URLs or control-plane API; verifies checksums when present; does not execute run payload or context. When enabled, the control plane may attach **`X-Hive-Manifest-Signature`** (Ed25519 over the response body); **hive-worker** verifies with **`HIVE_PROVISION_MANIFEST_PUBLIC_KEY`** before trusting manifest JSON from HTTPS (fail closed when the key is set).
- **Identity catalogue (control plane):** Board APIs under **`/api/companies/{companyId}/worker-identity-*`** maintain desired counts of `managed_worker` agents; the server reconciles after provision **`hello`** and on a timer (**`HIVE_WORKER_AUTOMATION_RECONCILE_INTERVAL_MS`**) when **`HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED`** is not `false`. Automatic binding still requires **`HIVE_AUTO_PLACEMENT_ENABLED`**. Operator env contract: **`GET .../drone-auto-deploy/profile`**.

The drone SHALL **download** agents and any other required runtimes or assets, and **set them up** before running them. Sources MAY include: (a) the Hive control plane (e.g. agent definitions or bundles provided by the company), and/or (b) official or canonical repos (e.g. upstream agent CLIs, runtimes).

The spec SHALL define:

- How the drone discovers what to install (from run request, from control plane config, or from a manifest).
- Where it fetches from (Hive API, HTTPS URLs, versioned releases).
- How it sets up the environment (install dir, PATH, optional venv or isolated env).

This ensures a user can bring up a machine and run the one-liner without pre-installing agent tooling; the drone provisions everything needed.

### Intent vs current implementation

- **Spec intent:** Discovery (manifest or control plane), fetch (allowlisted sources, checksums), setup (install root, PATH). A provisioner SHALL be implemented for full automation.
- **Current implementation:** Lazy download per adapter from `HIVE_ADAPTER_<key>_URL` and/or from **`HIVE_PROVISION_MANIFEST_JSON` / `HIVE_PROVISION_MANIFEST_URL`** (merged adapter entries). Checksums optional. Optional **manifest hooks** (`aptPackages`, `npmGlobal`, `dockerImages`) run at worker startup when `HIVE_PROVISION_MANIFEST_HOOKS=1`. Default drone image is **distroless** (no `apt`/`npm`/`docker`); use a derived image or an init container for hook-based setup.

### Who provides runtimes

Agent runtimes can be made available in three ways:

1. **Pre-installed:** The execution environment (host, image, or sidecar) already has the runtime (e.g. acpx, codex) on PATH or at a known path. Operator sets `HIVE_ADAPTER_<key>_CMD` to that command. The drone does not install; it only runs.
2. **Drone provisioning (current):** When `HIVE_ADAPTER_<key>_URL` is set, or an adapter entry exists in the provision manifest, the drone downloads that HTTPS artifact on first use, caches it under `HIVE_PROVISION_CACHE_DIR`, and runs from cache (binary or tar.gz/zip). Optional manifest hooks (apt/npm/docker pull) run at startup when explicitly enabled and the image provides those tools.
3. **Separate provisioner (required for full automation):** A separate component (e.g. init container or setup service) performs discovery, fetch, and setup (including npm or scripts); the drone then only runs what that component prepared. Full deploy-and-manage automation requires this (or equivalent) to be implemented; see "Intent vs current implementation" above.

### Flexibility per task / agent / company

- **Selection:** Adapter selection is **per run** (and thus per task and per agent): the control plane sends `adapterKey` with each run; agents can have different adapter config (e.g. agent A uses `codex_acp`, agent B uses `claude_acp`). Which runtime is *used* is flexible per task/agent.
- **Availability:** What runtimes are *available* on a worker is determined by that worker's environment (what is pre-installed or provisioned for the adapter keys that worker is allowed to run). A future manifest or control-plane API may be per company or per deployment so different deployments can have different allowlists.
- **Security:** Only allowlisted adapter keys and sources (from operator config or future manifest/API); the run payload selects among them and does not define new installs. See [SPEC-implementation.md](SPEC-implementation.md) for control-plane adapter key and agent config.

Current implementation: lazy provisioning per adapter. When `HIVE_ADAPTER_<key>_URL` is set (HTTPS only), the drone downloads on first run for that key, optionally verifies `HIVE_ADAPTER_<key>_SHA256`, extracts to `HIVE_PROVISION_CACHE_DIR` (or default `~/.hive-worker/cache`), and runs from the cached path. Supports single binary or tar.gz/zip archives.

## 5. Agent lifecycle (spawning and control)

The drone is the harness: it is the only process that connects to the control plane and that spawns or terminates agent processes; agents do not connect to the control plane.

### Spawning

The drone runs the agent process (e.g. CLI or script), using the provisioned agent runtime. It MUST pass at least: agent identity (agentId), run identity (runId), and context (opaque blob). Current implementation: env `HIVE_AGENT_ID`, `HIVE_RUN_ID`, `HIVE_CONTEXT_JSON` (base64-encoded context); when the run message includes **`modelId`** (or legacy **`model`**), also **`HIVE_MODEL_ID`** and **`HIVE_MODEL`**; command from `HIVE_TOOL_CMD` or executor config; workspace from `HIVE_WORKSPACE` or default.

### Execution adapters (optional)

The drone MAY support multiple execution adapters so different agents or runs use different CLIs or scripts (e.g. `claude`, `codex`). Selection is via the optional run-request field `adapterKey`. Command and executable are always from an **operator-configured registry/allowlist**, never from the control plane or from context. Env vars: `HIVE_ADAPTER_DEFAULT_CMD` or `HIVE_TOOL_CMD` for the default executor; `HIVE_ADAPTER_<name>_CMD` for named adapters (e.g. `HIVE_ADAPTER_claude_CMD=claude`). Empty or unknown `adapterKey` uses the default. Current implementation: registry from env; run payload may include `adapterKey`.

**ACP (acpx) adapters:** When `HIVE_ADAPTER_<key>_CMD=acpx` and `HIVE_ADAPTER_<key>_AGENT` is set (e.g. `codex`, `claude`), the drone uses the acpx executor for that key. For such runs, the run `context` MUST include a string field `prompt` or `instruction` (the acpx prompt). See [ACPX-INTEGRATION.md](ACPX-INTEGRATION.md) for the full contract and security rules.

### Identity and permissions

The drone sets agent identity per run so the control plane can attribute work and apply permissions. Agents do not receive API keys; the drone holds credentials and calls the control plane on behalf of agents (see Tools/MCP).

### Parallel runs

The spec MUST allow multiple concurrent runs (multiple agents) on the same drone. Current implementation: single run at a time (busy lock). Parallel runs are a requirement; current code is single-run only.

### Workspace / tree per run

For parallel work on the same project, each run MAY get a distinct workspace (e.g. worktree or directory) so agents do not conflict. The control plane may put execution-workspace intent (and realized path) in **context.hiveWorkspace**; the drone does **not** set process cwd from that today. Per-run workspace on the drone (so the agent runs in the intended path) would require either a run-payload workspace path field and drone support, or drone-side realization of the workspace from context. The drone MAY receive workspace path or tree id per run request when such a field is defined, or derive it from context.

### Per-run container or sandbox (optional)

**Target behavior (autosandbox):** Isolation is intended to be **policy-driven** and **default-on**: runs use a sandbox/container unless policy explicitly allows unsandboxed. Policy layers: global (operator), per-company, per-agent, optionally per-task. The **control plane** decides per run whether to sandbox and (optionally) which image; the **drone** enforces and MAY only use **allowlisted** images (from operator config or a manifest), never from run payload or context. Workspace and mounts are controlled by the control plane or drone configuration, not by the run payload. Optional future: manifest or API for allowlisted sandbox images and lazy pull/provision.

The drone MAY run each agent in a **container** (e.g. Docker, Podman, or a micro VM) or equivalent **sandbox** so that the agent process has access only to an explicitly mounted workspace (and any other allowed mounts). When used, this provides OS-level isolation: the agent cannot see or modify the rest of the host. When not used, the agent runs as a normal process on the host (current behavior). The spec does not require container isolation; it is an optional implementation choice per deployment or per run (e.g. configurable via run request or drone config). When container isolation is used, only the workspace directory (and any explicitly configured mounts) SHALL be visible to the agent process.

Current implementation: optional per-adapter. Set `HIVE_ADAPTER_<key>_CONTAINER=1` and `HIVE_ADAPTER_<key>_IMAGE=<image>` to run that adapter in a container. The drone invokes the container runtime (`docker` or `HIVE_CONTAINER_RUNTIME`) with `--rm`, `-v <workspace>:/workspace`, `-w /workspace`, and HIVE_* env vars; image and command come from operator config only. There is no per-run image policy from the control plane; operators SHOULD set **`HIVE_CONTAINER_IMAGE_ALLOWLIST`** to comma-separated registry/path prefixes and **`HIVE_CONTAINER_IMAGE_ENFORCE=true`** in production when the container adapter is enabled (see `internal/executor/container_allowlist.go`). **`deploy_grant`** pulls use the same allowlist/enforce rules before `docker pull`.

### Stop / cancel

On **cancel** message from the control plane (over the WebSocket), the drone MUST terminate the agent process (graceful then force-kill after a grace period). Grace period / force-kill can be a follow-up.

## 6. Credentials

The drone holds credentials used to call the control plane API (work-items, heartbeat status, cost events, etc.). Agents never receive or see these credentials. The drone MUST have at least one credential (e.g. API key or token) for the control plane and MUST use it when making outbound requests on behalf of agents. How the credential is obtained (registration flow, env var, file) is summarized in SPEC-implementation (worker registration / credential binding).

## 7. Tools / MCP (agents to control plane via drone)

Agents do not call the control plane directly. The drone SHALL expose a way for agents to request control-plane actions (e.g. create task, update task, report cost, request deploy of another agent). At a high level: the drone SHALL expose tools or an MCP server (or equivalent) that agents can invoke; those tools translate into authenticated calls to the control plane API. Current implementation: **`hive-worker mcp`** (stdio JSON-RPC) proxies to **`POST/GET /api/worker-api/*`** using a **worker-instance JWT** received as WebSocket message **`worker_api_token`** and persisted as **`worker-jwt`**; optional **WASM** skills under **`HIVE_PROVISION_CACHE_DIR/skills/`** (`*.wasm` + sibling **`*.schema.json`**). The same stdio server **forwards** code/document **search** tools to the tenant **HTTP MCP gateway** using **`HIVE_MCP_CODE_URL` / `HIVE_MCP_CODE_TOKEN`** and **`HIVE_MCP_DOCS_URL` / `HIVE_MCP_DOCS_TOKEN`** (worker pod env only; legacy **`HIVE_MCP_URL` / `HIVE_MCP_TOKEN`** alias the code gateway). Tool names exposed to agents include **`code.search`**, **`code.indexStats`**, **`documents.search`**, **`documents.indexStats`** when configured. Executor writes **`.mcp.json`** and sets **`HIVE_WORKER_BINARY`**, **`HIVE_MCP_CMD`**, **`HIVE_WORKER_STATE_DIR`** for the agent process. Control plane requires **`HIVE_WORKER_JWT_SECRET`** to mint worker JWTs.

### Shipped MCP tools (`hive-worker mcp`)

| MCP tool | Backend |
|----------|---------|
| `cost.report` | `POST /api/worker-api/cost-report` |
| `issue.appendComment` | `POST /api/worker-api/issues/:issueId/comments` |
| `issue.transitionStatus` | `POST /api/worker-api/issues/:issueId/transition` |
| `issue.get` | `GET /api/worker-api/issues/:issueId` |
| `issue.create` | `POST /api/worker-api/issues` |
| `issue.update` | `PATCH /api/worker-api/issues/:issueId` (no `status`; use `issue.transitionStatus`) |
| `agent.requestHire` | `POST /api/worker-api/agent-hires` |
| `code.search` | Worker → HTTP MCP gateway → indexer `search_code` (when `HIVE_MCP_CODE_*` set) |
| `code.indexStats` | Gateway → `get_index_stats` |
| `documents.search` | Gateway → `search_documents` (when `HIVE_MCP_DOCS_*` set) |
| `documents.indexStats` | Gateway → `get_index_stats` |
| WASM tools | `HIVE_PROVISION_CACHE_DIR/skills/*.wasm` (operator-controlled; see worker env limits) |

Mutations on checked-out **`in_progress`** issues require **`X-Hive-Run-Id`** (worker sets from `HIVE_RUN_ID`). Exact HTTP rules: [`../docs/api/workers.md`](../docs/api/workers.md) and [`SPEC-implementation.md`](SPEC-implementation.md) §10.

**RAG / indexing** stays in **CocoIndex** and **DocIndex** only; the worker forwards search/stats calls and never re-implements indexing.

### Worker MCP and worker-api contract matrix

Authoritative list for security review and PR gates: any new tool or HTTP action MUST add a row here in the same change.

| Name | Transport | Authentication | Authorization | Data sensitivity | Status | Activity log (mutations) |
|------|-----------|----------------|---------------|-------------------|--------|---------------------------|
| `POST /api/worker-api/cost-report` | HTTPS to control plane | Worker-instance JWT (`Authorization: Bearer`) | JWT `company_id`; body `agentId` must be active agent in company | Cost, model, provider | shipped | `worker_api.cost_report` |
| `POST /api/worker-api/issues/:id/comments` | HTTPS | Worker JWT | Same + issue in company; assignee/checkout rules; `X-Hive-Run-Id` when required | Issue text, comments | shipped | `worker_api.issue_append_comment` |
| `POST /api/worker-api/issues/:id/transition` | HTTPS | Worker JWT | Same + assignee must be `agentId` | Issue status | shipped | `worker_api.issue_transition_status` |
| `GET /api/worker-api/issues/:id` | HTTPS | Worker JWT | Same + issue in company | Issue metadata | shipped | `worker_api.issue_get` |
| `POST /api/worker-api/issues` | HTTPS | Worker JWT | Same + board parity (`createIssue` rules, assignee gates, department constraints, intent folding) | Issue + intent | shipped | `worker_api.issue_create` (+ intent activity) |
| `PATCH /api/worker-api/issues/:id` | HTTPS | Worker JWT | Same + mutable-field allowlist (no `status`); `X-Hive-Run-Id` when editing checked-out `in_progress` assignee self | Issue fields | shipped | `worker_api.issue_update` |
| `POST /api/worker-api/agent-hires` | HTTPS | Worker JWT | `agents:create` permission on acting agent; adapter validation; company approval policy for new agents | New agent / approval | shipped | `worker_api.agent_hire` |
| `GET /api/worker-api/plugin-tools` | HTTPS | Worker JWT | Same; query `agentId` must be active in company | Plugin manifest tool names (`plugin:<packageKey>:<tool>`), no secrets | shipped | — |
| `cost.report` (MCP) | stdio → above HTTP | JWT via drone (`CPClient`) | Injected `agentId` on worker | Same as cost-report | shipped | (via HTTP) |
| `issue.appendComment` | stdio → HTTP | JWT | Same | Same | shipped | (via HTTP) |
| `issue.transitionStatus` | stdio → HTTP | JWT | Same | Same | shipped | (via HTTP) |
| `issue.get` | stdio → HTTP | JWT | Same | Same | shipped | (via HTTP) |
| `issue.create` | stdio → HTTP | JWT | Same as `POST …/issues` | Same | shipped | (via HTTP) |
| `issue.update` | stdio → HTTP | JWT | Same as `PATCH …/issues/:id` | Same | shipped | (via HTTP) |
| `agent.requestHire` | stdio → HTTP | JWT | Same as `POST …/agent-hires` | Same | shipped | (via HTTP) |
| `code.search` / `code.indexStats` | stdio → tenant HTTP MCP gateway | Gateway bearer (pod env; not agent env) | Gateway blocklist; tenant indexer ACL | Source code, embeddings metadata | shipped (when `HIVE_MCP_CODE_*` set) | — |
| `documents.search` / `documents.indexStats` | stdio → gateway | Gateway bearer | Same | Document text | shipped (when `HIVE_MCP_DOCS_*` set) | — |
| WASM tools (`skills/*.wasm`) | stdio in-process | None (local module) | Operator-only filesystem trust | Tool-defined | shipped (optional) | — |

### Worker-api authorization matrix (`worker_instance` JWT)

Security-review addendum for **who** may trigger **which** HTTP action when using a valid worker-instance JWT (`kind: worker_instance`, company-scoped). The **`agentId`** in the body or query names the **acting** board agent; it must be **active** in the JWT’s company (not `terminated` or `pending_approval`). There is no separate MCP-tool RBAC table — rules are per route in [`worker-api.ts`](../server/src/routes/worker-api.ts).

| Action | Acting agent requirements | Extra gates | Abuse / mitigation |
|--------|---------------------------|-------------|-------------------|
| `POST …/cost-report` | In company, active | — | Cost spam → budgets + sensitive rate limits |
| `POST …/issues` | In company, active | Optional **`X-Hive-Worker-Idempotency-Key`** (replay without duplicate side effects) | Mass create → intent folding + rate limits |
| `PATCH …/issues/:id` | In company, active | Assignee/department rules; **`X-Hive-Run-Id`** when mutating own checked-out **`in_progress`** issue | Cross-issue edits blocked by company + assignee checks |
| `POST …/issues/:id/comments` | In company, active | Checkout / assignee rules; **`X-Hive-Run-Id`** when required | Same as board comment path |
| `POST …/issues/:id/transition` | **Assignee** must be `agentId` | Checkout rules for `in_progress` | Status churn → board semantics + rate limits |
| `GET …/issues/:id` | In company, active | Issue must be in company | Read metadata only |
| `POST …/agent-hires` | In company, active | **`agents:create`** permission (or legacy CEO / `permissions.canCreateAgents`) | Hire spam → approval policy + sensitive limits |

**Stdio concurrency:** `hive-worker mcp` uses a **bounded worker pool** for JSON-RPC handling. Default **`HIVE_MCP_MAX_CONCURRENT=1`** (sequential): a long `code.search` blocks other tools until it returns. When set to **N > 1** (max 64), up to **N** `tools/call` / other methods may run concurrently; **stdout lines may arrive out of order**, but each response includes the correct JSON-RPC **`id`**. **WASM** `skills/*.wasm` tools remain **serialized** (one at a time) when N > 1. Do not assume tool **completion order** matches request order unless N=1.

### Deferred MCP-shaped capabilities (still not on `/api/worker-api`)

**Shipped (board parity):** Issue **create** (`POST /api/worker-api/issues`, MCP `issue.create`), issue **patch** excluding **status** (`PATCH /api/worker-api/issues/:id`, MCP `issue.update`; status stays on `POST …/transition`), and **agent hire** (`POST /api/worker-api/agent-hires`, MCP `agent.requestHire`) via the same services and Zod shapes as the board — activity log, sensitive rate limits, and permission checks (`assign` / `agents:create` where applicable). **Create idempotency:** the same **intent folding** canonical key as the board still applies. **POST /api/worker-api/issues** also accepts optional **X-Hive-Worker-Idempotency-Key** (printable ASCII, max 128 chars; hive-worker MCP: issue.create idempotencyKey). The first successful **201** response for a given (company, agent, route, key) is stored and replayed on retries without duplicating activity, webhooks, or heartbeats.

**request_deploy (optional, feature-flagged):** When enabled on control plane (`HIVE_REQUEST_DEPLOY_ENABLED`) and worker (`HIVE_REQUEST_DEPLOY_ENABLED`), board-approved **deploy grants** (digest-pinned image, allowlisted registry) may be delivered over the WebSocket link; the worker verifies the grant before pull. See [threat-model-request-deploy.md](plans/threat-model-request-deploy.md) and [ADR 006](../adr/006-request-deploy.md).

Product shorthand: **request_deploy** covers automated pull/verify of another agent image from the worker surface **only** with a server-minted grant — not ad-hoc registry access.

## 8. Token efficiency and agent-facing format

### Minimal interface design

All agent-facing interfaces (MCP tool responses, CLI stdout that the model sees) SHALL be designed so token cost stays low: short tool schemas (names, params, descriptions), small result payloads (e.g. id + status or a one-line message), and terse CLI output (e.g. one line or `--format` with few fields). Neither MCP nor CLI is inherently cheaper; minimal responses and small context are what save tokens.

### TOON for agents

Structured data returned to agents (e.g. MCP tool results, or CLI output that is machine-readable for the model) SHALL use **TOON (Token-Oriented Object Notation)** where applicable. TOON is a compact, LLM-oriented format that typically yields 30–60% token savings vs JSON while remaining lossless and round-trippable. See [toonformat.dev](https://toonformat.dev) and the [TOON spec](https://toonformat.dev/reference/spec.html). Use TOON for agent-facing structured payloads so token use stays low; use JSON or other formats only where TOON is not suitable (e.g. legacy or external APIs). The spec requires minimal, TOON-encoded responses for agent-facing data.

## 9. Health and observability

- **Health:** The drone SHOULD expose a health endpoint (e.g. `GET /health`) for load balancers and orchestration. Current: health handler exists in `infra/worker`. This is for local process health only; the **control-plane link** is WebSocket, not an inbound run API.
- **Metrics:** Optional; e.g. `GET /metrics` in Prometheus format. Current: **`hive_tasks_*`**, **`hive_errors_*`**, plus **`hive_mcp_indexer_*`** (gateway call counts, duration sum/count, circuit-open gauge) and **`hive_wasm_skill_*`** counters.
- **MCP / indexer logs:** `hive-worker mcp` logs each JSON-RPC method and **`tools/call`** duration to stderr (`hive-mcp:` prefix); WASM skills and indexer gateway calls log separately (`hive-mcp wasm:`, `hive-mcp indexer:`). The HTTP MCP gateway (`mcp-gateway-go`) logs forward latency and indexer HTTP status.

## 10. Current implementation vs spec (gaps)

| Area | Implemented | Gaps / follow-ups |
|------|-------------|-------------------|
| **Transport** | **Outbound WebSocket** from `infra/worker/internal/link` to `/api/workers/link`; `run`, `cancel`, `status`, `log`, `ack`, `hello`, `link_token`, `worker_api_token`. | None for primary path; legacy HTTP adapters outside this link are operator-specific. |
| Run | WebSocket message `run` (agentId, runId, context, optional adapterKey, optional modelId); drone acks then spawns | — |
| Concurrency | Parallel runs accepted | — |
| Executor | One command with HIVE_AGENT_ID, HIVE_RUN_ID, HIVE_CONTEXT_JSON; workspace from `HIVE_WORKSPACE` and/or `context.hiveWorkspace` (`cwd` / `worktreePath` under workspace root) | — |
| Execution adapters | Registry from env; optional container adapter; **`EnforceContainerImagePolicy`** before `docker run` and before **`deploy_grant`** pull | Optional **`HIVE_CONTAINER_IMAGE_ENFORCE=true`** + allowlist for production; manifest-driven policy still future |
| Status/log | WebSocket messages `status`, `log` with **agentId** on pool hosts | — |
| Stop/cancel | WebSocket `cancel` → run context cancelled | **Unix:** when `HIVE_CANCEL_GRACE_SECONDS` is set, **SIGTERM** to the child process group, wait grace, then **SIGKILL** ([`grace_unix.go`](../../infra/worker/internal/executor/grace_unix.go)). **Windows:** child is created with **`CREATE_NEW_PROCESS_GROUP`**; cancel sends **`CTRL_BREAK_EVENT`** to that group (best-effort for console processes), waits grace, then **`TerminateProcess`** via `Kill()` ([`grace_windows.go`](../../infra/worker/internal/executor/grace_windows.go)). No-attach / GUI-only tools may ignore the break; prefer Linux drones for strict parity. |
| Install | `infra/worker/scripts/install-hive-worker.sh` (checksum verify, optional token) | Hardening per release process |
| Provisioning | Lazy per-adapter URLs; company manifest | Richer policy-driven provisioner (optional) |
| Tools/MCP | worker-api + MCP as in §7 | **`request_deploy`** behind `HIVE_REQUEST_DEPLOY_ENABLED` (grant flow); optional **cosign** after pull via `HIVE_DEPLOY_GRANT_COSIGN_PUBLIC_KEY_PATH` |
| Policy push | Drone **accepts and verifies** signed WebSocket **`worker_container_policy`** (`version`, `allowlistCsv`, `expiresAt`, HMAC `signature`) when `HIVE_WORKER_POLICY_SECRET` is set ([`link.go`](../../infra/worker/internal/link/link.go), [`policyoverlay`](../../infra/worker/internal/policyoverlay)). | Control plane **auto-sends** the frame after **`worker_api_token`** when **`HIVE_WORKER_POLICY_SECRET`** and **`HIVE_WORKER_CONTAINER_POLICY_ALLOWLIST_CSV`** are set on the API (same secret as the worker). Optional env: version / expiry. Operators may still inject updates via automation on the link. See [`docs/deploy/worker-container-policy-ws.md`](../docs/deploy/worker-container-policy-ws.md). |
| Workspace | Shared root + `hiveWorkspace` cwd/`worktreePath` resolved under workspace root (`workspaceDirFromContext` in `link.go`); optional **`.hive/runs/<id>`** + defer cleanup when `HIVE_PER_RUN_WORKSPACE=1`; optional **`hiveWorkspaceMaterialize`** JSON (`repoUrl`, `ref`, `branchName`) when `HIVE_WORKSPACE_MATERIALIZE_ENABLED=1` runs `git clone` under `hive-materialize/`; optional **`hiveWorkspaceArtifact`** (`url`, `sha256`) when `HIVE_WORKSPACE_ARTIFACT_FETCH_ENABLED=1` | Cross-host paths when worktree exists only on control-plane host unless materialize/artifact path used (see ADR 007, `issue-worktree-support.md`) |
| Per-run container/sandbox | Docker/container adapter with allowlist check before run | Autosandbox default-on (§5 target) still future |
| WebSocket auth | Token / API key at connect | — |
| Agent-facing format | JSON default | **TOON** when env `HIVE_AGENT_PAYLOAD_FORMAT=toon`, header `X-Hive-Agent-Payload-Format: toon`, or `Accept: application/x-hive-toon` (`worker-api-payload.ts`) |
| Binary / image | Go binary; Docker image | — |
| Health / metrics | GET /health, GET /metrics | — |

## 11. Placement v1 and unified dispatch (optional — feature-flagged)

**Registry (ADR 003):** The control plane keeps **one** WebSocket registry keyed by internal `worker_instances.id`. **Agent-scoped** link enrollment (per board `managed_worker`) and **instance-scoped** enrollment (per `worker_instances` row) both converge on that key after `hello`. Multi-replica API deployments should set **`HIVE_WORKER_DELIVERY_BUS_URL`** so a run published on one replica can reach the socket on another (see `doc/adr/003-unified-managed-worker-links.md`).

**Control plane (`HIVE_PLACEMENT_V1_ENABLED=true`):** When the agent is bound to a `worker_instances` row (`worker_instance_agents`) and the instance is not draining, each managed-worker run creates a `run_placements` row and the run WebSocket message includes:

- `placementId` — uuid string (primary key of `run_placements`).
- `expectedWorkerInstanceId` — **stable** instance uuid from `hello` / local hive-worker state file (same string as `instanceId` in `hello`).

If placement v1 is off, or there is no binding yet, those fields are omitted (legacy dispatch).

**Drone → control plane ack:** If `expectedWorkerInstanceId` is present and non-empty, the drone compares it to its local persisted instance id. On mismatch (or empty local id), it sends **before** starting the run:

`{"type":"ack","runId":"<runId>","agentId":"<boardAgentId>","status":"rejected","code":"placement_mismatch"}`

The control plane fails the heartbeat run and marks the placement row failed.

**Pool / multi-agent host:** The run message always includes `agentId` (board agent). On a shared instance connection, the worker SHOULD send **`agentId` on every `status` and `log` message** so the control plane routes telemetry correctly. Optional defense-in-depth: set **`HIVE_LINK_AGENT_ALLOWLIST`** (comma-separated agent ids) so the process rejects runs for ids not in the list (ack with `"code":"agent_not_allowed"`).

**Hello capabilities:** The worker sends `capabilities: { "placement": "v1", "pool": "v1" }` so servers can require compatible workers. Older workers ignore unknown `hello` fields.

**Not automated in v1:** Silent in-flight migration of a running process between hosts. Policy: cancel + requeue only until an explicit migration policy exists — see `doc/plans/placement-in-flight-migration-policy.md` and `doc/plans/placement-policy-and-threat-model.md`. Historical Option A registry note: `doc/adr/002-placement-registry-option-a.md`.

## 12. Cross-references

- **AUTOMATED-DEPLOYMENT-AND-RUN-LIFECYCLE.md** — End-to-end automated process (deploy, provision, run, sandbox, workspace, model, subagents).
- **SPEC-implementation.md** — Control-plane side of the contract (section 11); worker registration, heartbeat, work-items.
- **MANAGED-WORKER-ARCHITECTURE.md** — Target architecture (one worker per machine, single adapter, agents via worker).
- **ACPX-INTEGRATION.md** — acpx (ACP) executor: adapter keys, context prompt contract, security.
- **doc/plans/workspace-strategy-and-git-worktrees.md** — Execution workspace and worktree strategy: control plane realization, context.hiveWorkspace, drone gap (workspace path not in run payload today).
- **infra/worker** — Current Go implementation of the drone (partial relative to this spec).
