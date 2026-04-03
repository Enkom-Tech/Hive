/**
 * Central environment variable schema and allowlist.
 * Single source of truth for known env keys; validates at server/CLI boundary.
 * In production, fail fast on unknown keys or required-but-missing (enforced by server after parse).
 */

import { z } from "zod";

export interface EnvVarDoc {
  description: string;
  default?: string;
  requiredWhen?: "authenticated" | "postgres";
}

/** Per-variable documentation for .env.example and docs. Keys must match PARSED_ENV_KEYS / PASSTHROUGH_ENV_KEYS. */
export const ENV_VAR_DOCS: Record<string, EnvVarDoc> = {
  NODE_ENV: { description: "Node environment (production enables strict env allowlist)", default: "development" },
  HOST: { description: "Server host binding", default: "127.0.0.1" },
  PORT: { description: "Server port", default: "3100" },
  DATABASE_URL: { description: "PostgreSQL connection string; omit for embedded Postgres", requiredWhen: "postgres" },
  SERVE_UI: { description: "Serve the board UI from the API server", default: "true" },
  HIVE_HOME: { description: "Base directory for all Hive data", default: "~/.hive" },
  HIVE_INSTANCE_ID: { description: "Instance identifier (for multiple local instances)", default: "default" },
  HIVE_CONFIG: { description: "Path to config file (derived from HIVE_HOME/instance if unset)" },
  HIVE_CONTEXT: { description: "Path to context file" },
  HIVE_PUBLIC_URL: { description: "Public base URL for the control plane" },
  HIVE_AUTH_PUBLIC_BASE_URL: { description: "Auth public base URL" },
  HIVE_DEPLOYMENT_MODE: { description: "Deployment mode", default: "local_trusted" },
  HIVE_DEPLOYMENT_EXPOSURE: { description: "Deployment exposure when authenticated", default: "private" },
  HIVE_RBAC_ENFORCE_FOR_LOCAL_BOARD: {
    description:
      "When true, the local_trusted synthetic board user (`local-board`) is evaluated through normal company permission grants instead of bypassing RBAC. Use in CI or integration tests only; keep false/unset for normal local dev ergonomics.",
    default: "false",
  },
  HIVE_AUTH_BASE_URL_MODE: { description: "Auth base URL mode", default: "auto" },
  HIVE_ALLOWED_HOSTNAMES: { description: "Comma-separated hostnames for private access" },
  HIVE_UI_DEV_MIDDLEWARE: { description: "Enable Vite dev middleware for UI", default: "false" },
  HIVE_AGENT_JWT_SECRET: { description: "Agent JWT signing secret", requiredWhen: "authenticated" },
  HIVE_SECRETS_MASTER_KEY: { description: "32-byte encryption key (base64/hex/raw)" },
  HIVE_SECRETS_MASTER_KEY_FILE: { description: "Path to secrets master key file" },
  HIVE_SECRETS_PROVIDER: { description: "Secrets provider", default: "local_encrypted" },
  HIVE_SECRETS_STRICT_MODE: { description: "Require secret refs for sensitive env vars", default: "false" },
  HIVE_VAULT_ADDR: { description: "Vault/OpenBao base URL (for vault provider)" },
  HIVE_VAULT_TOKEN: { description: "Vault/OpenBao token (for vault provider)" },
  HIVE_VAULT_NAMESPACE: { description: "Vault namespace (optional)" },
  HIVE_VAULT_KV_MOUNT: { description: "Vault/OpenBao KV v2 mount path", default: "hive" },
  HIVE_STORAGE_PROVIDER: { description: "Storage provider", default: "local_disk" },
  HIVE_STORAGE_LOCAL_DIR: { description: "Base dir for local disk storage" },
  HIVE_STORAGE_S3_BUCKET: { description: "S3 bucket name", default: "hive" },
  HIVE_STORAGE_S3_REGION: { description: "S3 region", default: "us-east-1" },
  HIVE_STORAGE_S3_ENDPOINT: { description: "Custom S3 endpoint" },
  HIVE_STORAGE_S3_PREFIX: { description: "S3 key prefix", default: "" },
  HIVE_STORAGE_S3_FORCE_PATH_STYLE: { description: "Use path-style S3 URLs", default: "false" },
  HIVE_DB_BACKUP_ENABLED: { description: "Enable DB backups", default: "true" },
  HIVE_DB_BACKUP_INTERVAL_MINUTES: { description: "Backup interval in minutes", default: "60" },
  HIVE_DB_BACKUP_RETENTION_DAYS: { description: "Retention days for backups", default: "30" },
  HIVE_DB_BACKUP_DIR: { description: "Backup directory (derived if unset)" },
  HIVE_ENABLE_COMPANY_DELETION: { description: "Allow company deletion (mode-dependent if unset)" },
  HEARTBEAT_SCHEDULER_ENABLED: { description: "Enable heartbeat scheduler", default: "true" },
  HEARTBEAT_SCHEDULER_INTERVAL_MS: { description: "Heartbeat interval in ms", default: "30000" },
  HIVE_CORS_ORIGINS: { description: "Comma-separated allowed CORS origins; empty means none" },
  HIVE_RATE_LIMIT_WINDOW_MS: { description: "Rate limit window in ms", default: "900000" },
  HIVE_RATE_LIMIT_MAX: {
    description: "Max general /api requests per window per IP (sensitive routes use a stricter cap)",
    default: "4000",
  },
  BETTER_AUTH_SECRET: { description: "Better Auth session secret", requiredWhen: "authenticated" },
  BETTER_AUTH_URL: { description: "Auth public base URL (legacy)" },
  BETTER_AUTH_BASE_URL: { description: "Auth public base URL (legacy)" },
  BETTER_AUTH_TRUSTED_ORIGINS: { description: "Comma-separated trusted origins for auth" },
  HIVE_LISTEN_HOST: { description: "Host the server listens on" },
  HIVE_LISTEN_PORT: { description: "Port the server listens on" },
  HIVE_API_URL: { description: "API base URL (for agents and CLI)" },
  HIVE_OPEN_ON_LISTEN: { description: "Open browser when server starts", default: "false" },
  RUN_LOG_BASE_PATH: { description: "Base path for run logs" },
  HIVE_ATTACHMENT_MAX_BYTES: { description: "Max attachment size in bytes", default: "10485760" },
  HIVE_ALLOWED_ATTACHMENT_TYPES: { description: "Comma-separated MIME patterns for attachments" },
  HIVE_BIFROST_ADMIN_BASE_URL: {
    description:
      "Bifrost HTTP base URL (e.g. http://bifrost:8080) for governance virtual-key provisioning from the board",
  },
  HIVE_BIFROST_ADMIN_TOKEN: {
    description: "Bearer token for Bifrost /api/governance/* when provisioning sk-bf-* keys from the control plane",
  },
  HIVE_JOIN_ALLOWED_ADAPTER_TYPES: { description: "Comma-separated adapter types for join" },
  HIVE_MANAGED_WORKER_URL_ALLOWLIST: { description: "Comma-separated URLs/hosts allowed for worker WebSocket link" },
  HIVE_PLACEMENT_V1_ENABLED: {
    description:
      "When true, managed-worker runs record run_placements and send placementId/expectedWorkerInstanceId to the drone (ADR 002); requires compatible hive-worker",
    default: "false",
  },
  HIVE_AUTO_PLACEMENT_ENABLED: {
    description:
      "When true, agents with worker_placement_mode=automatic may get a worker_instance_agents row picked by the control plane (ADR 005); opt-in server gate",
    default: "false",
  },
  HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED: {
    description:
      "When false, disable automatic creation of managed_worker agents from company worker-identity desired-state slots (default: enabled when unset).",
    default: "true",
  },
  HIVE_WORKER_AUTOMATION_RECONCILE_INTERVAL_MS: {
    description:
      "Background interval to reconcile worker identity slots + automatic placement for companies with active slots (ms); 0 disables periodic runs (provision-hello trigger still runs). Default 300000.",
    default: "300000",
  },
  HIVE_DRAIN_AUTO_EVACUATE_ENABLED: {
    description:
      "When true, requesting drain on a worker instance (PATCH) moves identities with automatic assignment to another eligible non-draining drone (ADR 005 Phase C); default off",
    default: "false",
  },
  HIVE_DRAIN_CANCEL_IN_FLIGHT_PLACEMENTS_ENABLED: {
    description:
      "When true (default), marking a worker instance draining cancels queued/running heartbeat runs still placed on that instance and fails placement rows (cancel+requeue policy). Set false to only block new runs.",
    default: "true",
  },
  HIVE_VCS_GITHUB_WEBHOOK_ENABLED: {
    description:
      "When true, enables POST /api/companies/:companyId/integrations/github/webhook (raw body) for merge-driven execution workspace teardown; requires HIVE_VCS_GITHUB_WEBHOOK_SECRET",
    default: "false",
  },
  HIVE_VCS_GITHUB_WEBHOOK_SECRET: {
    description: "GitHub webhook signing secret (HMAC SHA-256) shared with the GitHub App / webhook configuration",
  },
  HIVE_VCS_GITHUB_ALLOWED_REPOS: {
    description:
      "Optional comma-separated owner/repo list; pull_request events for other repositories are ignored (empty = allow all)",
  },
  HIVE_WORKER_DELIVERY_BUS_URL: {
    description:
      "URL for cross-replica managed-worker WebSocket delivery (Redis protocol: PUBLISH/SUBSCRIBE via ioredis). Use managed Redis, Dragonfly, Valkey, or other RESP-compatible service; omit for single-replica; required for HA with multiple API replicas (ADR 003).",
  },
  HIVE_METRICS_ENABLED: {
    description: "When true, expose GET /api/metrics for Prometheus (protect with network policy; not authenticated by default)",
    default: "false",
  },
  HIVE_UI_MIGRATIONS_ENABLED: {
    description:
      "When true, instance admins may run DB migrations from the board UI (POST /api/instance/migrations/apply). If unset, defaults to on in local_trusted and off in authenticated mode.",
  },
  HIVE_RELEASES_REPO: { description: "GitHub repo for update check" },
  HIVE_UPDATE_CHECK_DISABLED: { description: "Set to 1 to disable update check", default: "false" },
  HIVE_WORKER_MANIFEST_URL: {
    description:
      "HTTPS URL of hive-worker manifest JSON; if set, worker download API uses manifest-only (no GitHub API)",
  },
  HIVE_WORKER_RELEASES_REPO: {
    description: "GitHub owner/repo for worker binaries; default follows HIVE_RELEASES_REPO when unset",
  },
  HIVE_WORKER_RELEASE_TAG: {
    description: "GitHub release tag for worker assets (e.g. v0.2.7); default v + control-plane APP_VERSION",
  },
  HIVE_WORKER_ARTIFACT_BASE_URL: {
    description:
      "GitHub mode only: HTTPS prefix (no trailing slash) mirroring release filenames; download URLs point here",
  },
  HIVE_WORKER_PROVISION_MANIFEST_JSON: {
    description:
      "Optional inline JSON object for worker runtime provisioning manifest (adapterKey -> {url,sha256}) served by the control plane",
  },
  HIVE_WORKER_PROVISION_MANIFEST_FILE: {
    description:
      "Optional path to worker provisioning manifest JSON file (used when inline JSON is unset)",
  },
  HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE: {
    description:
      "Optional PEM file path for Ed25519 private key used to sign GET provision manifest JSON responses (X-Hive-Manifest-Signature header)",
  },
  HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY: {
    description:
      "Optional inline PEM or base64-encoded PEM for Ed25519 manifest signing (prefer _SIGNING_KEY_FILE in production)",
  },
  HIVE_WORKER_JWT_SECRET: {
    description:
      "HS256 secret for drone worker-instance JWT (`/api/worker-api/*`, WebSocket worker_api_token); omit to disable",
  },
  HIVE_WORKER_POLICY_SECRET: {
    description:
      "Shared symmetric secret: worker verifies HMAC on WebSocket worker_container_policy; control plane uses the same value to sign when HIVE_WORKER_CONTAINER_POLICY_ALLOWLIST_CSV is set. Must match the worker's HIVE_WORKER_POLICY_SECRET.",
  },
  HIVE_WORKER_CONTAINER_POLICY_ALLOWLIST_CSV: {
    description:
      "Comma-separated container image registry prefixes pushed to drones as signed worker_container_policy after link hello (requires HIVE_WORKER_POLICY_SECRET on control plane and worker). Example: ghcr.io/my-org/,registry.example.com/proj/",
  },
  HIVE_WORKER_CONTAINER_POLICY_VERSION: {
    description: "Policy document version string included in the HMAC payload (default 1)",
    default: "1",
  },
  HIVE_WORKER_CONTAINER_POLICY_EXPIRES_AT: {
    description:
      "Optional ISO-8601 expiry (e.g. 2099-12-31T23:59:59Z) included in signature; empty string if omitted",
  },
  HIVE_WORKSPACE_REMOTE_EXEC_GUARD: {
    description:
      "When true, heartbeat runs that use a control-plane-local git worktree (isolated execution workspace) fail fast instead of sending paths a remote drone cannot access. See docs/deploy/execution-workspace-remote-workers.md",
    default: "false",
  },
  HIVE_WORKER_JWT_TTL_SECONDS: { description: "Worker JWT TTL in seconds (default 86400)" },
  HIVE_WORKER_JWT_ISSUER: { description: "Worker JWT issuer claim" },
  HIVE_WORKER_JWT_AUDIENCE: { description: "Worker JWT audience claim" },
  HIVE_GITHUB_TOKEN: {
    description: "Optional PAT for GitHub API (worker downloads / rate limits / private repo)",
  },
  HIVE_AGENT_JWT_TTL_SECONDS: { description: "Agent JWT TTL in seconds" },
  HIVE_AGENT_JWT_ISSUER: { description: "Agent JWT issuer claim" },
  HIVE_AGENT_JWT_AUDIENCE: { description: "Agent JWT audience claim" },
  HIVE_SERVER_HOST: { description: "Server host (E2E/test)" },
  HIVE_SERVER_PORT: { description: "Server port (E2E/test)" },
  HIVE_E2E_PORT: { description: "E2E test port" },
  HIVE_E2E_SKIP_LLM: { description: "Skip LLM in E2E" },
  HIVE_E2E_MCP_MATERIALIZE_SECRET: {
    description:
      "When set in local_trusted, enables POST /api/e2e/mcp-smoke/materialize with header X-Hive-E2E-MCP-Secret (Playwright MCP smoke only; do not set in production)",
  },
  HIVE_MIGRATION_PROMPT: { description: "Prompt before applying migrations" },
  HIVE_MIGRATION_AUTO_APPLY: { description: "Auto-apply migrations" },
  HIVE_IN_WORKTREE: { description: "Running inside a worktree" },
  HIVE_AUTH_DISABLE_SIGN_UP: { description: "Disable new sign-ups", default: "false" },
  CODEX_HOME: { description: "Codex adapter home dir" },
  CLAUDE_HOME: { description: "Claude adapter home dir" },
  HIVE_LOG_DIR: { description: "Server log directory" },
  PATH: { description: "Passthrough: system PATH" },
  PWD: { description: "Passthrough: current working directory (containers/shells)" },
  HOSTNAME: { description: "Passthrough: container or host hostname" },
  NODE_VERSION: { description: "Passthrough: Node version label (official Docker images)" },
  YARN_VERSION: { description: "Passthrough: Yarn version label (official Node images)" },
  SHELL: { description: "Passthrough: shell for subprocesses" },
  ComSpec: { description: "Passthrough: Windows command interpreter" },
  PATHEXT: { description: "Passthrough: Windows executable extensions" },
  USER: { description: "Passthrough: current user" },
  LOGNAME: { description: "Passthrough: login name" },
  USERNAME: { description: "Passthrough: username" },
  HOME: { description: "Passthrough: home directory" },
  USERPROFILE: { description: "Passthrough: Windows user profile" },
  CI: { description: "Passthrough: CI environment" },
  MOLTIS_WS_URL: { description: "Passthrough: Moltis WebSocket URL" },
  MOLTIS_WS_TOKEN: { description: "Passthrough: Moltis auth token" },
  MOLTIS_WS_AUTH: { description: "Passthrough: Moltis auth" },
  ANTHROPIC_API_KEY: { description: "Passthrough: Anthropic API key for adapters" },
  OPENAI_API_KEY: { description: "Passthrough: OpenAI API key for adapters" },
  HIVE_WORKSPACE_CWD: { description: "Passthrough: workspace CWD for agents" },
  HIVE_MCP_INDEXER_HTTP_TIMEOUT_MS: {
    description: "hive-worker: HTTP timeout ms for MCP indexer gateway (default 90000, max 600000)",
  },
  HIVE_MCP_INDEXER_CB_FAILURES: {
    description: "hive-worker: consecutive failures before indexer circuit opens; 0 disables (default 5)",
  },
  HIVE_MCP_INDEXER_CB_OPEN_MS: { description: "hive-worker: indexer circuit cooldown ms (default 30000)" },
  DOCINDEX_MCP_WORKER_SAFE: {
    description: "DocIndex: when 1/true, block admin MCP tools for worker-tier URLs (shared blocklist)",
  },
  DOCINDEX_MCP_BLOCKLIST_FILE: { description: "DocIndex: path to blocklist.json override (docindex key)" },
};

