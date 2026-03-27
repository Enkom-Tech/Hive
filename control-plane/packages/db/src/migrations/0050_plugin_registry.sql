CREATE TABLE "plugin_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "package_key" text NOT NULL,
  "version" text NOT NULL,
  "manifest_json" text NOT NULL,
  "digest_sha256" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_packages_key_version_unique" UNIQUE ("package_key", "version")
);

CREATE TABLE "plugin_instances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deployment_id" uuid NOT NULL REFERENCES "hive_deployments"("id") ON DELETE CASCADE,
  "package_id" uuid NOT NULL REFERENCES "plugin_packages"("id") ON DELETE RESTRICT,
  "enabled" boolean DEFAULT true NOT NULL,
  "config_json" text,
  "capabilities_json" text DEFAULT '[]' NOT NULL,
  "rpc_token_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_instances_deployment_package_unique" UNIQUE ("deployment_id", "package_id")
);
