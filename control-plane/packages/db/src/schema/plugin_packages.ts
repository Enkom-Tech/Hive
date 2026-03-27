import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const pluginPackages = pgTable(
  "plugin_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageKey: text("package_key").notNull(),
    version: text("version").notNull(),
    manifestJson: text("manifest_json").notNull(),
    digestSha256: text("digest_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyVersion: uniqueIndex("plugin_packages_key_version_idx").on(t.packageKey, t.version),
  }),
);
