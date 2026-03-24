import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    eventType: text("event_type").notNull().default("work_available"),
    status: text("status").notNull(),
    httpStatusCode: integer("http_status_code"),
    responseBodyExcerpt: text("response_body_excerpt"),
    durationMs: integer("duration_ms"),
    attemptNumber: integer("attempt_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("webhook_deliveries_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    agentCreatedIdx: index("webhook_deliveries_agent_created_idx").on(
      table.agentId,
      table.createdAt,
    ),
  }),
);
