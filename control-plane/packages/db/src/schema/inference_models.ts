import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { hiveDeployments } from "./hive_deployments.js";
import { companies } from "./companies.js";

/** Logical chat or embedding model route for a deployment (optional per-company override). */
export const inferenceModels = pgTable(
  "inference_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => hiveDeployments.id),
    /** When set, this row overrides the deployment default for this company only. */
    companyId: uuid("company_id").references(() => companies.id),
    /** OpenAI-style model id used in requests and router registry. */
    modelSlug: text("model_slug").notNull(),
    kind: text("kind").notNull().default("chat"),
    baseUrl: text("base_url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deploymentSlugIdx: index("inference_models_deployment_slug_idx").on(table.deploymentId, table.modelSlug),
    companySlugIdx: index("inference_models_company_slug_idx").on(table.companyId, table.modelSlug),
  }),
);
