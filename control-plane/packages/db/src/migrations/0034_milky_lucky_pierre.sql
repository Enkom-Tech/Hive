CREATE TABLE "worker_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"stable_instance_id" text NOT NULL,
	"display_label" text,
	"last_seen_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_instance_agents" (
	"worker_instance_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_instance_agents_agent_id_pk" PRIMARY KEY("agent_id")
);
--> statement-breakpoint
ALTER TABLE "worker_instance_agents" ADD CONSTRAINT "worker_instance_agents_worker_instance_id_worker_instances_id_fk" FOREIGN KEY ("worker_instance_id") REFERENCES "public"."worker_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_instance_agents" ADD CONSTRAINT "worker_instance_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_instances" ADD CONSTRAINT "worker_instances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_instance_agents_worker_idx" ON "worker_instance_agents" USING btree ("worker_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_instances_company_stable_unique_idx" ON "worker_instances" USING btree ("company_id","stable_instance_id");--> statement-breakpoint
CREATE INDEX "worker_instances_company_idx" ON "worker_instances" USING btree ("company_id");
