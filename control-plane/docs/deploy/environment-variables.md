---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Hive uses for server configuration. The server validates env at startup: in production (`NODE_ENV=production`), only known variables are allowed and required vars (e.g. auth secret in authenticated mode, `DATABASE_URL` when using Postgres) must be set or the server will not start.

The single source of truth for the allowlist, parsed keys, and per-variable documentation is `packages/shared/src/env-schema.ts` (schema, `ENV_VAR_DOCS`, `PARSED_ENV_KEYS`). The server reads env only via `server/src/config/env-schema.ts` (`getEnvConfig()`), which validates with Zod. In production the server rejects any environment variable not in that allowlist and exits at startup. To regenerate `.env.example` from the schema, run from the control-plane root: `pnpm generate:env-example`.

## Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `127.0.0.1` | Server host binding |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string; required when database mode is postgres |
| `SERVE_UI` | `true` | Serve the board UI from the API server |
| `HIVE_HOME` | `~/.hive` | Base directory for all Hive data |
| `HIVE_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `HIVE_CONFIG` | (derived) | Path to config file |
| `HIVE_DEPLOYMENT_MODE` | `local_trusted` | `local_trusted` or `authenticated` |
| `HIVE_DEPLOYMENT_EXPOSURE` | `private` | `private` or `public` (when authenticated) |
| `HIVE_UI_DEV_MIDDLEWARE` | `false` | Enable Vite dev middleware for UI |
| `HEARTBEAT_SCHEDULER_ENABLED` | `true` | Enable heartbeat scheduler |
| `HEARTBEAT_SCHEDULER_INTERVAL_MS` | `30000` | Heartbeat interval in ms |

## Auth (authenticated mode)

When `HIVE_DEPLOYMENT_MODE=authenticated`, one of `BETTER_AUTH_SECRET` or `HIVE_AGENT_JWT_SECRET` is required.

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTER_AUTH_SECRET` | — | Better Auth session secret |
| `HIVE_AGENT_JWT_SECRET` | — | Agent JWT signing secret (can be same as Better Auth) |
| `HIVE_PUBLIC_URL` | — | Public base URL |
| `HIVE_AUTH_PUBLIC_BASE_URL` | — | Auth public base URL |
| `BETTER_AUTH_URL` | — | Same as above |
| `BETTER_AUTH_BASE_URL` | — | Same as above |
| `BETTER_AUTH_TRUSTED_ORIGINS` | — | Comma-separated allowed origins |
| `HIVE_AUTH_BASE_URL_MODE` | `auto` | `auto` or `explicit` |
| `HIVE_ALLOWED_HOSTNAMES` | — | Comma-separated hostnames for private access |
| `HIVE_AUTH_DISABLE_SIGN_UP` | `false` | Disable new sign-ups |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `HIVE_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `HIVE_SECRETS_MASTER_KEY_FILE` | `~/.hive/.../secrets/master.key` | Path to key file |
| `HIVE_SECRETS_PROVIDER` | `local_encrypted` | `local_encrypted` or `plain` |
| `HIVE_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `HIVE_STORAGE_PROVIDER` | `local_disk` | `local_disk` or `s3` |
| `HIVE_STORAGE_LOCAL_DIR` | (derived) | Base dir for local disk storage |
| `HIVE_STORAGE_S3_BUCKET` | `hive` | S3 bucket name |
| `HIVE_STORAGE_S3_REGION` | `us-east-1` | S3 region |
| `HIVE_STORAGE_S3_ENDPOINT` | — | Custom S3 endpoint |
| `HIVE_STORAGE_S3_PREFIX` | `` | Key prefix |
| `HIVE_STORAGE_S3_FORCE_PATH_STYLE` | `false` | Use path-style S3 URLs |

