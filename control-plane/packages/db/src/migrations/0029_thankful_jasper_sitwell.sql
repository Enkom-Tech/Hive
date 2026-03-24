CREATE TABLE "intent_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"link_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"raw_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"intent_type" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"canonical_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_runtime_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"project_workspace_id" uuid,
	"issue_id" uuid,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"service_name" text NOT NULL,
	"status" text NOT NULL,
	"lifecycle" text NOT NULL,
	"reuse_key" text,
	"command" text,
	"cwd" text,
	"port" integer,
	"url" text,
	"provider" text NOT NULL,
	"provider_ref" text,
	"owner_agent_id" uuid,
	"started_by_run_id" uuid,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_policy" jsonb,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "adapter_type" SET DEFAULT 'managed_worker';--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_workspace_settings" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "execution_workspace_policy" jsonb;--> statement-breakpoint
ALTER TABLE "intent_links" ADD CONSTRAINT "intent_links_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_links" ADD CONSTRAINT "intent_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_started_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("started_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intent_links_intent_id_idx" ON "intent_links" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "intent_links_company_entity_idx" ON "intent_links" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intents_company_canonical_key_idx" ON "intents" USING btree ("company_id","canonical_key");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_workspace_status_idx" ON "workspace_runtime_services" USING btree ("company_id","project_workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_project_status_idx" ON "workspace_runtime_services" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_run_idx" ON "workspace_runtime_services" USING btree ("started_by_run_id");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_updated_idx" ON "workspace_runtime_services" USING btree ("company_id","updated_at");