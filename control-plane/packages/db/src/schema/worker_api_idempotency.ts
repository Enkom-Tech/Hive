import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/** Opaque replay cache for worker-api mutating routes (e.g. POST /worker-api/issues). */
export const workerApiIdempotency = pgTable(
  "worker_api_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    route: text("route").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    httpStatus: integer("http_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("worker_api_idempotency_company_agent_route_key_uniq").on(
      t.companyId,
      t.agentId,
      t.route,
      t.idempotencyKey,
    ),
  }),
);
