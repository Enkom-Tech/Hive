--> statement-breakpoint
ALTER TABLE "worker_enrollment_tokens" RENAME TO "managed_worker_link_enrollment_tokens";--> statement-breakpoint
ALTER INDEX "worker_enrollment_tokens_token_hash_unique_idx" RENAME TO "managed_worker_link_enrollment_tokens_token_hash_unique_idx";--> statement-breakpoint
ALTER INDEX "worker_enrollment_tokens_agent_created_idx" RENAME TO "managed_worker_link_enrollment_tokens_agent_created_idx";--> statement-breakpoint
ALTER INDEX "worker_enrollment_tokens_expires_idx" RENAME TO "managed_worker_link_enrollment_tokens_expires_idx";--> statement-breakpoint
ALTER TABLE "managed_worker_link_enrollment_tokens" RENAME CONSTRAINT "worker_enrollment_tokens_agent_id_agents_id_fk" TO "managed_worker_link_enrollment_tokens_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "managed_worker_link_enrollment_tokens" RENAME CONSTRAINT "worker_enrollment_tokens_company_id_companies_id_fk" TO "managed_worker_link_enrollment_tokens_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "worker_instances" ADD COLUMN "labels" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_instances" ADD COLUMN "drain_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_instances" ADD COLUMN "capacity_hint" text;
