import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Per-company desired-state catalog for automated managed_worker identity creation. */
export const workerIdentityDesiredSlots = pgTable(
  "worker_identity_desired_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Stable key for automation and APIs (unique per company). */
    profileKey: text("profile_key").notNull(),
    /** Base name; server deduplicates when creating agents (e.g. "Pool Engineer"). */
    displayNamePrefix: text("display_name_prefix").notNull(),
    desiredCount: integer("desired_count").notNull().default(0),
    workerPlacementMode: text("worker_placement_mode").notNull().default("automatic"),
    operationalPosture: text("operational_posture").notNull().default("active"),
    adapterType: text("adapter_type").notNull().default("managed_worker"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    role: text("role").notNull().default("general"),
    enabled: boolean("enabled").notNull().default(true),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    lastReconcileError: text("last_reconcile_error"),
    lastReconcileSummary: jsonb("last_reconcile_summary").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProfileUid: uniqueIndex("worker_identity_desired_slots_company_profile_uidx").on(
      table.companyId,
      table.profileKey,
    ),
    companyIdx: index("worker_identity_desired_slots_company_id_idx").on(table.companyId),
  }),
);
