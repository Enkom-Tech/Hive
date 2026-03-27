-- hive_deployments grouping, model catalog, cost_events for non-agent usage.

CREATE TABLE IF NOT EXISTS "hive_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "hive_deployments" ("id", "label")
SELECT 'a0000000-0000-4000-8000-000000000001'::uuid, 'default'
WHERE NOT EXISTS (
  SELECT 1 FROM "hive_deployments" WHERE "id" = 'a0000000-0000-4000-8000-000000000001'::uuid
);

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "deployment_id" uuid;

UPDATE "companies"
SET "deployment_id" = 'a0000000-0000-4000-8000-000000000001'
WHERE "deployment_id" IS NULL;

ALTER TABLE "companies" ALTER COLUMN "deployment_id" SET NOT NULL;

DO $$ BEGIN
 ALTER TABLE "companies" ADD CONSTRAINT "companies_deployment_id_hive_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."hive_deployments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "inference_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"company_id" uuid,
	"model_slug" text NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL,
	"base_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_deployment_id_hive_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."hive_deployments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "inference_models" ADD CONSTRAINT "inference_models_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "inference_models_deployment_slug_idx" ON "inference_models" ("deployment_id","model_slug");
CREATE INDEX IF NOT EXISTS "inference_models_company_slug_idx" ON "inference_models" ("company_id","model_slug");

ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'agent_run' NOT NULL;

ALTER TABLE "cost_events" ALTER COLUMN "agent_id" DROP NOT NULL;
