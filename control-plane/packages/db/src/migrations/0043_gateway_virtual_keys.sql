-- Virtual keys for model router → company mapping.

CREATE TABLE IF NOT EXISTS "gateway_virtual_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);

DO $$ BEGIN
 ALTER TABLE "gateway_virtual_keys" ADD CONSTRAINT "gateway_virtual_keys_deployment_id_hive_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."hive_deployments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "gateway_virtual_keys" ADD CONSTRAINT "gateway_virtual_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "gateway_virtual_keys_key_hash_idx" ON "gateway_virtual_keys" ("key_hash");
CREATE INDEX IF NOT EXISTS "gateway_virtual_keys_deployment_idx" ON "gateway_virtual_keys" ("deployment_id");
CREATE INDEX IF NOT EXISTS "gateway_virtual_keys_company_idx" ON "gateway_virtual_keys" ("company_id");
