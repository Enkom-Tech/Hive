import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workerIdentityDesiredSlots } from "./worker_identity_desired_slots.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("managed_worker"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    /** When set and in the future, workers may open pairing requests for this agent without a pre-minted token. */
    pairingWindowExpiresAt: timestamp("pairing_window_expires_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /** manual | automatic — whether the control plane may pick a drone when unassigned (requires HIVE_AUTO_PLACEMENT_ENABLED). */
    workerPlacementMode: text("worker_placement_mode").notNull().default("manual"),
    /** active | archived | hibernate | sandbox — lifecycle / isolation posture for scheduling. */
    operationalPosture: text("operational_posture").notNull().default("active"),
    /** When set, this row was created or is owned by a worker identity desired-state slot. */
    workerIdentitySlotId: uuid("worker_identity_slot_id").references(() => workerIdentityDesiredSlots.id, {
      onDelete: "set null",
    }),
    /** Null inherits company `identity_self_tune_policy`. */
    identitySelfTunePolicy: text("identity_self_tune_policy"),
    /** Last reason automatic placement failed for automatic-mode agents (observability). */
    lastAutomaticPlacementFailure: text("last_automatic_placement_failure"),
    lastAutomaticPlacementFailureAt: timestamp("last_automatic_placement_failure_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    workerIdentitySlotIdx: index("agents_worker_identity_slot_id_idx").on(table.workerIdentitySlotId),
  }),
);
