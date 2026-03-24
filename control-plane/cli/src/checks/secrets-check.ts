import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HiveConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }

  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

function withStrictModeNote(
  base: Pick<CheckResult, "name" | "status" | "message" | "canRepair" | "repair" | "repairHint">,
  config: HiveConfig,
): CheckResult {
  const strictModeDisabledInDeployedSetup =
    config.database.mode === "postgres" && config.secrets.strictMode === false;
  if (!strictModeDisabledInDeployedSetup) return base;

  if (base.status === "fail") return base;
  return {
    ...base,
    status: "warn",
    message: `${base.message}; strict secret mode is disabled for postgres deployment`,
    repairHint: base.repairHint
      ? `${base.repairHint}. Consider enabling secrets.strictMode`
      : "Consider enabling secrets.strictMode",
  };
}

export function secretsCheck(config: HiveConfig, configPath?: string): CheckResult {
  const provider = config.secrets.provider;
  if (provider === "vault") {
    const addr =
      process.env.HIVE_VAULT_ADDR ??
      process.env.VAULT_ADDR ??
      config.secrets.vault?.addr ??
      "";
    const token = process.env.HIVE_VAULT_TOKEN ?? process.env.VAULT_TOKEN ?? "";
    const mount = process.env.HIVE_VAULT_KV_MOUNT ?? config.secrets.vault?.kvMount ?? "hive";
    if (!addr.trim()) {
      return {
        name: "Secrets adapter",
        status: "fail",
        message: "Vault provider requires HIVE_VAULT_ADDR (or VAULT_ADDR)",
        canRepair: false,
        repairHint: "Set HIVE_VAULT_ADDR in your environment or config.secrets.vault.addr",
      };
    }
    if (!token.trim()) {
      return {
        name: "Secrets adapter",
        status: "fail",
        message: "Vault provider requires HIVE_VAULT_TOKEN (or VAULT_TOKEN)",
        canRepair: false,
        repairHint: "Set HIVE_VAULT_TOKEN in your environment",
      };
    }
    if (!mount.trim()) {
      return {
        name: "Secrets adapter",
        status: "fail",
        message: "Vault provider requires a non-empty KV mount path",
        canRepair: false,
        repairHint: "Set HIVE_VAULT_KV_MOUNT or config.secrets.vault.kvMount",
      };
    }
    return withStrictModeNote(
      {
        name: "Secrets adapter",
        status: "pass",
        message: "Vault/OpenBao provider configured",
      },
      config,
    );
  }

  if (provider === "aws_secrets_manager") {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "";
    if (!region.trim()) {
      return {
        name: "Secrets adapter",
        status: "warn",
        message: "AWS Secrets Manager provider configured but AWS_REGION is not set",
        canRepair: false,
        repairHint: "Set AWS_REGION (or AWS_DEFAULT_REGION) in runtime environment",
      };
    }
    return withStrictModeNote(
      {
        name: "Secrets adapter",
        status: "pass",
        message: "AWS Secrets Manager provider configured",
      },
      config,
    );
  }

  if (provider === "gcp_secret_manager") {
    return withStrictModeNote(
      {
        name: "Secrets adapter",
        status: "pass",
        message:
          "GCP Secret Manager provider configured (ensure ADC credentials are available at runtime)",
      },
      config,
    );
  }

  if (provider !== "local_encrypted") {
    return {
      name: "Secrets adapter",
      status: "warn",
      message: `${provider} is configured, but this provider is still a stub in this build`,
      canRepair: false,
      repairHint: "Use local_encrypted or vault for fully-supported provider behavior",
    };
  }

  const envMasterKey = process.env.HIVE_SECRETS_MASTER_KEY;
  if (envMasterKey && envMasterKey.trim().length > 0) {
    if (!decodeMasterKey(envMasterKey)) {
      return {
        name: "Secrets adapter",
        status: "fail",
        message:
          "HIVE_SECRETS_MASTER_KEY is invalid (expected 32-byte base64, 64-char hex, or raw 32-char string)",
        canRepair: false,
        repairHint: "Set HIVE_SECRETS_MASTER_KEY to a valid key or unset it to use a key file",
      };
    }

    return withStrictModeNote(
      {
        name: "Secrets adapter",
        status: "pass",
        message: "Local encrypted provider configured via HIVE_SECRETS_MASTER_KEY",
      },
      config,
    );
  }

  const keyFileOverride = process.env.HIVE_SECRETS_MASTER_KEY_FILE;
  const configuredPath =
    keyFileOverride && keyFileOverride.trim().length > 0
      ? keyFileOverride.trim()
      : config.secrets.localEncrypted.keyFilePath;
  const keyFilePath = resolveRuntimeLikePath(configuredPath, configPath);

  if (!fs.existsSync(keyFilePath)) {
    return withStrictModeNote(
      {
        name: "Secrets adapter",
        status: "warn",
        message: `Secrets key file does not exist yet: ${keyFilePath}`,
        canRepair: true,
        repair: () => {
          fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
          fs.writeFileSync(keyFilePath, randomBytes(32).toString("base64"), {
            encoding: "utf8",
            mode: 0o600,
          });
          try {
            fs.chmodSync(keyFilePath, 0o600);
          } catch {
            // best effort
          }
        },
        repairHint: "Run with --repair to create a local encrypted secrets key file",
      },
      config,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(keyFilePath, "utf8");
  } catch (err) {
    return {
      name: "Secrets adapter",
      status: "fail",
      message: `Could not read secrets key file: ${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "Check file permissions or set HIVE_SECRETS_MASTER_KEY",
    };
  }

  if (!decodeMasterKey(raw)) {
    return {
      name: "Secrets adapter",
      status: "fail",
      message: `Invalid key material in ${keyFilePath}`,
      canRepair: false,
      repairHint: "Replace with valid key material or delete it and run doctor --repair",
    };
  }

  return withStrictModeNote(
    {
      name: "Secrets adapter",
      status: "pass",
      message: `Local encrypted provider configured with key file ${keyFilePath}`,
    },
    config,
  );
}