## CORS and rate limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `HIVE_CORS_ORIGINS` | — | Comma-separated allowed CORS origins; empty means none |
| `HIVE_RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window (15 min); not applied when limits are off (see security runbook) |
| `HIVE_RATE_LIMIT_MAX` | `4000` | Max general `/api` requests per window per IP; sensitive routes use a stricter cap; not applied when limits are off |

## DB backup, attachments, run logs

| Variable | Default | Description |
|----------|---------|-------------|
| `HIVE_DB_BACKUP_ENABLED` | `true` | Enable DB backups |
| `HIVE_DB_BACKUP_INTERVAL_MINUTES` | `60` | Backup interval |
| `HIVE_DB_BACKUP_RETENTION_DAYS` | `30` | Retention days |
| `HIVE_DB_BACKUP_DIR` | (derived) | Backup directory |
| `HIVE_ALLOWED_ATTACHMENT_TYPES` | (image types) | Comma-separated MIME patterns |
| `HIVE_ATTACHMENT_MAX_BYTES` | `10485760` | Max attachment size in bytes |
| `RUN_LOG_BASE_PATH` | (derived) | Base path for run logs |

## Optional / feature flags

| Variable | Default | Description |
|----------|---------|-------------|
| `HIVE_ENABLE_COMPANY_DELETION` | (mode-dependent) | Allow company deletion |
| `HIVE_RELEASES_REPO` | `Enkom-Tech/Hive` | GitHub repo for update check |
| `HIVE_UPDATE_CHECK_DISABLED` | `false` | Set to `1` to disable update check |
| `HIVE_JOIN_ALLOWED_ADAPTER_TYPES` | — | Comma-separated adapter types for join |
| `HIVE_MANAGED_WORKER_URL_ALLOWLIST` | — | Comma-separated hosts/URLs allowed for the worker WebSocket link (worker connects to control plane; used for validation if applicable) |
| `HIVE_PLACEMENT_V1_ENABLED` | `false` | When `true`, managed-worker runs use `run_placements` and send `placementId` / `expectedWorkerInstanceId` on the WebSocket run message (see `doc/adr/003-unified-managed-worker-links.md`); requires DB migration **and** a compatible `hive-worker` |
| `HIVE_AUTO_PLACEMENT_ENABLED` | `false` | When `true`, agents with `worker_placement_mode=automatic` may receive a `worker_instance_agents` row chosen by the control plane (ADR 005); requires eligible non-draining drones and compatible labels |
| `HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED` | `true` | When `false`, disables automatic creation of `managed_worker` agents from company **worker-identity** desired-state slots |
| `HIVE_WORKER_AUTOMATION_RECONCILE_INTERVAL_MS` | `300000` | Background interval to reconcile identity slots + automatic placement for companies with active slots; `0` disables the timer (provision-hello hook still reconciles) |
| `HIVE_DRAIN_AUTO_EVACUATE_ENABLED` | `false` | When `true`, marking a drone as draining (`PATCH .../worker-instances/:id` with `drainRequested: true`) moves identities with **automatic** assignment to another eligible non-draining drone when possible (ADR 005 Phase C) |
| `HIVE_WORKER_DELIVERY_BUS_URL` | — | **Redis-protocol** connection URL for cross-replica worker WebSocket delivery (pub/sub via `ioredis`). Use **Redis**, **Dragonfly**, **Valkey**, or another RESP-compatible service; prefer TLS (`rediss://`) and ACL/password in production. Omit on single-replica installs; **set for HA** when multiple API replicas run (ADR 003) |
| `HIVE_METRICS_ENABLED` | `false` | When `true`, exposes `GET /api/metrics` (Prometheus text). Restrict by network; not authenticated by default |
| `HIVE_WORKER_MANIFEST_URL` | — | HTTPS URL of hive-worker manifest JSON (see `infra/worker/RELEASES.md` in the repo); if set, `GET /api/worker-downloads` uses manifest-only (no GitHub API) |
| `HIVE_WORKER_PROVISION_MANIFEST_JSON` | — | Optional inline JSON manifest served at `GET /api/worker-downloads/provision-manifest` and used as fallback for `GET /api/companies/{id}/worker-runtime/manifest` (`adapters` plus optional `aptPackages`, `npmGlobal`, `dockerImages`) |
| `HIVE_WORKER_PROVISION_MANIFEST_FILE` | — | Optional JSON file path for worker provisioning manifest when inline JSON is unset |
| `HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE` | — | Optional PEM path for Ed25519 private key; when set, manifest GET responses include `X-Hive-Manifest-Signature` |
| `HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY` | — | Optional inline PEM or base64 PEM for Ed25519 manifest signing (prefer `_SIGNING_KEY_FILE` in production) |
| `HIVE_WORKER_JWT_SECRET` | — | HS256 secret for **worker-instance** JWT (`worker_api_token` WebSocket message, `POST /api/worker-api/*`). Omit to disable worker JWT minting and verification. Cryptographic policy note: [ADR 007](../../doc/adr/007-worker-instance-jwt-hs256.md) |
| `HIVE_WORKER_JWT_TTL_SECONDS` | `86400` | Worker JWT lifetime |
| `HIVE_WORKER_JWT_ISSUER` | `hive` | Optional issuer claim |
| `HIVE_WORKER_JWT_AUDIENCE` | `hive-worker-api` | Optional audience claim |
| `HIVE_WORKER_RELEASES_REPO` | (follows `HIVE_RELEASES_REPO`) | GitHub `owner/repo` for worker release assets when manifest URL is unset |
| `HIVE_WORKER_RELEASE_TAG` | `v` + app version | GitHub release tag for worker binaries (e.g. `v0.2.7`) |
| `HIVE_WORKER_ARTIFACT_BASE_URL` | — | GitHub mode only: HTTPS prefix (no trailing slash); download URLs in API responses use `{base}/{filename}` |
| `HIVE_GITHUB_TOKEN` | — | Optional PAT for GitHub API (rate limits / private release repo) |
| `HIVE_LOG_DIR` | (derived) | Server log directory |

