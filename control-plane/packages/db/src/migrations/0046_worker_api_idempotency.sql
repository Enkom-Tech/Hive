CREATE TABLE "worker_api_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"route" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"http_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_api_idempotency" ADD CONSTRAINT "worker_api_idempotency_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "worker_api_idempotency" ADD CONSTRAINT "worker_api_idempotency_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "worker_api_idempotency_company_agent_route_key_uniq" ON "worker_api_idempotency" USING btree ("company_id","agent_id","route","idempotency_key");
