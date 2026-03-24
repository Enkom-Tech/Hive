import type { Config } from "../config.js";
import { hiveEnv, setHiveEnv } from "./hive-env.js";

export async function applyServerEnvConfig(config: Config): Promise<void> {
  const { setAttachmentConfig } = await import("../attachment-types.js");
  const { setRunLogBasePath } = await import("../services/run-log-store.js");
  setAttachmentConfig({
    allowedTypesRaw: config.attachmentAllowedTypes,
    maxBytes: config.attachmentMaxBytes,
  });
  setRunLogBasePath(config.runLogBasePath);

  const { setReleaseCheckConfig } = await import("../services/release-check.js");
  setReleaseCheckConfig({
    releasesRepo: config.releasesRepo,
    updateCheckDisabled: config.updateCheckDisabled,
  });

  const { setWorkerDownloadsConfig } = await import("../services/worker-downloads.js");
  setWorkerDownloadsConfig(config);

  const { setManagedWorkerUrlAllowlist } = await import("../adapters/managed-worker/validate.js");
  setManagedWorkerUrlAllowlist(
    config.managedWorkerUrlAllowlist
      ? config.managedWorkerUrlAllowlist.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [],
  );

  if (hiveEnv("SECRETS_PROVIDER") === undefined) {
    setHiveEnv("SECRETS_PROVIDER", config.secretsProvider);
  }
  if (hiveEnv("SECRETS_STRICT_MODE") === undefined) {
    setHiveEnv("SECRETS_STRICT_MODE", config.secretsStrictMode ? "true" : "false");
  }
  if (hiveEnv("SECRETS_MASTER_KEY_FILE") === undefined) {
    setHiveEnv("SECRETS_MASTER_KEY_FILE", config.secretsMasterKeyFilePath);
  }
}

