import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { workerInstances } from "./worker_instances.js";

/** Placement state for a heartbeat run when placement v1 is enabled (see ADR 002). */
export const runPlacements = pgTable(
  "run_placements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    heartbeatRunId: uuid("heartbeat_run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    workerInstanceId: uuid("worker_instance_id")
      .notNull()
      .references(() => workerInstances.id),
    state: text("state").notNull().default("pending"),
    failureCode: text("failure_code"),
    policyVersion: text("policy_version"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    dispatchAttemptCount: integer("dispatch_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    heartbeatRunUnique: uniqueIndex("run_placements_heartbeat_run_unique_idx").on(table.heartbeatRunId),
    agentStateIdx: index("run_placements_agent_state_idx").on(table.agentId, table.state),
    companyCreatedIdx: index("run_placements_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