## Managed worker (hive-worker / `hive worker link`)

| Variable | Description |
|----------|-------------|
| `HIVE_CONTROL_PLANE_URL` | HTTP(S) base URL of the control plane; worker derives WebSocket URL for `/api/workers/link` |
| `HIVE_AGENT_ID` | Managed worker agent UUID (required for pairing and for runs) |
| `HIVE_LINK_AGENT_ALLOWLIST` | Optional comma-separated board agent UUIDs; when set on a **shared** instance link, the worker rejects `run` messages for other agent ids (`ack` `agent_not_allowed`) |
| `HIVE_PROVISION_MANIFEST_URL` | Optional HTTPS URL for adapter runtime manifest consumed by `hive-worker` (same JSON shape as server; use board URL `/api/companies/{companyId}/worker-runtime/manifest` for per-tenant overrides) |
| `HIVE_PROVISION_MANIFEST_JSON` | Optional inline JSON manifest; takes precedence over `HIVE_PROVISION_MANIFEST_URL` |
| `HIVE_PROVISION_MANIFEST_BEARER` | Optional Bearer token sent when fetching `HIVE_PROVISION_MANIFEST_URL` (overrides automatic use of link credentials) |
| `HIVE_PROVISION_MANIFEST_PUBLIC_KEY` | When set, `hive-worker` requires a valid `X-Hive-Manifest-Signature` (Ed25519) on manifest HTTP responses before parsing (32-byte base64 key or PEM) |
| `HIVE_PROVISION_MANIFEST_HOOKS` | Set to `1` to run optional `aptPackages` / `npmGlobal` / `dockerImages` from the manifest at startup (requires those tools on `PATH`; not compatible with default distroless image) |
| `HIVE_WORKER_STATE_DIR` | Optional directory for persisted `link-token` and **`worker-jwt`** (worker API token for `hive-worker mcp`) |
| `HIVE_MCP_SERVER_COMMAND` | Optional path to `hive-worker` **inside** an agent container image; used for `.mcp.json` and `HIVE_WORKER_BINARY` when it differs from the drone host binary |
| `HIVE_MCP_CODE_URL` | Injected by the Hive operator when a ready **`HiveIndexer`** has `gatewayImage`: HTTP MCP gateway base URL ending in `/mcp`. Used by **`hive-worker mcp`** to proxy **`code.search`** / **`code.indexStats`** (never passed into agent containers by the container executor) |
| `HIVE_MCP_CODE_TOKEN` | Worker-tier gateway token (Secret `secretKeyRef`); pair with `HIVE_MCP_CODE_URL` |
| `HIVE_MCP_URL` / `HIVE_MCP_TOKEN` | Legacy alias for the code indexer gateway (same semantics as `HIVE_MCP_CODE_*` when set) |
| `HIVE_MCP_DOCS_URL` / `HIVE_MCP_DOCS_TOKEN` | Injected when a ready **`HiveDocIndexer`** has a gateway; used to proxy **`documents.search`** / **`documents.indexStats`** |
| `HIVE_MCP_INDEXER_MAX_TEXT_BYTES` | Optional cap on text returned from **`code.search`** / **`documents.search`** (after JSON parse); **0** or unset = unlimited; max **8388608** |
| `HIVE_MCP_INDEXER_HTTP_TIMEOUT_MS` | **hive-worker:** HTTP client timeout for MCP gateway round-trips (default **90000**, max **600000**) |
| `HIVE_MCP_INDEXER_CB_FAILURES` | **hive-worker:** consecutive failures before the per-gateway **circuit breaker** opens; **0** disables (default **5**) |
| `HIVE_MCP_INDEXER_CB_OPEN_MS` | **hive-worker:** cooldown while the circuit is open (default **30000**) |
| `DOCINDEX_MCP_WORKER_SAFE` | **DocIndex API:** when **1**/`true`, block admin MCP tools per shared **`blocklist.json`** `docindex` list for worker-facing URLs |
| `DOCINDEX_MCP_BLOCKLIST_FILE` | Optional override path to **`blocklist.json`** (must contain **`docindex`** array) |
| `HIVE_WASM_SKILL_TIMEOUT_MS` | Max wall time for each WASM MCP skill run (default **30000**; max **600000**). Uses wazero **CloseOnContextDone** so runaway guests are cut off |
| `HIVE_WASM_MEMORY_LIMIT_PAGES` | Wasm **memory limit pages** (64 KiB per page; default **256** ≈ 16 MiB; max **4096**) |
| `HIVE_WASM_MAX_STDOUT_BYTES` | Cap on stdout captured per skill (default **2097152**; max **16777216**) |
| `HIVE_AGENT_KEY` | Opaque secret passed as the WebSocket `token` (Bearer or query). Use a **short-lived enrollment token** from the board UI when possible, or a long-lived agent API key for automation |
| `HIVE_PAIRING` | Set to `1`/`true`/`yes`: when **no** enrollment/API token is set yet, **`hive-worker`** runs board push-pairing then starts the normal link (same process). Ignored if the `pair` subcommand is used |
| `HIVE_WORKER_ENROLLMENT_TOKEN` | Optional: read by the Hive CLI (`hive worker link`); forwarded to the worker as `HIVE_AGENT_KEY` so you do not mix enrollment secrets with long-lived keys in the same env var name |

