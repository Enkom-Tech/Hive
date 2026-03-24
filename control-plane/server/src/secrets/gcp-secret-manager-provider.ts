import { createHash } from "node:crypto";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { badRequest, unprocessable } from "../errors.js";
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";

interface GcpMaterial extends StoredSecretVersionMaterial {
  scheme: "gcp_secret_manager_v1";
  secretName: string;
  versionName: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildSecretName(externalRef: string | null): string {
  const value = externalRef?.trim() ?? "";
  if (!value) {
    throw badRequest("gcp_secret_manager provider requires externalRef (projects/*/secrets/*)");
  }
  if (!/^projects\/[^/]+\/secrets\/[^/]+$/i.test(value)) {
    throw badRequest("gcp_secret_manager externalRef must be projects/{project}/secrets/{secret}");
  }
  return value;
}

function asGcpMaterial(input: StoredSecretVersionMaterial): GcpMaterial {
  if (
    input &&
    typeof input === "object" &&
    input.scheme === "gcp_secret_manager_v1" &&
    typeof input.secretName === "string" &&
    typeof input.versionName === "string"
  ) {
    return input as GcpMaterial;
  }
  throw badRequest("Invalid gcp_secret_manager secret material");
}

function client(): SecretManagerServiceClient {
  return new SecretManagerServiceClient();
}

export const gcpSecretManagerProvider: SecretProviderModule = {
  id: "gcp_secret_manager",
  descriptor: {
    id: "gcp_secret_manager",
    label: "GCP Secret Manager",
    requiresExternalRef: true,
  },
  async createVersion(input) {
    const secretName = buildSecretName(input.externalRef);
    const [version] = await client().addSecretVersion({
      parent: secretName,
      payload: { data: Buffer.from(input.value, "utf8") },
    });
    const versionName = version.name ?? "";
    if (!versionName) throw unprocessable("GCP Secret Manager did not return a version name");
    return {
      material: {
        scheme: "gcp_secret_manager_v1",
        secretName,
        versionName,
      } satisfies GcpMaterial,
      valueSha256: sha256Hex(input.value),
      externalRef: secretName,
    };
  },
  async resolveVersion(input) {
    const material = asGcpMaterial(input.material);
    const [version] = await client().accessSecretVersion({
      name: material.versionName,
    });
    const data = version.payload?.data;
    if (!data) throw unprocessable("GCP Secret Manager returned empty payload");
    return Buffer.from(data).toString("utf8");
  },
};
