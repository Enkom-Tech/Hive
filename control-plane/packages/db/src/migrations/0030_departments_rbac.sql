CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "department_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "departments_company_slug_unique_idx" ON "departments" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "departments_company_status_idx" ON "departments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "department_memberships_unique_idx" ON "department_memberships" USING btree ("company_id","department_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "department_memberships_principal_status_idx" ON "department_memberships" USING btree ("company_id","principal_type","principal_id","status");--> statement-breakpoint
CREATE INDEX "department_memberships_department_status_idx" ON "department_memberships" USING btree ("company_id","department_id","status");--> statement-breakpoint
CREATE INDEX "department_memberships_primary_principal_idx" ON "department_memberships" USING btree ("company_id","principal_type","principal_id","is_primary");--> statement-breakpoint
CREATE INDEX "issues_company_department_idx" ON "issues" USING btree ("company_id","department_id");
