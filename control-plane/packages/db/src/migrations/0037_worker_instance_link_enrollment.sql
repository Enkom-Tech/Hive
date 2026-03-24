CREATE TABLE "worker_instance_link_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_instance_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_instance_link_enrollment_tokens" ADD CONSTRAINT "worker_instance_link_enrollment_tokens_worker_instance_id_worker_instances_id_fk" FOREIGN KEY ("worker_instance_id") REFERENCES "public"."worker_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "worker_instance_link_enrollment_tokens" ADD CONSTRAINT "worker_instance_link_enrollment_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "worker_instance_link_enrollment_tokens_token_hash_unique_idx" ON "worker_instance_link_enrollment_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "worker_instance_link_enrollment_tokens_instance_created_idx" ON "worker_instance_link_enrollment_tokens" USING btree ("worker_instance_id","created_at");
--> statement-breakpoint
CREATE INDEX "worker_instance_link_enrollment_tokens_expires_idx" ON "worker_instance_link_enrollment_tokens" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "run_placements" ADD COLUMN "dispatch_attempt_count" integer DEFAULT 0 NOT NULL;
