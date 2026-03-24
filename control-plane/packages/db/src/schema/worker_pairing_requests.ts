import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Board approves in UI; worker polls anonymously with request id until token is delivered. */
export const workerPairingRequests = pgTable(
  "worker_pairing_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    status: text("status").notNull(),
    clientInfo: jsonb("client_info").$type<Record<string, unknown> | null>(),
    requestIp: text("request_ip").notNull(),
    /** Cleared after the worker polls the token once. */
    enrollmentTokenPlaintext: text("enrollment_token_plaintext"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByUserId: text("rejected_by_user_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    companyStatusIdx: index("worker_pairing_requests_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    agentStatusIdx: index("worker_pairing_requests_agent_status_idx").on(table.agentId, table.status),
  }),
);
