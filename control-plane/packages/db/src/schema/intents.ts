import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const intents = pgTable(
  "intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    source: text("source").notNull(),
    rawText: text("raw_text").notNull(),
    normalizedText: text("normalized_text").notNull(),
    intentType: text("intent_type").notNull(),
    state: text("state").notNull().default("open"),
    canonicalKey: text("canonical_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCanonicalKeyUniqueIdx: uniqueIndex("intents_company_canonical_key_idx").on(
      table.companyId,
      table.canonicalKey,
    ),
  }),
);
