import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  approvals,
  companySecrets,
  companySecretVersions,
  invites,
  joinRequests,
} from "@hive/db";
import type { SecretProvider } from "@hive/shared";
import { badRequest, notFound } from "../errors.js";
import { getSecretProvider } from "../secrets/provider-registry.js";

type MigrationUsageItem = {
  kind: "agent" | "approval" | "invite" | "join_request";
  id: string;
};

export interface SecretMigrationDryRunItem {
  secretId: string;
  name: string;
  fromProvider: SecretProvider;
  toProvider: SecretProvider;
  latestVersion: number;
  versionCount: number;
  usage: MigrationUsageItem[];
  plannedExternalRef: string;
}

export interface SecretMigrationApplyItem {
  secretId: string;
  fromProvider: SecretProvider;
  toProvider: SecretProvider;
  versionsMigrated: number;
  externalRef: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function collectSecretIdsFromEnv(envValue: unknown): Set<string> {
  const result = new Set<string>();
  const env = asRecord(envValue);
  if (!env) return result;
  for (const binding of Object.values(env)) {
    const record = asRecord(binding);
    if (!record) continue;
    if (record.type !== "secret_ref") continue;
    if (typeof record.secretId !== "string" || record.secretId.length === 0) continue;
    result.add(record.secretId);
  }
  return result;
}

function defaultVaultPath(companyId: string, secretId: string): string {
  return `companies/${companyId}/secrets/${secretId}`;
}

function ensureSupportedMigration(_from: SecretProvider, _to: SecretProvider): void {}

export function secretProviderMigrationService(db: Db) {
  async function listCompanySecretsForMigration(
    companyId: string,
    secretIds: string[] | undefined,
  ) {
    if (secretIds && secretIds.length > 0) {
      return db
        .select()
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, companyId), inArray(companySecrets.id, secretIds)));
    }
    return db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
  }

  async function buildUsageMap(companyId: string): Promise<Map<string, MigrationUsageItem[]>> {
    const usageBySecretId = new Map<string, MigrationUsageItem[]>();

    const agentRows = await db
      .select({ id: agents.id, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    for (const row of agentRows) {
      for (const secretId of collectSecretIdsFromEnv(asRecord(row.adapterConfig)?.env)) {
        const list = usageBySecretId.get(secretId) ?? [];
        list.push({ kind: "agent", id: row.id });
        usageBySecretId.set(secretId, list);
      }
    }

    const approvalRows = await db
      .select({ id: approvals.id, payload: approvals.payload })
      .from(approvals)
      .where(eq(approvals.companyId, companyId));
    for (const row of approvalRows) {
      const payload = asRecord(row.payload);
      for (const secretId of collectSecretIdsFromEnv(asRecord(payload?.adapterConfig)?.env)) {
        const list = usageBySecretId.get(secretId) ?? [];
        list.push({ kind: "approval", id: row.id });
        usageBySecretId.set(secretId, list);
      }
    }

    const inviteRows = await db
      .select({ id: invites.id, defaultsPayload: invites.defaultsPayload })
      .from(invites)
      .where(eq(invites.companyId, companyId));
    for (const row of inviteRows) {
      const payload = asRecord(row.defaultsPayload);
      for (const secretId of collectSecretIdsFromEnv(asRecord(payload?.adapterConfig)?.env)) {
        const list = usageBySecretId.get(secretId) ?? [];
        list.push({ kind: "invite", id: row.id });
        usageBySecretId.set(secretId, list);
      }
    }

    const joinRows = await db
      .select({ id: joinRequests.id, agentDefaultsPayload: joinRequests.agentDefaultsPayload })
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId));
    for (const row of joinRows) {
      for (const secretId of collectSecretIdsFromEnv(asRecord(row.agentDefaultsPayload)?.env)) {
        const list = usageBySecretId.get(secretId) ?? [];
        list.push({ kind: "join_request", id: row.id });
        usageBySecretId.set(secretId, list);
      }
    }

    return usageBySecretId;
  }

  async function dryRun(input: {
    companyId: string;
    targetProvider: SecretProvider;
    secretIds?: string[];
  }): Promise<{ items: SecretMigrationDryRunItem[] }> {
    const secrets = await listCompanySecretsForMigration(input.companyId, input.secretIds);
    const usageBySecretId = await buildUsageMap(input.companyId);
    const items: SecretMigrationDryRunItem[] = [];

    for (const secret of secrets) {
      ensureSupportedMigration(secret.provider as SecretProvider, input.targetProvider);
      if ((secret.provider as SecretProvider) === input.targetProvider) continue;
      const versions = await db
        .select({ version: companySecretVersions.version })
        .from(companySecretVersions)
        .where(eq(companySecretVersions.secretId, secret.id));
      items.push({
        secretId: secret.id,
        name: secret.name,
        fromProvider: secret.provider as SecretProvider,
        toProvider: input.targetProvider,
        latestVersion: secret.latestVersion,
        versionCount: versions.length,
        usage: usageBySecretId.get(secret.id) ?? [],
        plannedExternalRef: secret.externalRef ?? defaultVaultPath(input.companyId, secret.id),
      });
    }

    return { items };
  }

  async function apply(input: {
    companyId: string;
    targetProvider: SecretProvider;
    secretIds?: string[];
  }): Promise<{ items: SecretMigrationApplyItem[] }> {
    const secrets = await listCompanySecretsForMigration(input.companyId, input.secretIds);
    if (secrets.length === 0) {
      if (input.secretIds && input.secretIds.length > 0) throw notFound("No matching secrets found");
      return { items: [] };
    }

    const migrated: SecretMigrationApplyItem[] = [];
    for (const secret of secrets) {
      const fromProviderId = secret.provider as SecretProvider;
      ensureSupportedMigration(fromProviderId, input.targetProvider);
      if (fromProviderId === input.targetProvider) continue;

      const fromProvider = getSecretProvider(fromProviderId);
      const targetProvider = getSecretProvider(input.targetProvider);
      const externalRef = secret.externalRef ?? defaultVaultPath(input.companyId, secret.id);
      const versions = await db
        .select()
        .from(companySecretVersions)
        .where(eq(companySecretVersions.secretId, secret.id))
        .orderBy(asc(companySecretVersions.version));
      if (versions.length === 0) {
        throw badRequest(`Secret has no versions: ${secret.id}`);
      }

      const migratedMaterials = [] as Array<{
        versionRowId: string;
        material: Record<string, unknown>;
        valueSha256: string;
      }>;

      for (const versionRow of versions) {
        const plain = await fromProvider.resolveVersion({
          material: versionRow.material as Record<string, unknown>,
          externalRef: secret.externalRef,
        });
        const targetVersion = await targetProvider.createVersion({
          value: plain,
          externalRef,
        });
        migratedMaterials.push({
          versionRowId: versionRow.id,
          material: targetVersion.material,
          valueSha256: targetVersion.valueSha256,
        });
      }

      await db.transaction(async (tx) => {
        await tx
          .update(companySecrets)
          .set({
            provider: input.targetProvider,
            externalRef,
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, secret.id));

        for (const row of migratedMaterials) {
          await tx
            .update(companySecretVersions)
            .set({
              material: row.material,
              valueSha256: row.valueSha256,
            })
            .where(eq(companySecretVersions.id, row.versionRowId));
        }
      });

      migrated.push({
        secretId: secret.id,
        fromProvider: fromProviderId,
        toProvider: input.targetProvider,
        versionsMigrated: migratedMaterials.length,
        externalRef,
      });
    }

    return { items: migrated };
  }

  return {
    dryRun,
    apply,
  };
}
