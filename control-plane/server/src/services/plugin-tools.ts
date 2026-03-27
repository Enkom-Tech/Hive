import { and, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { companies, pluginInstances, pluginPackages } from "@hive/db";
import { parsePluginManifestJson } from "@hive/plugin-sdk";

export type PluginToolCatalogEntry = { name: string; description?: string };

/**
 * Namespaced tool descriptors for worker-facing discovery (`plugin:<packageKey>:<toolName>`).
 */
export async function listPluginToolCatalogForCompany(
  db: Db,
  companyId: string,
): Promise<PluginToolCatalogEntry[]> {
  const company = await db
    .select({ deploymentId: companies.deploymentId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!company) return [];

  const rows = await db
    .select({
      packageKey: pluginPackages.packageKey,
      manifestJson: pluginPackages.manifestJson,
    })
    .from(pluginInstances)
    .innerJoin(pluginPackages, eq(pluginInstances.packageId, pluginPackages.id))
    .where(and(eq(pluginInstances.deploymentId, company.deploymentId), eq(pluginInstances.enabled, true)));

  const out: PluginToolCatalogEntry[] = [];
  for (const row of rows) {
    try {
      const manifest = parsePluginManifestJson(row.manifestJson);
      for (const t of manifest.tools ?? []) {
        out.push({
          name: `plugin:${row.packageKey}:${t.name}`,
          description: t.description,
        });
      }
    } catch {
      // ignore invalid manifest rows
    }
  }
  return out;
}
