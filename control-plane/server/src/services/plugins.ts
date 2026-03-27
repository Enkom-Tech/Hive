import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { companies, pluginInstances, pluginPackages } from "@hive/db";
import type { PluginCapability, PluginManifest } from "@hive/plugin-sdk";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCapabilitiesJson(raw: string): PluginCapability[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is PluginCapability => typeof x === "string");
  } catch {
    return [];
  }
}

export function pluginRegistryService(db: Db) {
  return {
    async listForCompany(companyId: string) {
      const company = await db
        .select({ deploymentId: companies.deploymentId })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) return [];

      return db
        .select({
          instanceId: pluginInstances.id,
          enabled: pluginInstances.enabled,
          packageKey: pluginPackages.packageKey,
          version: pluginPackages.version,
          manifestJson: pluginPackages.manifestJson,
          capabilitiesJson: pluginInstances.capabilitiesJson,
          digestSha256: pluginPackages.digestSha256,
          createdAt: pluginInstances.createdAt,
          updatedAt: pluginInstances.updatedAt,
        })
        .from(pluginInstances)
        .innerJoin(pluginPackages, eq(pluginInstances.packageId, pluginPackages.id))
        .where(eq(pluginInstances.deploymentId, company.deploymentId));
    },

    async registerFromManifest(input: {
      companyId: string;
      packageKey: string;
      version: string;
      manifest: PluginManifest;
      manifestJson: string;
      digestSha256?: string | null;
    }) {
      const company = await db
        .select({ deploymentId: companies.deploymentId })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) return null;

      const caps = JSON.stringify(input.manifest.capabilities ?? []);

      const existingPkg = await db
        .select({ id: pluginPackages.id })
        .from(pluginPackages)
        .where(
          and(eq(pluginPackages.packageKey, input.packageKey), eq(pluginPackages.version, input.version)),
        )
        .then((rows) => rows[0] ?? null);

      let packageId: string;
      if (existingPkg) {
        packageId = existingPkg.id;
        await db
          .update(pluginPackages)
          .set({
            manifestJson: input.manifestJson,
            digestSha256: input.digestSha256 ?? null,
          })
          .where(eq(pluginPackages.id, packageId));
      } else {
        const inserted = await db
          .insert(pluginPackages)
          .values({
            packageKey: input.packageKey,
            version: input.version,
            manifestJson: input.manifestJson,
            digestSha256: input.digestSha256 ?? null,
          })
          .returning({ id: pluginPackages.id });
        packageId = inserted[0]!.id;
      }

      const existingInst = await db
        .select({ id: pluginInstances.id })
        .from(pluginInstances)
        .where(
          and(
            eq(pluginInstances.deploymentId, company.deploymentId),
            eq(pluginInstances.packageId, packageId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const rpcToken = randomBytes(32).toString("hex");
      const rpcTokenHash = sha256Hex(rpcToken);

      if (existingInst) {
        await db
          .update(pluginInstances)
          .set({
            enabled: true,
            capabilitiesJson: caps,
            rpcTokenHash,
            updatedAt: new Date(),
          })
          .where(eq(pluginInstances.id, existingInst.id));
        return { instanceId: existingInst.id, rpcToken, rotatedToken: true as const };
      }

      const inst = await db
        .insert(pluginInstances)
        .values({
          deploymentId: company.deploymentId,
          packageId,
          enabled: true,
          capabilitiesJson: caps,
          rpcTokenHash,
        })
        .returning({ id: pluginInstances.id });

      return { instanceId: inst[0]!.id, rpcToken, rotatedToken: false as const };
    },

    async patchInstance(input: {
      companyId: string;
      instanceId: string;
      enabled?: boolean;
      capabilities?: PluginCapability[];
    }) {
      const company = await db
        .select({ deploymentId: companies.deploymentId })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) return null;

      const row = await db
        .select({ id: pluginInstances.id })
        .from(pluginInstances)
        .where(
          and(eq(pluginInstances.id, input.instanceId), eq(pluginInstances.deploymentId, company.deploymentId)),
        )
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      const patch: Partial<typeof pluginInstances.$inferInsert> = { updatedAt: new Date() };
      if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
      if (input.capabilities) patch.capabilitiesJson = JSON.stringify(input.capabilities);

      await db.update(pluginInstances).set(patch).where(eq(pluginInstances.id, input.instanceId));
      return { ok: true as const };
    },

    async getInstanceForRpc(instanceId: string) {
      const row = await db
        .select({
          id: pluginInstances.id,
          enabled: pluginInstances.enabled,
          capabilitiesJson: pluginInstances.capabilitiesJson,
          deploymentId: pluginInstances.deploymentId,
        })
        .from(pluginInstances)
        .where(eq(pluginInstances.id, instanceId))
        .then((rows) => rows[0] ?? null);
      return row;
    },

    parseCapabilitiesJson,
  };
}
