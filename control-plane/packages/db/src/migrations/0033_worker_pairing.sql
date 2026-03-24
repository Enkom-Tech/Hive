ALTER TABLE "agents" ADD COLUMN "pairing_window_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "worker_pairing_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text NOT NULL,
	"client_info" jsonb,
	"request_ip" text NOT NULL,
	"enrollment_token_plaintext" text,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"rejected_by_user_id" text,
	"rejected_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_pairing_requests" ADD CONSTRAINT "worker_pairing_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "worker_pairing_requests" ADD CONSTRAINT "worker_pairing_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "worker_pairing_requests_company_status_idx" ON "worker_pairing_requests" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "worker_pairing_requests_agent_status_idx" ON "worker_pairing_requests" USING btree ("agent_id","status");
