--> statement-breakpoint
ALTER TABLE "worker_instance_agents" ADD COLUMN "assignment_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_instance_agents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "worker_placement_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "operational_posture" text DEFAULT 'active' NOT NULL;