Canonical push-pairing on the host: `./hive-worker pair` (see `infra/worker/RELEASES.md`). Pipe installers can set `HIVE_PAIRING=1`; see that doc and the board **Workers** UI.

**Pipe install (client-side, not server config):** when you run `install.sh` / `install.ps1` from the board, you can set **`HIVE_WORKER_INSTALL_DIR`** (absolute bin directory) or **`HIVE_WORKER_EXTRACT_ONLY=1`** to extract only into the current directory without PATH changes. Documented in `infra/worker/RELEASES.md`.

## Agent runtime (injected by server)

Set automatically when invoking agents; do not set manually for server config:

| Variable | Description |
|----------|-------------|
| `HIVE_AGENT_ID` | Agent's unique ID |
| `HIVE_COMPANY_ID` | Company ID |
| `HIVE_API_URL` | Hive API base URL |
| `HIVE_API_KEY` | Short-lived JWT for API auth |
| `HIVE_RUN_ID` | Current heartbeat run ID |
| `HIVE_TASK_ID` | Issue that triggered this wake |
| `HIVE_WAKE_REASON` | Wake trigger reason |
| `HIVE_APPROVAL_ID` | Resolved approval ID |
| `HIVE_APPROVAL_STATUS` | Approval decision |
| `HIVE_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM provider keys (for adapters)

Not validated by the server allowlist; set as needed for adapters:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (Codex Local adapter) |
