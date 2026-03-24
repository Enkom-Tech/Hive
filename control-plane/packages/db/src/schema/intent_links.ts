import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { intents } from "./intents.js";

export const intentLinks = pgTable(
  "intent_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: uuid("intent_id").notNull().references(() => intents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    linkType: text("link_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    intentIdIdx: index("intent_links_intent_id_idx").on(table.intentId),
    companyEntityIdx: index("intent_links_company_entity_idx").on(
      table.companyId,
      table.entityType,
      table.entityId,
    ),
  }),
);
