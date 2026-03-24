ALTER TABLE "companies" ADD COLUMN "require_quality_review_for_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "requires_quality_review" boolean;