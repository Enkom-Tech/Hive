import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/** Short-lived enrollment secrets for managed worker WebSocket link; scoped to board agent id. */
export const managedWorkerLinkEnrollmentTokens = pgTable(
  "managed_worker_link_enrollment_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("managed_worker_link_enrollment_tokens_token_hash_unique_idx").on(
      table.tokenHash,
    ),
    agentCreatedIdx: index("managed_worker_link_enrollment_tokens_agent_created_idx").on(
      table.agentId,
      table.createdAt,
    ),
    expiresIdx: index("managed_worker_link_enrollment_tokens_expires_idx").on(table.expiresAt),
  }),
);
