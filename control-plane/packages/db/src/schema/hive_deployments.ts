import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Deployment grouping for shared operator config (e.g. model catalog, gateway keys).
 * In-app `companies` reference a deployment via `deployment_id`.
 */
export const hiveDeployments = pgTable("hive_deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull().default("default"),
  /** `hive_router` = model-gateway-go + hive_gvk_*; `bifrost` = Bifrost governance virtual keys (sk-bf-*). Greenfield default: bifrost (ADR 006b). */
  modelGatewayBackend: text("model_gateway_backend").notNull().default("bifrost"),
  /** Default HTTP URL for model training runner dispatch (company URL overrides when set). */
  modelTrainingRunnerUrl: text("model_training_runner_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
