import * as p from "@clack/prompts";
import pc from "picocolors";
import type { HiveConfig } from "../config/schema.js";
import { configExists, readConfig, resolveConfigPath } from "../config/store.js";
import {
  readAgentJwtSecretFromEnv,
  readAgentJwtSecretFromEnvFile,
  resolveAgentJwtEnvFile,
} from "../config/env.js";
import {
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHiveInstanceId,
} from "../config/home.js";

type EnvSource = "env" | "config" | "file" | "default" | "missing";

type EnvVarRow = {
  key: string;
  value: string;
  source: EnvSource;
  required: boolean;
  note: string;
};

const DEFAULT_AGENT_JWT_TTL_SECONDS = "172800";
const DEFAULT_AGENT_JWT_ISSUER = "hive";
const DEFAULT_AGENT_JWT_AUDIENCE = "hive-api";
const DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS = "30000";
const DEFAULT_SECRETS_PROVIDER = "local_encrypted";
const DEFAULT_STORAGE_PROVIDER = "local_disk";
function defaultSecretsKeyFilePath(): string {
  return resolveDefaultSecretsKeyFilePath(resolveHiveInstanceId());
}
function defaultStorageBaseDir(): string {
  return resolveDefaultStorageDir(resolveHiveInstanceId());
}

export async function envCommand(opts: { config?: string }): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" hive env ")));

  const configPath = resolveConfigPath(opts.config);
  let config: HiveConfig | null = null;
  let configReadError: string | null = null;

  if (configExists(opts.config)) {
    p.log.message(pc.dim(`Config file: ${configPath}`));
    try {
      config = readConfig(opts.config);
    } catch (err) {
      configReadError = err instanceof Error ? err.message : String(err);
      p.log.message(pc.yellow(`Could not parse config: ${configReadError}`));
    }
  } else {
    p.log.message(pc.dim(`Config file missing: ${configPath}`));
  }

  const rows = collectDeploymentEnvRows(config, configPath);
  const missingRequired = rows.filter((row) => row.required && row.source === "missing");
  const sortedRows = rows.sort((a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key));

  const requiredRows = sortedRows.filter((row) => row.required);
  const optionalRows = sortedRows.filter((row) => !row.required);

  const formatSection = (title: string, entries: EnvVarRow[]) => {
    if (entries.length === 0) return;

    p.log.message(pc.bold(title));
    for (const entry of entries) {
      const status = entry.source === "missing" ? pc.red("missing") : entry.source === "default" ? pc.yellow("default") : pc.green("set");
      const sourceNote = {
        env: "environment",
        config: "config",
        file: "file",
        default: "default",
        missing: "missing",
      }[entry.source];
      p.log.message(
        `${pc.cyan(entry.key)} ${status.padEnd(7)} ${pc.dim(`[${sourceNote}] ${entry.note}`)}${entry.source === "missing" ? "" : ` ${pc.dim("=>")} ${pc.white(quoteShellValue(entry.value))}`}`,
      );
    }
  };

  formatSection("Required environment variables", requiredRows);
  formatSection("Optional environment variables", optionalRows);

  const exportRows = rows.map((row) => (row.source === "missing" ? { ...row, value: "<set-this-value>" } : row));
  const uniqueRows = uniqueByKey(exportRows);
  const exportBlock = uniqueRows.map((row) => `export ${row.key}=${quoteShellValue(row.value)}`).join("\n");

  if (configReadError) {
    p.log.error(`Could not load config cleanly: ${configReadError}`);
  }

  p.note(
    exportBlock || "No values detected. Set required variables manually.",
    "Deployment export block",
  );

  if (missingRequired.length > 0) {
    p.log.message(
      pc.yellow(
        `Missing required values: ${missingRequired.map((row) => row.key).join(", ")}. Set these before deployment.`,
      ),
    );
  } else {
    p.log.message(pc.green("All required deployment variables are present."));
  }
  p.outro("Done");
}

