import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Idempotency for inbound VCS webhooks (GitHub X-GitHub-Delivery, etc.). */
export const vcsWebhookDeliveries = pgTable(
  "vcs_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderDeliveryUq: uniqueIndex("vcs_webhook_deliveries_company_provider_delivery_uq").on(
      table.companyId,
      table.provider,
      table.deliveryId,
    ),
    companyCreatedIdx: index("vcs_webhook_deliveries_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