/** Env keys we parse and type (server/CLI config). */
export const PARSED_ENV_KEYS = [
  "NODE_ENV",
  "HOST",
  "PORT",
  "DATABASE_URL",
  "SERVE_UI",
  "HIVE_HOME",
  "HIVE_INSTANCE_ID",
  "HIVE_CONFIG",
  "HIVE_CONTEXT",
  "HIVE_PUBLIC_URL",
  "HIVE_AUTH_PUBLIC_BASE_URL",
  "HIVE_DEPLOYMENT_MODE",
  "HIVE_DEPLOYMENT_EXPOSURE",
  "HIVE_RBAC_ENFORCE_FOR_LOCAL_BOARD",
  "HIVE_AUTH_BASE_URL_MODE",
  "HIVE_ALLOWED_HOSTNAMES",
  "HIVE_UI_DEV_MIDDLEWARE",
  "HIVE_AGENT_JWT_SECRET",
  "HIVE_SECRETS_MASTER_KEY",
  "HIVE_SECRETS_MASTER_KEY_FILE",
  "HIVE_SECRETS_PROVIDER",
  "HIVE_SECRETS_STRICT_MODE",
  "HIVE_VAULT_ADDR",
  "HIVE_VAULT_TOKEN",
  "HIVE_VAULT_NAMESPACE",
  "HIVE_VAULT_KV_MOUNT",
  "HIVE_STORAGE_PROVIDER",
  "HIVE_STORAGE_LOCAL_DIR",
  "HIVE_STORAGE_S3_BUCKET",
  "HIVE_STORAGE_S3_REGION",
  "HIVE_STORAGE_S3_ENDPOINT",
  "HIVE_STORAGE_S3_PREFIX",
  "HIVE_STORAGE_S3_FORCE_PATH_STYLE",
  "HIVE_DB_BACKUP_ENABLED",
  "HIVE_DB_BACKUP_INTERVAL_MINUTES",
  "HIVE_DB_BACKUP_RETENTION_DAYS",
  "HIVE_DB_BACKUP_DIR",
  "HIVE_ENABLE_COMPANY_DELETION",
  "HEARTBEAT_SCHEDULER_ENABLED",
  "HEARTBEAT_SCHEDULER_INTERVAL_MS",
  "HIVE_CORS_ORIGINS",
  "HIVE_RATE_LIMIT_WINDOW_MS",
  "HIVE_RATE_LIMIT_MAX",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "HIVE_LISTEN_HOST",
  "HIVE_LISTEN_PORT",
  "HIVE_API_URL",
  "HIVE_OPEN_ON_LISTEN",
  "RUN_LOG_BASE_PATH",
  "HIVE_ATTACHMENT_MAX_BYTES",
  "HIVE_ALLOWED_ATTACHMENT_TYPES",
  "HIVE_BIFROST_ADMIN_BASE_URL",
  "HIVE_BIFROST_ADMIN_TOKEN",
  "HIVE_JOIN_ALLOWED_ADAPTER_TYPES",
  "HIVE_MANAGED_WORKER_URL_ALLOWLIST",
  "HIVE_PLACEMENT_V1_ENABLED",
  "HIVE_AUTO_PLACEMENT_ENABLED",
  "HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED",
  "HIVE_WORKER_AUTOMATION_RECONCILE_INTERVAL_MS",
  "HIVE_DRAIN_AUTO_EVACUATE_ENABLED",
  "HIVE_DRAIN_CANCEL_IN_FLIGHT_PLACEMENTS_ENABLED",
  "HIVE_VCS_GITHUB_WEBHOOK_ENABLED",
  "HIVE_VCS_GITHUB_WEBHOOK_SECRET",
  "HIVE_VCS_GITHUB_ALLOWED_REPOS",
  "HIVE_WORKER_DELIVERY_BUS_URL",
  "HIVE_METRICS_ENABLED",
  "HIVE_UI_MIGRATIONS_ENABLED",
  "HIVE_RELEASES_REPO",
  "HIVE_UPDATE_CHECK_DISABLED",
  "HIVE_WORKER_MANIFEST_URL",
  "HIVE_WORKER_RELEASES_REPO",
  "HIVE_WORKER_RELEASE_TAG",
  "HIVE_WORKER_ARTIFACT_BASE_URL",
  "HIVE_WORKER_PROVISION_MANIFEST_JSON",
  "HIVE_WORKER_PROVISION_MANIFEST_FILE",
  "HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE",
  "HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY",
  "HIVE_WORKER_JWT_SECRET",
  "HIVE_WORKER_POLICY_SECRET",
  "HIVE_WORKER_CONTAINER_POLICY_ALLOWLIST_CSV",
  "HIVE_WORKER_CONTAINER_POLICY_VERSION",
  "HIVE_WORKER_CONTAINER_POLICY_EXPIRES_AT",
  "HIVE_WORKSPACE_REMOTE_EXEC_GUARD",
  "HIVE_WORKER_JWT_TTL_SECONDS",
  "HIVE_WORKER_JWT_ISSUER",
  "HIVE_WORKER_JWT_AUDIENCE",
  "HIVE_GITHUB_TOKEN",
  "HIVE_AGENT_JWT_TTL_SECONDS",
  "HIVE_AGENT_JWT_ISSUER",
  "HIVE_AGENT_JWT_AUDIENCE",
  "HIVE_SERVER_HOST",
  "HIVE_SERVER_PORT",
  "HIVE_E2E_PORT",
  "HIVE_E2E_SKIP_LLM",
  "HIVE_E2E_MCP_MATERIALIZE_SECRET",
  "HIVE_MIGRATION_PROMPT",
  "HIVE_MIGRATION_AUTO_APPLY",
  "HIVE_IN_WORKTREE",
  "HIVE_AUTH_DISABLE_SIGN_UP",
  "CODEX_HOME",
  "CLAUDE_HOME",
  "HIVE_LOG_DIR",
] as const;

