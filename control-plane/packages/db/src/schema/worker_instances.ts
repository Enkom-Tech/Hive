import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Logical enrolled drone / machine (stable id from hive-worker hello). */
export const workerInstances = pgTable(
  "worker_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    stableInstanceId: text("stable_instance_id").notNull(),
    displayLabel: text("display_label"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Operator tags for placement/scheduling (e.g. region, GPU). */
    labels: jsonb("labels").$type<Record<string, unknown>>().notNull().default({}),
    /** When set, scheduler should avoid new placements on this instance. */
    drainRequestedAt: timestamp("drain_requested_at", { withTimezone: true }),
    /** Soft capacity hint for UI/scheduling (string or opaque). */
    capacityHint: text("capacity_hint"),
  },
  (table) => ({
    companyStableUnique: uniqueIndex("worker_instances_company_stable_unique_idx").on(
      table.companyId,
      table.stableInstanceId,
    ),
    companyIdx: index("worker_instances_company_idx").on(table.companyId),
  }),
);

/** At most one worker instance binding per board agent (managed_worker identity). */
export const workerInstanceAgents = pgTable(
  "worker_instance_agents",
  {
    workerInstanceId: uuid("worker_instance_id")
      .notNull()
      .references(() => workerInstances.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** How the binding was created: manual (board API) or automatic (placement policy). */
    assignmentSource: text("assignment_source").notNull().default("manual"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId] }),
    workerIdx: index("worker_instance_agents_worker_idx").on(table.workerInstanceId),
  }),
);
