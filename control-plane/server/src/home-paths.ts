import os from "node:os";
import path from "node:path";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

/** Default data dir is ~/.hive. */
export function resolveHiveHomeDir(): string {
  const envHome = process.env.HIVE_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  return path.resolve(os.homedir(), ".hive");
}

export function resolveHiveInstanceId(): string {
  const raw = process.env.HIVE_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(`Invalid HIVE_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveHiveInstanceRoot(): string {
  return path.resolve(resolveHiveHomeDir(), "instances", resolveHiveInstanceId());
}

/**
 * If `absolutePath` is under the current Hive instance root, returns a stable
 * forward-slash path relative to that root (e.g. `workspaces/<agentId>`).
 * Otherwise returns null. Use in operator-facing log lines: full paths under
 * the user profile get redacted to `C:\\Users\\[]\\...` when written to run logs.
 */
export function hiveInstanceRelativePathIfUnderRoot(absolutePath: string): string | null {
  const rootNorm = path.resolve(resolveHiveInstanceRoot());
  const normalized = path.resolve(absolutePath);
  const rel = path.relative(rootNorm, normalized);
  if (path.isAbsolute(rel)) return null;
  if (rel.startsWith(`..${path.sep}`) || rel === "..") return null;
  if (!rel || rel === "") return ".";
  return rel.split(path.sep).join("/");
}

export function resolveDefaultConfigPath(): string {
  return path.resolve(resolveHiveInstanceRoot(), "config.json");
}

export function resolveDefaultEmbeddedPostgresDir(): string {
  return path.resolve(resolveHiveInstanceRoot(), "db");
}

export function resolveDefaultLogsDir(): string {
  return path.resolve(resolveHiveInstanceRoot(), "logs");
}

export function resolveDefaultSecretsKeyFilePath(): string {
  return path.resolve(resolveHiveInstanceRoot(), "secrets", "master.key");
}

export function resolveDefaultStorageDir(): string {
  return path.resolve(resolveHiveInstanceRoot(), "data", "storage");
}

export function resolveDefaultBackupDir(): string {
  return path.resolve(resolveHiveInstanceRoot(), "data", "backups");
}

export function resolveDefaultAgentWorkspaceDir(agentId: string): string {
  const trimmed = agentId.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid agent id for workspace path '${agentId}'.`);
  }
  return path.resolve(resolveHiveInstanceRoot(), "workspaces", trimmed);
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
