import { createHash } from "node:crypto";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { badRequest, unprocessable } from "../errors.js";
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";

interface AwsMaterial extends StoredSecretVersionMaterial {
  scheme: "aws_secrets_manager_v1";
  secretId: string;
  versionId: string | null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildSecretId(externalRef: string | null): string {
  const value = externalRef?.trim() ?? "";
  if (!value) {
    throw badRequest("aws_secrets_manager provider requires externalRef (secret id or ARN)");
  }
  return value;
}

function client(): SecretsManagerClient {
  const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
  if (!region) throw unprocessable("aws_secrets_manager provider requires AWS_REGION");
  return new SecretsManagerClient({ region });
}

function asAwsMaterial(input: StoredSecretVersionMaterial): AwsMaterial {
  if (
    input &&
    typeof input === "object" &&
    input.scheme === "aws_secrets_manager_v1" &&
    typeof input.secretId === "string" &&
    (typeof input.versionId === "string" || input.versionId === null)
  ) {
    return input as AwsMaterial;
  }
  throw badRequest("Invalid aws_secrets_manager secret material");
}

export const awsSecretsManagerProvider: SecretProviderModule = {
  id: "aws_secrets_manager",
  descriptor: {
    id: "aws_secrets_manager",
    label: "AWS Secrets Manager",
    requiresExternalRef: true,
  },
  async createVersion(input) {
    const secretId = buildSecretId(input.externalRef);
    const out = await client().send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: input.value,
      }),
    );
    return {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId,
        versionId: out.VersionId ?? null,
      } satisfies AwsMaterial,
      valueSha256: sha256Hex(input.value),
      externalRef: secretId,
    };
  },
  async resolveVersion(input) {
    const material = asAwsMaterial(input.material);
    const out = await client().send(
      new GetSecretValueCommand({
        SecretId: material.secretId,
        VersionId: material.versionId ?? undefined,
      }),
    );
    if (typeof out.SecretString !== "string") {
      throw unprocessable("AWS Secrets Manager did not return SecretString");
    }
    return out.SecretString;
  },
};
