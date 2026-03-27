import { readConfigFile } from "./config-file.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { resolveHiveEnvPath } from "./paths.js";
import {
  AUTH_BASE_URL_MODES,
  AUTH_PROVIDERS,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type AuthBaseUrlMode,
  type AuthProvider,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
} from "@hive/shared";
import { getEnvConfig } from "./config/env-schema.js";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
  resolveHiveInstanceRoot,
} from "./home-paths.js";
import { loadProvisionManifestSigningKeyPemFromEnv } from "./services/worker-manifest-signature.js";

const HIVE_ENV_FILE_PATH = resolveHiveEnvPath();
if (existsSync(HIVE_ENV_FILE_PATH)) {
  loadDotenv({ path: HIVE_ENV_FILE_PATH, override: false, quiet: true });
}

type DatabaseMode = "embedded-postgres" | "postgres";

export interface Config {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  host: string;
  port: number;
  allowedHostnames: string[];
  authBaseUrlMode: AuthBaseUrlMode;
  authPublicBaseUrl: string | undefined;
  authDisableSignUp: boolean;
  databaseMode: DatabaseMode;
  databaseUrl: string | undefined;
  embeddedPostgresDataDir: string;
  embeddedPostgresPort: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
  serveUi: boolean;
  uiDevMiddleware: boolean;
  secretsProvider: SecretProvider;
  secretsStrictMode: boolean;
  secretsMasterKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  companyDeletionEnabled: boolean;
  corsAllowlist: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  runLogBasePath: string;
  attachmentAllowedTypes: string;
  attachmentMaxBytes: number;
  releasesRepo: string | undefined;
  updateCheckDisabled: boolean;
  workerManifestUrl: string | undefined;
  workerReleasesRepo: string | undefined;
  workerReleaseTag: string | undefined;
  workerArtifactBaseUrl: string | undefined;
  workerProvisionManifestJson: string | undefined;
  workerProvisionManifestFile: string | undefined;
  /** PEM Ed25519 private key for signing GET provision manifest responses (optional). */
  workerProvisionManifestSigningKeyPem: string | undefined;
  githubToken: string | undefined;
  joinAllowedAdapterTypes: string | undefined;
  managedWorkerUrlAllowlist: string | undefined;
  /** ADR 002: optional run placement v1 (default false). */
  placementV1Enabled: boolean;
  /** ADR 005: server opt-in for automatic worker_instance_agents assignment (default false). */
  autoPlacementEnabled: boolean;
  /** Create managed_worker rows from company worker-identity desired-state slots (default true; set HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED=false to disable. */
  workerIdentityAutomationEnabled: boolean;
  /** Periodic reconcile for identity slots + auto placement (ms); 0 disables (default 5 minutes). */
  workerAutomationReconcileIntervalMs: number;
  /** ADR 005 Phase C: when drain is requested via PATCH, rebind automatic assignments off that drone (default false). */
  drainAutoEvacuateEnabled: boolean;
  /** ADR 003: Redis-protocol bus URL for cross-replica worker WebSocket delivery; omit for single-replica. */
  workerDeliveryBusUrl: string | undefined;
  /** Expose GET /metrics (Prometheus); use behind firewall or disable in untrusted networks. */
  metricsEnabled: boolean;
  /**
   * HS256 secret for worker-instance JWTs (`/api/worker-api/*`, WebSocket `worker_api_token`).
   * When unset, worker JWT minting and verification are disabled.
   */
  workerJwtSecret: string | undefined;
  /**
   * When set, enables POST /api/internal/hive/inference-metering with Bearer auth for router-side ledger writes.
   */
  internalHiveOperatorSecret: string | undefined;
  /**
   * When set in local_trusted, exposes POST /api/e2e/mcp-smoke/materialize for MCP E2E smoke (non-production).
   */
  e2eMcpSmokeMaterializeSecret: string | undefined;
  /** Bifrost gateway root URL for board-driven virtual key provisioning (optional). */
  bifrostAdminBaseUrl: string | undefined;
  /** Bearer for Bifrost governance API (optional). */
  bifrostAdminToken: string | undefined;
  /** Auth secret (BETTER_AUTH_SECRET or HIVE_AGENT_JWT_SECRET); set when authenticated. */
  authSecret: string | undefined;
  /** Extra trusted origins from BETTER_AUTH_TRUSTED_ORIGINS env. */
  trustedOriginsExtra: string[];
  /** Auth provider: builtin (Better Auth + board JWT + agent keys) or logto. */
  authProvider: AuthProvider;
}

