import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { hiveDeployments } from "./hive_deployments.js";
import { agents } from "./agents.js";
import { inferenceModels } from "./inference_models.js";

export const modelTrainingRuns = pgTable(
  "model_training_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => hiveDeployments.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    sourceInferenceModelId: uuid("source_inference_model_id").references(() => inferenceModels.id, {
      onDelete: "set null",
    }),
    proposedModelSlug: text("proposed_model_slug").notNull(),
    status: text("status").notNull().default("queued"),
    runnerKind: text("runner_kind").notNull().default("http_json"),
    /** Optional per-run override; otherwise company then deployment default is used at dispatch. */
    runnerTargetUrl: text("runner_target_url"),
    externalJobRef: text("external_job_ref"),
    resultBaseUrl: text("result_base_url"),
    resultMetadata: jsonb("result_metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** SHA-256 hex of last processed callback body for idempotency. */
    lastCallbackDigest: text("last_callback_digest"),
    promotedInferenceModelId: uuid("promoted_inference_model_id").references(() => inferenceModels.id, {
      onDelete: "set null",
    }),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    error: text("error"),
    /** SHA-256 hex of secret token; runner sends raw token in Authorization: Bearer on callback. */
    callbackTokenHash: text("callback_token_hash").notNull(),
    /** Optional JSON filter for dataset export reproducibility. */
    datasetFilterSpec: jsonb("dataset_filter_spec").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("model_training_runs_company_created_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("model_training_runs_company_status_idx").on(table.companyId, table.status),
    agentCreatedIdx: index("model_training_runs_agent_created_idx").on(table.agentId, table.createdAt),
  }),
);
