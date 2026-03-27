ALTER TABLE "issues" ADD COLUMN "execution_workspace_branch" text;
--> statement-breakpoint
CREATE TABLE "vcs_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vcs_webhook_deliveries" ADD CONSTRAINT "vcs_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_webhook_deliveries_company_provider_delivery_uq" ON "vcs_webhook_deliveries" USING btree ("company_id","provider","delivery_id");
--> statement-breakpoint
CREATE INDEX "vcs_webhook_deliveries_company_created_idx" ON "vcs_webhook_deliveries" USING btree ("company_id","created_at");