/** Read from parsed env: HIVE_* key (pass suffix, e.g. "SECRETS_STRICT_MODE"). */
function e(parsed: Record<string, string | undefined>, key: string): string | undefined {
  return parsed[`HIVE_${key}`];
}

const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export function loadConfig(): Config {
  const parsed = getEnvConfig();

  const fileConfig = readConfigFile();
  const fileDatabaseMode =
    (fileConfig?.database.mode === "postgres" ? "postgres" : "embedded-postgres") as DatabaseMode;

  const fileDbUrl =
    fileDatabaseMode === "postgres"
      ? fileConfig?.database.connectionString
      : undefined;
  const fileDatabaseBackup = fileConfig?.database.backup;
  const fileSecrets = fileConfig?.secrets;
  const fileStorage = fileConfig?.storage;
  const strictModeFromEnv = e(parsed, "SECRETS_STRICT_MODE");
  const secretsStrictMode =
    strictModeFromEnv !== undefined
      ? strictModeFromEnv === "true"
      : (fileSecrets?.strictMode ?? false);

  const providerFromEnvRaw = e(parsed, "SECRETS_PROVIDER");
  const providerFromEnv =
    providerFromEnvRaw && SECRET_PROVIDERS.includes(providerFromEnvRaw as SecretProvider)
      ? (providerFromEnvRaw as SecretProvider)
      : null;
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider = providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnvRaw = e(parsed, "STORAGE_PROVIDER");
  const storageProviderFromEnv =
    storageProviderFromEnvRaw && STORAGE_PROVIDERS.includes(storageProviderFromEnvRaw as StorageProvider)
      ? (storageProviderFromEnvRaw as StorageProvider)
      : null;
  const storageProvider: StorageProvider = storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    e(parsed, "STORAGE_LOCAL_DIR") ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const storageS3Bucket = e(parsed, "STORAGE_S3_BUCKET") ?? fileStorage?.s3?.bucket ?? "hive";
  const storageS3Region = e(parsed, "STORAGE_S3_REGION") ?? fileStorage?.s3?.region ?? "us-east-1";
  const storageS3Endpoint = e(parsed, "STORAGE_S3_ENDPOINT") ?? fileStorage?.s3?.endpoint ?? undefined;
  const storageS3Prefix = e(parsed, "STORAGE_S3_PREFIX") ?? fileStorage?.s3?.prefix ?? "";
  const storageS3ForcePathStyle =
    e(parsed, "STORAGE_S3_FORCE_PATH_STYLE") !== undefined
      ? e(parsed, "STORAGE_S3_FORCE_PATH_STYLE") === "true"
      : (fileStorage?.s3?.forcePathStyle ?? false);

  const deploymentModeFromEnvRaw = e(parsed, "DEPLOYMENT_MODE");
  const deploymentModeFromEnv =
    deploymentModeFromEnvRaw && DEPLOYMENT_MODES.includes(deploymentModeFromEnvRaw as DeploymentMode)
      ? (deploymentModeFromEnvRaw as DeploymentMode)
      : null;
  const deploymentMode: DeploymentMode = deploymentModeFromEnv ?? fileConfig?.server.deploymentMode ?? "local_trusted";

  const authProviderFromEnvRaw = e(parsed, "AUTH_PROVIDER");
  const authProviderFromEnv =
    authProviderFromEnvRaw && AUTH_PROVIDERS.includes(authProviderFromEnvRaw as AuthProvider)
      ? (authProviderFromEnvRaw as AuthProvider)
      : null;
  const authProvider: AuthProvider = authProviderFromEnv ?? fileConfig?.server.authProvider ?? "builtin";
  const deploymentExposureFromEnvRaw = e(parsed, "DEPLOYMENT_EXPOSURE");
  const deploymentExposureFromEnv =
    deploymentExposureFromEnvRaw &&
    DEPLOYMENT_EXPOSURES.includes(deploymentExposureFromEnvRaw as DeploymentExposure)
      ? (deploymentExposureFromEnvRaw as DeploymentExposure)
      : null;
  const deploymentExposure: DeploymentExposure =
    deploymentMode === "local_trusted"
      ? "private"
      : (deploymentExposureFromEnv ?? fileConfig?.server.exposure ?? "private");
  const authBaseUrlModeFromEnvRaw = e(parsed, "AUTH_BASE_URL_MODE");
  const authBaseUrlModeFromEnv =
    authBaseUrlModeFromEnvRaw &&
    AUTH_BASE_URL_MODES.includes(authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      ? (authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      : null;
  const publicUrlFromEnv = e(parsed, "PUBLIC_URL");
  const authPublicBaseUrlRaw =
    e(parsed, "AUTH_PUBLIC_BASE_URL") ??
    parsed.BETTER_AUTH_URL ??
    parsed.BETTER_AUTH_BASE_URL ??
    publicUrlFromEnv ??
    fileConfig?.auth?.publicBaseUrl;
  const authPublicBaseUrl = authPublicBaseUrlRaw?.trim() || undefined;
  const authBaseUrlMode: AuthBaseUrlMode =
    authBaseUrlModeFromEnv ??
    fileConfig?.auth?.baseUrlMode ??
    (authPublicBaseUrl ? "explicit" : "auto");
  const disableSignUpFromEnv = e(parsed, "AUTH_DISABLE_SIGN_UP");
  const authDisableSignUp: boolean =
    disableSignUpFromEnv !== undefined
      ? disableSignUpFromEnv === "true"
      : (fileConfig?.auth?.disableSignUp ?? false);
  const allowedHostnamesFromEnvRaw = e(parsed, "ALLOWED_HOSTNAMES");
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const publicUrlHostname = authPublicBaseUrl
    ? (() => {
      try {
        return new URL(authPublicBaseUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const allowedHostnames = Array.from(
    new Set(
      [
        ...(allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? []),
        ...(publicUrlHostname ? [publicUrlHostname] : []),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const companyDeletionEnvRaw = e(parsed, "ENABLE_COMPANY_DELETION");
  const companyDeletionEnabled =
    companyDeletionEnvRaw !== undefined
      ? companyDeletionEnvRaw === "true"
      : deploymentMode === "local_trusted";
  const databaseBackupEnabled =
    e(parsed, "DB_BACKUP_ENABLED") !== undefined
      ? e(parsed, "DB_BACKUP_ENABLED") === "true"
      : (fileDatabaseBackup?.enabled ?? true);
  const databaseBackupIntervalMinutes = Math.max(
    1,
    Number(e(parsed, "DB_BACKUP_INTERVAL_MINUTES")) ||
      fileDatabaseBackup?.intervalMinutes ||
      60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    Number(e(parsed, "DB_BACKUP_RETENTION_DAYS")) ||
      fileDatabaseBackup?.retentionDays ||
      30,
  );
  const databaseBackupDir = resolveHomeAwarePath(
    e(parsed, "DB_BACKUP_DIR") ??
      fileDatabaseBackup?.dir ??
      resolveDefaultBackupDir(),
  );

  const corsOriginsRaw = parsed.HIVE_CORS_ORIGINS ?? "";
  const corsAllowlist = corsOriginsRaw
    .split(",")
    .map((o: string) => o.trim())
    .filter(Boolean);
  const rateLimitWindowMs = Math.max(60000, Number(parsed.HIVE_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000);
  /** Default high enough for board UI polling when limits apply (authenticated, non-loopback bind). */
  const rateLimitMax = Math.max(1, Number(parsed.HIVE_RATE_LIMIT_MAX) || 4000);

  const runLogBasePath = parsed.RUN_LOG_BASE_PATH?.trim()
    ? resolveHomeAwarePath(parsed.RUN_LOG_BASE_PATH.trim())
    : path.resolve(resolveHiveInstanceRoot(), "data", "run-logs");
  const attachmentAllowedTypes = parsed.HIVE_ALLOWED_ATTACHMENT_TYPES?.trim() ?? "";
  const attachmentMaxBytes =
    Math.max(0, Number(parsed.HIVE_ATTACHMENT_MAX_BYTES)) || DEFAULT_ATTACHMENT_MAX_BYTES;
  const releasesRepo = parsed.HIVE_RELEASES_REPO?.trim() || undefined;
  const updateCheckDisabled = parsed.HIVE_UPDATE_CHECK_DISABLED === "1";
  const workerManifestUrl = parsed.HIVE_WORKER_MANIFEST_URL?.trim() || undefined;
  const workerReleasesRepo = parsed.HIVE_WORKER_RELEASES_REPO?.trim() || undefined;
  const workerReleaseTag = parsed.HIVE_WORKER_RELEASE_TAG?.trim() || undefined;
  const workerArtifactBaseUrl = parsed.HIVE_WORKER_ARTIFACT_BASE_URL?.trim() || undefined;
  const workerProvisionManifestJson = parsed.HIVE_WORKER_PROVISION_MANIFEST_JSON?.trim() || undefined;
  const workerProvisionManifestFile = parsed.HIVE_WORKER_PROVISION_MANIFEST_FILE?.trim() || undefined;
  const workerProvisionManifestSigningKeyPem = loadProvisionManifestSigningKeyPemFromEnv(process.env) ?? undefined;
  const githubToken = parsed.HIVE_GITHUB_TOKEN?.trim() || undefined;
  const joinAllowedAdapterTypes = parsed.HIVE_JOIN_ALLOWED_ADAPTER_TYPES?.trim() || undefined;
  const managedWorkerUrlAllowlist = parsed.HIVE_MANAGED_WORKER_URL_ALLOWLIST?.trim() || undefined;
  const placementV1Enabled = parsed.HIVE_PLACEMENT_V1_ENABLED === "true";
  const autoPlacementEnabled = parsed.HIVE_AUTO_PLACEMENT_ENABLED === "true";
  const workerIdentityAutomationEnabled = parsed.HIVE_WORKER_IDENTITY_AUTOMATION_ENABLED !== "false";
  const workerAutomationReconcileIntervalMsRaw = Number(parsed.HIVE_WORKER_AUTOMATION_RECONCILE_INTERVAL_MS);
  const workerAutomationReconcileIntervalMs = Number.isFinite(workerAutomationReconcileIntervalMsRaw)
    ? Math.max(0, workerAutomationReconcileIntervalMsRaw)
    : 300_000;
  const drainAutoEvacuateEnabled = parsed.HIVE_DRAIN_AUTO_EVACUATE_ENABLED === "true";
  const workerDeliveryBusUrl = parsed.HIVE_WORKER_DELIVERY_BUS_URL?.trim() || undefined;
  const metricsEnabled = parsed.HIVE_METRICS_ENABLED === "true";
  const workerJwtSecret = e(parsed, "WORKER_JWT_SECRET")?.trim() || undefined;
  const internalHiveOperatorSecret =
    e(parsed, "HIVE_INTERNAL_OPERATOR_SECRET")?.trim()
    || e(parsed, "INTERNAL_OPERATOR_SECRET")?.trim()
    || undefined;
  const e2eMcpSmokeMaterializeSecret = e(parsed, "E2E_MCP_MATERIALIZE_SECRET")?.trim() || undefined;
  const bifrostAdminBaseUrl = e(parsed, "BIFROST_ADMIN_BASE_URL")?.trim() || undefined;
  const bifrostAdminToken = e(parsed, "BIFROST_ADMIN_TOKEN")?.trim() || undefined;

  const config: Config = {
    deploymentMode,
    deploymentExposure,
    host: parsed.HOST ?? fileConfig?.server.host ?? "127.0.0.1",
    port: Number(parsed.PORT) || fileConfig?.server.port || 3100,
    allowedHostnames,
    authBaseUrlMode,
    authPublicBaseUrl,
    authDisableSignUp,
    databaseMode: fileDatabaseMode,
    databaseUrl: parsed.DATABASE_URL?.trim() ?? fileDbUrl,
    embeddedPostgresDataDir: resolveHomeAwarePath(
      fileConfig?.database.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
    ),
    embeddedPostgresPort: fileConfig?.database.embeddedPostgresPort ?? 54329,
    databaseBackupEnabled,
    databaseBackupIntervalMinutes,
    databaseBackupRetentionDays,
    databaseBackupDir,
    serveUi:
      parsed.SERVE_UI !== undefined
        ? parsed.SERVE_UI === "true"
        : fileConfig?.server.serveUi ?? true,
    uiDevMiddleware: e(parsed, "UI_DEV_MIDDLEWARE") === "true",
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath:
      resolveHomeAwarePath(
        e(parsed, "SECRETS_MASTER_KEY_FILE") ??
          fileSecrets?.localEncrypted.keyFilePath ??
          resolveDefaultSecretsKeyFilePath(),
      ),
    storageProvider,
    storageLocalDiskBaseDir,
    storageS3Bucket,
    storageS3Region,
    storageS3Endpoint,
    storageS3Prefix,
    storageS3ForcePathStyle,
    heartbeatSchedulerEnabled: parsed.HEARTBEAT_SCHEDULER_ENABLED !== "false",
    heartbeatSchedulerIntervalMs: Math.max(10000, Number(parsed.HEARTBEAT_SCHEDULER_INTERVAL_MS) || 30000),
    companyDeletionEnabled,
    corsAllowlist,
    rateLimitWindowMs,
    rateLimitMax,
    runLogBasePath,
    attachmentAllowedTypes,
    attachmentMaxBytes,
    releasesRepo,
    updateCheckDisabled,
    workerManifestUrl,
    workerReleasesRepo,
    workerReleaseTag,
    workerArtifactBaseUrl,
    workerProvisionManifestJson,
    workerProvisionManifestFile,
    workerProvisionManifestSigningKeyPem,
    githubToken,
    joinAllowedAdapterTypes,
    managedWorkerUrlAllowlist,
    placementV1Enabled,
    autoPlacementEnabled,
    workerIdentityAutomationEnabled,
    workerAutomationReconcileIntervalMs,
    drainAutoEvacuateEnabled,
    workerDeliveryBusUrl,
    metricsEnabled,
    workerJwtSecret,
    internalHiveOperatorSecret,
    e2eMcpSmokeMaterializeSecret,
    bifrostAdminBaseUrl,
    bifrostAdminToken,
    authSecret: undefined,
    authProvider,
    trustedOriginsExtra: (parsed.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((v: string) => v.trim())
      .filter(Boolean),
  };

  if (config.deploymentMode === "authenticated") {
    const authSecret =
      parsed.BETTER_AUTH_SECRET?.trim() ?? parsed.HIVE_AGENT_JWT_SECRET?.trim();
    if (!authSecret) {
      throw new Error(
        "authenticated mode requires BETTER_AUTH_SECRET or HIVE_AGENT_JWT_SECRET to be set. " +
          "Set one of these environment variables and restart.",
      );
    }
    config.authSecret = authSecret;
  }
  if (config.databaseMode === "postgres" && !config.databaseUrl?.trim()) {
    throw new Error(
      "database mode is postgres but DATABASE_URL is missing or empty. " +
        "Set DATABASE_URL and restart.",
    );
  }

  return config;
}
