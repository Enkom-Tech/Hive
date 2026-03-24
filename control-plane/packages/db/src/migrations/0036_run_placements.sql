CREATE TABLE "run_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"worker_instance_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"policy_version" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run_placements" ADD CONSTRAINT "run_placements_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_placements" ADD CONSTRAINT "run_placements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_placements" ADD CONSTRAINT "run_placements_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_placements" ADD CONSTRAINT "run_placements_worker_instance_id_worker_instances_id_fk" FOREIGN KEY ("worker_instance_id") REFERENCES "public"."worker_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_placements_heartbeat_run_unique_idx" ON "run_placements" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "run_placements_agent_state_idx" ON "run_placements" USING btree ("agent_id","state");--> statement-breakpoint
CREATE INDEX "run_placements_company_created_idx" ON "run_placements" USING btree ("company_id","created_at");
