import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** One-time bootstrap: link without a board identity; consumed after first successful provision hello. */
export const droneProvisioningTokens = pgTable(
  "drone_provisioning_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("drone_provisioning_tokens_token_hash_unique_idx").on(table.tokenHash),
    companyCreatedIdx: index("drone_provisioning_tokens_company_created_idx").on(table.companyId, table.createdAt),
    expiresIdx: index("drone_provisioning_tokens_expires_idx").on(table.expiresAt),
  }),
);
