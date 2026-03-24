import * as p from "@clack/prompts";
import type { SecretProvider } from "@hive/shared";
import type { SecretsConfig } from "../config/schema.js";
import { resolveDefaultSecretsKeyFilePath, resolveHiveInstanceId } from "../config/home.js";

function defaultKeyFilePath(): string {
  return resolveDefaultSecretsKeyFilePath(resolveHiveInstanceId());
}

export function defaultSecretsConfig(): SecretsConfig {
  const keyFilePath = defaultKeyFilePath();
  return {
    provider: "local_encrypted",
    strictMode: false,
    localEncrypted: {
      keyFilePath,
    },
    vault: {
      kvMount: "hive",
    },
  };
}

export async function promptSecrets(current?: SecretsConfig): Promise<SecretsConfig> {
  const base = current ?? defaultSecretsConfig();

  const provider = await p.select({
    message: "Secrets provider",
    options: [
      {
        value: "local_encrypted" as const,
        label: "Local encrypted (recommended)",
        hint: "best for single-developer installs",
      },
      {
        value: "aws_secrets_manager" as const,
        label: "AWS Secrets Manager",
        hint: "requires external adapter integration",
      },
      {
        value: "gcp_secret_manager" as const,
        label: "GCP Secret Manager",
        hint: "requires external adapter integration",
      },
      {
        value: "vault" as const,
        label: "Vault / OpenBao (KV v2)",
        hint: "requires HIVE_VAULT_ADDR + HIVE_VAULT_TOKEN",
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const strictMode = await p.confirm({
    message: "Require secret refs for sensitive env vars?",
    initialValue: base.strictMode,
  });

  if (p.isCancel(strictMode)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const fallbackDefault = defaultKeyFilePath();
  let keyFilePath = base.localEncrypted.keyFilePath || fallbackDefault;
  let vaultAddr = base.vault?.addr ?? "";
  let vaultNamespace = base.vault?.namespace ?? "";
  let vaultKvMount = base.vault?.kvMount ?? "hive";
  if (provider === "local_encrypted") {
    const keyPath = await p.text({
      message: "Local encrypted key file path",
      defaultValue: keyFilePath,
      placeholder: fallbackDefault,
      validate: (value) => {
        if (!value || value.trim().length === 0) return "Key file path is required";
      },
    });

    if (p.isCancel(keyPath)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    keyFilePath = keyPath.trim();
  }

  if (provider === "vault") {
    const addrValue = await p.text({
      message: "Vault/OpenBao address (optional when set by env)",
      defaultValue: vaultAddr,
      placeholder: "https://vault.example.com",
    });
    if (p.isCancel(addrValue)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    vaultAddr = addrValue.trim();

    const namespaceValue = await p.text({
      message: "Vault namespace (optional)",
      defaultValue: vaultNamespace,
      placeholder: "team/platform",
    });
    if (p.isCancel(namespaceValue)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    vaultNamespace = namespaceValue.trim();

    const mountValue = await p.text({
      message: "Vault/OpenBao KV mount path",
      defaultValue: vaultKvMount,
      placeholder: "hive",
      validate: (value) => {
        if (!value || value.trim().length === 0) return "KV mount path is required";
      },
    });
    if (p.isCancel(mountValue)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    vaultKvMount = mountValue.trim();
  } else if (provider === "aws_secrets_manager" || provider === "gcp_secret_manager") {
    p.note(
      `${provider} expects externalRef per secret and cloud credentials in runtime environment.`,
      "Heads up",
    );
  }

  return {
    provider: provider as SecretProvider,
    strictMode,
    localEncrypted: {
      keyFilePath,
    },
    vault: {
      addr: vaultAddr || undefined,
      namespace: vaultNamespace || undefined,
      kvMount: vaultKvMount || "hive",
    },
  };
}
