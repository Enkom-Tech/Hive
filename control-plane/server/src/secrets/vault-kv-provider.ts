import { createHash } from "node:crypto";
import { badRequest, unprocessable } from "../errors.js";
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";

interface VaultKvMaterial extends StoredSecretVersionMaterial {
  scheme: "vault_kv_v2";
  mount: string;
  path: string;
  version: number;
}

interface VaultConfig {
  addr: string;
  token: string;
  namespace?: string;
  mount: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanSegment(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function resolveVaultConfig(): VaultConfig {
  const addrRaw = process.env.HIVE_VAULT_ADDR ?? process.env.VAULT_ADDR;
  const tokenRaw = process.env.HIVE_VAULT_TOKEN ?? process.env.VAULT_TOKEN;
  const namespaceRaw = process.env.HIVE_VAULT_NAMESPACE ?? process.env.VAULT_NAMESPACE;
  const mountRaw = process.env.HIVE_VAULT_KV_MOUNT ?? "hive";

  const addr = (addrRaw ?? "").trim();
  const token = (tokenRaw ?? "").trim();
  const mount = cleanSegment(mountRaw);

  if (!addr) {
    throw unprocessable("vault provider requires HIVE_VAULT_ADDR (or VAULT_ADDR)");
  }
  if (!token) {
    throw unprocessable("vault provider requires HIVE_VAULT_TOKEN (or VAULT_TOKEN)");
  }
  if (!mount) {
    throw unprocessable("vault provider requires HIVE_VAULT_KV_MOUNT to be non-empty");
  }

  return {
    addr: addr.replace(/\/+$/, ""),
    token,
    namespace: namespaceRaw?.trim() || undefined,
    mount,
  };
}

function buildPathFromExternalRef(externalRef: string | null): string {
  const cleaned = cleanSegment(externalRef ?? "");
  if (!cleaned) {
    throw badRequest("vault provider requires externalRef (KV path)");
  }
  return cleaned;
}

function assertVaultKvMaterial(input: StoredSecretVersionMaterial): VaultKvMaterial {
  if (
    input &&
    typeof input === "object" &&
    input.scheme === "vault_kv_v2" &&
    typeof input.mount === "string" &&
    typeof input.path === "string" &&
    typeof input.version === "number" &&
    Number.isFinite(input.version)
  ) {
    return input as VaultKvMaterial;
  }
  throw badRequest("Invalid vault_kv_v2 secret material");
}

function readVersionFromWriteResponse(payload: unknown): number {
  if (!payload || typeof payload !== "object") {
    throw unprocessable("Unexpected Vault response while creating secret version");
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    throw unprocessable("Unexpected Vault response while creating secret version");
  }
  const version = (data as { version?: unknown }).version;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw unprocessable("Vault did not return a KV version");
  }
  return version;
}

function readSecretValueFromReadResponse(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw unprocessable("Unexpected Vault response while resolving secret version");
  }
  const outerData = (payload as { data?: unknown }).data;
  if (!outerData || typeof outerData !== "object") {
    throw unprocessable("Unexpected Vault response while resolving secret version");
  }
  const secretData = (outerData as { data?: unknown }).data;
  if (!secretData || typeof secretData !== "object") {
    throw unprocessable("Unexpected Vault response while resolving secret version");
  }
  const value = (secretData as { value?: unknown }).value;
  if (typeof value !== "string") {
    throw unprocessable("Vault KV payload does not include string field 'value'");
  }
  return value;
}

async function vaultRequest(
  config: VaultConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${config.addr}/v1/${config.mount}/data/${path}`;
  const headers: Record<string, string> = {
    "X-Vault-Token": config.token,
    Accept: "application/json",
  };
  if (config.namespace) {
    headers["X-Vault-Namespace"] = config.namespace;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.trim() ? safeJson(text) : null;

  if (!response.ok) {
    if (response.status === 404) {
      throw unprocessable("Vault KV path or version not found");
    }
    if (response.status === 401 || response.status === 403) {
      throw unprocessable("Vault authentication/authorization failed");
    }
    throw unprocessable(`Vault request failed with status ${response.status}`);
  }

  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export const vaultProvider: SecretProviderModule = {
  id: "vault",
  descriptor: {
    id: "vault",
    label: "Vault / OpenBao (KV v2)",
    requiresExternalRef: true,
  },
  async createVersion(input) {
    const config = resolveVaultConfig();
    const path = buildPathFromExternalRef(input.externalRef);
    const payload = await vaultRequest(config, "POST", path, {
      data: { value: input.value },
    });
    const version = readVersionFromWriteResponse(payload);
    return {
      material: {
        scheme: "vault_kv_v2",
        mount: config.mount,
        path,
        version,
      } satisfies VaultKvMaterial,
      valueSha256: sha256Hex(input.value),
      externalRef: path,
    };
  },
  async resolveVersion(input) {
    const config = resolveVaultConfig();
    const material = assertVaultKvMaterial(input.material);
    const query = material.version > 0 ? `?version=${material.version}` : "";
    const payload = await vaultRequest(config, "GET", `${material.path}${query}`);
    return readSecretValueFromReadResponse(payload);
  },
};
