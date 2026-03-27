import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { hiveDeployments } from "./hive_deployments.js";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Deployment row for shared operator-scoped config (see `hive_deployments`). */
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => hiveDeployments.id),
    name: text("name").notNull(),
    description: text("description"),
    /** Free text injected into production agent runs (with project/dept sections). */
    productionPolicies: text("production_policies"),
    status: text("status").notNull().default("active"),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(true),
    requireQualityReviewForDone: boolean("require_quality_review_for_done").notNull().default(false),
    brandColor: text("brand_color"),
    /** Optional per-company JSON for hive-worker runtime/adapters manifest (HTTPS URLs, checksums). */
    workerRuntimeManifestJson: text("worker_runtime_manifest_json"),
    /** Overrides deployment `model_training_runner_url` when set. */
    modelTrainingRunnerUrl: text("model_training_runner_url"),
    /** disabled | approval_required | auto_dispatch — future worker-initiated training; board APIs use RBAC. */
    identitySelfTunePolicy: text("identity_self_tune_policy").notNull().default("disabled"),
    /** When true, POST promote requires an approved `promote_model` approval for this run. */
    requireApprovalForModelPromotion: boolean("require_approval_for_model_promotion")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
  }),
);
