CREATE TABLE "worker_identity_desired_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_key" text NOT NULL,
	"display_name_prefix" text NOT NULL,
	"desired_count" integer DEFAULT 0 NOT NULL,
	"worker_placement_mode" text DEFAULT 'automatic' NOT NULL,
	"operational_posture" text DEFAULT 'active' NOT NULL,
	"adapter_type" text DEFAULT 'managed_worker' NOT NULL,
	"adapter_config" jsonb DEFAULT '{}' NOT NULL,
	"runtime_config" jsonb DEFAULT '{}' NOT NULL,
	"role" text DEFAULT 'general' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"last_reconcile_error" text,
	"last_reconcile_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_identity_desired_slots" ADD CONSTRAINT "worker_identity_desired_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "worker_identity_desired_slots_company_profile_uidx" ON "worker_identity_desired_slots" USING btree ("company_id","profile_key");
--> statement-breakpoint
CREATE INDEX "worker_identity_desired_slots_company_id_idx" ON "worker_identity_desired_slots" USING btree ("company_id");
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "worker_identity_slot_id" uuid;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_automatic_placement_failure" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_automatic_placement_failure_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_worker_identity_slot_id_worker_identity_desired_slots_id_fk" FOREIGN KEY ("worker_identity_slot_id") REFERENCES "public"."worker_identity_desired_slots"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agents_worker_identity_slot_id_idx" ON "agents" USING btree ("worker_identity_slot_id");