/** Env keys we allow in production but do not parse (passthrough). */
export const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "PWD",
  "HOSTNAME",
  "NODE_VERSION",
  "YARN_VERSION",
  "SHELL",
  "ComSpec",
  "PATHEXT",
  "USER",
  "LOGNAME",
  "USERNAME",
  "HOME",
  "USERPROFILE",
  "CI",
  "MOLTIS_WS_URL",
  "MOLTIS_WS_TOKEN",
  "MOLTIS_WS_AUTH",
  "VAULT_ADDR",
  "VAULT_TOKEN",
  "VAULT_NAMESPACE",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "HIVE_WORKSPACE_CWD",
  "HIVE_MCP_INDEXER_HTTP_TIMEOUT_MS",
  "HIVE_MCP_INDEXER_CB_FAILURES",
  "HIVE_MCP_INDEXER_CB_OPEN_MS",
  "DOCINDEX_MCP_WORKER_SAFE",
  "DOCINDEX_MCP_BLOCKLIST_FILE",
  "HIVE_E2E_HIVE_WORKER_BINARY",
] as const;

/** All keys allowed in process.env when strictUnknown is true. */
export const KNOWN_ENV_KEYS = new Set<string>([
  ...PARSED_ENV_KEYS,
  ...PASSTHROUGH_ENV_KEYS,
]);

