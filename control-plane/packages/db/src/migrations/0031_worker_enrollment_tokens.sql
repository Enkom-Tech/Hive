CREATE TABLE "worker_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_enrollment_tokens" ADD CONSTRAINT "worker_enrollment_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_enrollment_tokens" ADD CONSTRAINT "worker_enrollment_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_enrollment_tokens_token_hash_unique_idx" ON "worker_enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "worker_enrollment_tokens_agent_created_idx" ON "worker_enrollment_tokens" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "worker_enrollment_tokens_expires_idx" ON "worker_enrollment_tokens" USING btree ("expires_at");
