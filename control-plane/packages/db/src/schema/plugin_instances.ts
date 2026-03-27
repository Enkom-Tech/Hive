import { pgTable, uuid, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { hiveDeployments } from "./hive_deployments.js";
import { pluginPackages } from "./plugin_packages.js";

export const pluginInstances = pgTable(
  "plugin_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => hiveDeployments.id, { onDelete: "cascade" }),
    packageId: uuid("package_id")
      .notNull()
      .references(() => pluginPackages.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(true),
    configJson: text("config_json"),
    capabilitiesJson: text("capabilities_json").notNull().default("[]"),
    rpcTokenHash: text("rpc_token_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    deploymentPackage: uniqueIndex("plugin_instances_deployment_package_idx").on(t.deploymentId, t.packageId),
  }),
);
