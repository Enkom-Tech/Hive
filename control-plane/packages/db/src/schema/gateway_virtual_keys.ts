import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { hiveDeployments } from "./hive_deployments.js";
import { companies } from "./companies.js";

/**
 * Virtual API keys for the model router: hashed at rest; map to in-app company for usage attribution.
 * Product-tenant is implied via company.deployment_id.
 */
export const gatewayVirtualKeys = pgTable(
  "gateway_virtual_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => hiveDeployments.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    /** SHA-256 hex of the full secret token (never store plaintext). */
    keyHash: text("key_hash").notNull(),
    /** Short prefix for operator UI (e.g. first 16 chars of token). */
    keyPrefix: text("key_prefix").notNull(),
    /** `hive_router` | `bifrost` — must match how the token is validated upstream. */
    keyKind: text("key_kind").notNull().default("hive_router"),
    /** Bifrost config store id when created via governance API. */
    bifrostVirtualKeyId: text("bifrost_virtual_key_id"),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    keyHashUnique: uniqueIndex("gateway_virtual_keys_key_hash_idx").on(table.keyHash),
    deploymentIdx: index("gateway_virtual_keys_deployment_idx").on(table.deploymentId),
    companyIdx: index("gateway_virtual_keys_company_idx").on(table.companyId),
  }),
);