const optionalString = z.string().optional();

/** Schema: only parsed keys, all optional string. */
const envSchemaShape: Record<string, z.ZodOptional<z.ZodString>> = {};
for (const key of PARSED_ENV_KEYS) {
  envSchemaShape[key] = optionalString;
}

export const envSchema = z.object(envSchemaShape);

export type ParsedEnv = z.infer<typeof envSchema>;

export interface ParseEnvOptions {
  /** If true, throw when env contains a key not in KNOWN_ENV_KEYS. Use in production. */
  strictUnknown?: boolean;
}

/**
 * Parse and validate env. Returns typed record of known keys.
 * If strictUnknown is true, throws when any key in env is not in the allowlist.
 */
export function parseEnv(
  env: NodeJS.ProcessEnv,
  options: ParseEnvOptions = {},
): ParsedEnv {
  const { strictUnknown = false } = options;

  if (strictUnknown) {
    const unknown = Object.keys(env).filter((k) => !KNOWN_ENV_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown environment variable(s) (not in allowlist): ${unknown.join(", ")}. ` +
          "In production only known vars are allowed. Remove or rename them.",
      );
    }
  }

  const subset: Record<string, string | undefined> = {};
  for (const key of PARSED_ENV_KEYS) {
    const v = env[key];
    subset[key] = typeof v === "string" ? v : undefined;
  }
  return envSchema.parse(subset) as ParsedEnv;
}
