ALTER TABLE "hive_deployments" ADD COLUMN IF NOT EXISTS "model_training_runner_url" text;

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "model_training_runner_url" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "identity_self_tune_policy" text DEFAULT 'disabled' NOT NULL;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "require_approval_for_model_promotion" boolean DEFAULT false NOT NULL;

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "identity_self_tune_policy" text;

CREATE TABLE "model_training_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "deployment_id" uuid NOT NULL REFERENCES "hive_deployments"("id") ON DELETE RESTRICT,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "source_inference_model_id" uuid REFERENCES "inference_models"("id") ON DELETE SET NULL,
  "proposed_model_slug" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "runner_kind" text DEFAULT 'http_json' NOT NULL,
  "runner_target_url" text,
  "external_job_ref" text,
  "result_base_url" text,
  "result_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_callback_digest" text,
  "promoted_inference_model_id" uuid REFERENCES "inference_models"("id") ON DELETE SET NULL,
  "promoted_at" timestamp with time zone,
  "error" text,
  "callback_token_hash" text NOT NULL,
  "dataset_filter_spec" jsonb,
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "model_training_runs_company_created_idx" ON "model_training_runs" ("company_id", "created_at");
CREATE INDEX "model_training_runs_company_status_idx" ON "model_training_runs" ("company_id", "status");
CREATE INDEX "model_training_runs_agent_created_idx" ON "model_training_runs" ("agent_id", "created_at");

CREATE UNIQUE INDEX "model_training_runs_company_idempotency_uq" ON "model_training_runs" ("company_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL AND trim("idempotency_key") <> '';
