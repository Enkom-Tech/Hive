CREATE TABLE "drone_provisioning_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drone_provisioning_tokens" ADD CONSTRAINT "drone_provisioning_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "drone_provisioning_tokens_token_hash_unique_idx" ON "drone_provisioning_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "drone_provisioning_tokens_company_created_idx" ON "drone_provisioning_tokens" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "drone_provisioning_tokens_expires_idx" ON "drone_provisioning_tokens" USING btree ("expires_at");
