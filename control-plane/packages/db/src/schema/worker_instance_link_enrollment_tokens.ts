import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workerInstances } from "./worker_instances.js";

/** Short-lived enrollment for WebSocket link scoped to worker_instances (pool / multi-agent host). */
export const workerInstanceLinkEnrollmentTokens = pgTable(
  "worker_instance_link_enrollment_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerInstanceId: uuid("worker_instance_id")
      .notNull()
      .references(() => workerInstances.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("worker_instance_link_enrollment_tokens_token_hash_unique_idx").on(
      table.tokenHash,
    ),
    instanceCreatedIdx: index("worker_instance_link_enrollment_tokens_instance_created_idx").on(
      table.workerInstanceId,
      table.createdAt,
    ),
    expiresIdx: index("worker_instance_link_enrollment_tokens_expires_idx").on(table.expiresAt),
  }),
);