function collectDeploymentEnvRows(config: HiveConfig | null, configPath: string): EnvVarRow[] {
  const agentJwtEnvFile = resolveAgentJwtEnvFile(configPath);
  const jwtEnv = readAgentJwtSecretFromEnv(configPath);
  const jwtFile = jwtEnv ? null : readAgentJwtSecretFromEnvFile(agentJwtEnvFile);
  const jwtSource = jwtEnv ? "env" : jwtFile ? "file" : "missing";

  const dbUrl = process.env.DATABASE_URL ?? config?.database?.connectionString ?? "";
  const databaseMode = config?.database?.mode ?? "embedded-postgres";
  const dbUrlSource: EnvSource = process.env.DATABASE_URL ? "env" : config?.database?.connectionString ? "config" : "missing";
  const publicUrl =
    process.env.HIVE_PUBLIC_URL ??
    process.env.HIVE_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    config?.auth?.publicBaseUrl ??
    "";
  const publicUrlSource: EnvSource =
    process.env.HIVE_PUBLIC_URL
      ? "env"
      : process.env.HIVE_AUTH_PUBLIC_BASE_URL || process.env.BETTER_AUTH_URL || process.env.BETTER_AUTH_BASE_URL
        ? "env"
        : config?.auth?.publicBaseUrl
          ? "config"
          : "missing";
  let trustedOriginsDefault = "";
  if (publicUrl) {
    try {
      trustedOriginsDefault = new URL(publicUrl).origin;
    } catch {
      trustedOriginsDefault = "";
    }
  }

  const heartbeatInterval = process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS ?? DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS;
  const heartbeatEnabled = process.env.HEARTBEAT_SCHEDULER_ENABLED ?? "true";
  const secretsProvider =
    process.env.HIVE_SECRETS_PROVIDER ??
    config?.secrets?.provider ??
    DEFAULT_SECRETS_PROVIDER;
  const secretsStrictMode =
    process.env.HIVE_SECRETS_STRICT_MODE ??
    String(config?.secrets?.strictMode ?? false);
  const secretsKeyFilePath =
    process.env.HIVE_SECRETS_MASTER_KEY_FILE ??
    config?.secrets?.localEncrypted?.keyFilePath ??
    defaultSecretsKeyFilePath();
  const vaultAddr =
    process.env.HIVE_VAULT_ADDR ??
    process.env.VAULT_ADDR ??
    config?.secrets?.vault?.addr ??
    "";
  const vaultToken = process.env.HIVE_VAULT_TOKEN ?? process.env.VAULT_TOKEN ?? "";
  const vaultNamespace =
    process.env.HIVE_VAULT_NAMESPACE ??
    process.env.VAULT_NAMESPACE ??
    config?.secrets?.vault?.namespace ??
    "";
  const vaultKvMount =
    process.env.HIVE_VAULT_KV_MOUNT ??
    config?.secrets?.vault?.kvMount ??
    "hive";
  const storageProvider =
    process.env.HIVE_STORAGE_PROVIDER ??
    config?.storage?.provider ??
    DEFAULT_STORAGE_PROVIDER;
  const storageLocalDir =
    process.env.HIVE_STORAGE_LOCAL_DIR ??
    config?.storage?.localDisk?.baseDir ??
    defaultStorageBaseDir();
  const storageS3Bucket =
    process.env.HIVE_STORAGE_S3_BUCKET ??
    config?.storage?.s3?.bucket ??
    "hive";
  const storageS3Region =
    process.env.HIVE_STORAGE_S3_REGION ??
    config?.storage?.s3?.region ??
    "us-east-1";
  const storageS3Endpoint =
    process.env.HIVE_STORAGE_S3_ENDPOINT ??
    config?.storage?.s3?.endpoint ??
    "";
  const storageS3Prefix =
    process.env.HIVE_STORAGE_S3_PREFIX ??
    config?.storage?.s3?.prefix ??
    "";
  const storageS3ForcePathStyle =
    process.env.HIVE_STORAGE_S3_FORCE_PATH_STYLE ??
    String(config?.storage?.s3?.forcePathStyle ?? false);

  const rows: EnvVarRow[] = [
    {
      key: "HIVE_AGENT_JWT_SECRET",
      value: jwtEnv ?? jwtFile ?? "",
      source: jwtSource,
      required: true,
      note:
        jwtSource === "missing"
          ? "Generate during onboard or set manually (required for local adapter authentication)"
          : jwtSource === "env"
            ? "Set in process environment"
            : `Set in ${agentJwtEnvFile}`,
    },
    {
      key: "DATABASE_URL",
      value: dbUrl,
      source: dbUrlSource,
      required: true,
      note:
        databaseMode === "postgres"
          ? "Configured for postgres mode (required)"
          : "Required for live deployment with managed PostgreSQL",
    },
    {
      key: "PORT",
      value:
        process.env.PORT ??
        (config?.server?.port !== undefined ? String(config.server.port) : "3100"),
      source: process.env.PORT ? "env" : config?.server?.port !== undefined ? "config" : "default",
      required: false,
      note: "HTTP listen port",
    },
    {
      key: "HIVE_PUBLIC_URL",
      value: publicUrl,
      source: publicUrlSource,
      required: false,
      note: "Canonical public URL for auth/callback/invite origin wiring",
    },
    {
      key: "BETTER_AUTH_TRUSTED_ORIGINS",
      value: process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? trustedOriginsDefault,
      source: process.env.BETTER_AUTH_TRUSTED_ORIGINS
        ? "env"
        : trustedOriginsDefault
          ? "default"
          : "missing",
      required: false,
      note: "Comma-separated auth origin allowlist (auto-derived from HIVE_PUBLIC_URL when possible)",
    },
    {
      key: "HIVE_AGENT_JWT_TTL_SECONDS",
      value: process.env.HIVE_AGENT_JWT_TTL_SECONDS ?? DEFAULT_AGENT_JWT_TTL_SECONDS,
      source: process.env.HIVE_AGENT_JWT_TTL_SECONDS ? "env" : "default",
      required: false,
      note: "JWT lifetime in seconds",
    },
    {
      key: "HIVE_AGENT_JWT_ISSUER",
      value: process.env.HIVE_AGENT_JWT_ISSUER ?? DEFAULT_AGENT_JWT_ISSUER,
      source: process.env.HIVE_AGENT_JWT_ISSUER ? "env" : "default",
      required: false,
      note: "JWT issuer",
    },
    {
      key: "HIVE_AGENT_JWT_AUDIENCE",
      value: process.env.HIVE_AGENT_JWT_AUDIENCE ?? DEFAULT_AGENT_JWT_AUDIENCE,
      source: process.env.HIVE_AGENT_JWT_AUDIENCE ? "env" : "default",
      required: false,
      note: "JWT audience",
    },
    {
      key: "HEARTBEAT_SCHEDULER_INTERVAL_MS",
      value: heartbeatInterval,
      source: process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS ? "env" : "default",
      required: false,
      note: "Heartbeat worker interval in ms",
    },
    {
      key: "HEARTBEAT_SCHEDULER_ENABLED",
      value: heartbeatEnabled,
      source: process.env.HEARTBEAT_SCHEDULER_ENABLED ? "env" : "default",
      required: false,
      note: "Set to `false` to disable timer scheduling",
    },
    {
      key: "HIVE_SECRETS_PROVIDER",
      value: secretsProvider,
      source: process.env.HIVE_SECRETS_PROVIDER
        ? "env"
        : config?.secrets?.provider
          ? "config"
          : "default",
      required: false,
      note: "Default provider for new secrets",
    },
    {
      key: "HIVE_SECRETS_STRICT_MODE",
      value: secretsStrictMode,
      source: process.env.HIVE_SECRETS_STRICT_MODE
        ? "env"
        : config?.secrets?.strictMode !== undefined
          ? "config"
          : "default",
      required: false,
      note: "Require secret refs for sensitive env keys",
    },
    {
      key: "HIVE_SECRETS_MASTER_KEY_FILE",
      value: secretsKeyFilePath,
      source: process.env.HIVE_SECRETS_MASTER_KEY_FILE
        ? "env"
        : config?.secrets?.localEncrypted?.keyFilePath
          ? "config"
          : "default",
      required: false,
      note: "Path to local encrypted secrets key file",
    },
    {
      key: "HIVE_VAULT_ADDR",
      value: vaultAddr,
      source: process.env.HIVE_VAULT_ADDR
        ? "env"
        : process.env.VAULT_ADDR
          ? "env"
          : config?.secrets?.vault?.addr
            ? "config"
            : "missing",
      required: secretsProvider === "vault",
      note: "Vault/OpenBao base URL (required when HIVE_SECRETS_PROVIDER=vault)",
    },
    {
      key: "HIVE_VAULT_TOKEN",
      value: vaultToken,
      source: process.env.HIVE_VAULT_TOKEN
        ? "env"
        : process.env.VAULT_TOKEN
          ? "env"
          : "missing",
      required: secretsProvider === "vault",
      note: "Vault/OpenBao token (required when HIVE_SECRETS_PROVIDER=vault)",
    },
    {
      key: "HIVE_VAULT_NAMESPACE",
      value: vaultNamespace,
      source: process.env.HIVE_VAULT_NAMESPACE
        ? "env"
        : process.env.VAULT_NAMESPACE
          ? "env"
          : config?.secrets?.vault?.namespace
            ? "config"
            : "default",
      required: false,
      note: "Vault namespace (optional)",
    },
    {
      key: "HIVE_VAULT_KV_MOUNT",
      value: vaultKvMount,
      source: process.env.HIVE_VAULT_KV_MOUNT
        ? "env"
        : config?.secrets?.vault?.kvMount
          ? "config"
          : "default",
      required: false,
      note: "Vault/OpenBao KV v2 mount path",
    },
    {
      key: "HIVE_STORAGE_PROVIDER",
      value: storageProvider,
      source: process.env.HIVE_STORAGE_PROVIDER
        ? "env"
        : config?.storage?.provider
          ? "config"
          : "default",
      required: false,
      note: "Storage provider (local_disk or s3)",
    },
    {
      key: "HIVE_STORAGE_LOCAL_DIR",
      value: storageLocalDir,
      source: process.env.HIVE_STORAGE_LOCAL_DIR
        ? "env"
        : config?.storage?.localDisk?.baseDir
          ? "config"
          : "default",
      required: false,
      note: "Local storage base directory for local_disk provider",
    },
    {
      key: "HIVE_STORAGE_S3_BUCKET",
      value: storageS3Bucket,
      source: process.env.HIVE_STORAGE_S3_BUCKET
        ? "env"
        : config?.storage?.s3?.bucket
          ? "config"
          : "default",
      required: false,
      note: "S3 bucket name for s3 provider",
    },
    {
      key: "HIVE_STORAGE_S3_REGION",
      value: storageS3Region,
      source: process.env.HIVE_STORAGE_S3_REGION
        ? "env"
        : config?.storage?.s3?.region
          ? "config"
          : "default",
      required: false,
      note: "S3 region for s3 provider",
    },
    {
      key: "HIVE_STORAGE_S3_ENDPOINT",
      value: storageS3Endpoint,
      source: process.env.HIVE_STORAGE_S3_ENDPOINT
        ? "env"
        : config?.storage?.s3?.endpoint
          ? "config"
          : "default",
      required: false,
      note: "Optional custom endpoint for S3-compatible providers",
    },
    {
      key: "HIVE_STORAGE_S3_PREFIX",
      value: storageS3Prefix,
      source: process.env.HIVE_STORAGE_S3_PREFIX
        ? "env"
        : config?.storage?.s3?.prefix
          ? "config"
          : "default",
      required: false,
      note: "Optional object key prefix",
    },
    {
      key: "HIVE_STORAGE_S3_FORCE_PATH_STYLE",
      value: storageS3ForcePathStyle,
      source: process.env.HIVE_STORAGE_S3_FORCE_PATH_STYLE
        ? "env"
        : config?.storage?.s3?.forcePathStyle !== undefined
          ? "config"
          : "default",
      required: false,
      note: "Set true for path-style access on compatible providers",
    },
  ];

  const defaultConfigPath = resolveConfigPath();
  if (process.env.HIVE_CONFIG || configPath !== defaultConfigPath) {
    rows.push({
      key: "HIVE_CONFIG",
      value: process.env.HIVE_CONFIG ?? configPath,
      source: process.env.HIVE_CONFIG ? "env" : "default",
      required: false,
      note: "Optional path override for config file",
    });
  }

  return rows;
}

function uniqueByKey(rows: EnvVarRow[]): EnvVarRow[] {
  const seen = new Set<string>();
  const result: EnvVarRow[] = [];
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    result.push(row);
  }
  return result;
}

function quoteShellValue(value: string): string {
  if (value === "") return "\"\"";
  return `'${value.replaceAll("'", "'\\''")}'`;
}
