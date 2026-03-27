-- Model gateway backend per deployment (hive_router = model-gateway-go tokens; bifrost = Bifrost sk-bf-* from governance API).
ALTER TABLE "hive_deployments" ADD COLUMN IF NOT EXISTS "model_gateway_backend" text NOT NULL DEFAULT 'hive_router';

-- Per-key kind and optional Bifrost row id (from POST /api/governance/virtual-keys response).
ALTER TABLE "gateway_virtual_keys" ADD COLUMN IF NOT EXISTS "key_kind" text NOT NULL DEFAULT 'hive_router';
ALTER TABLE "gateway_virtual_keys" ADD COLUMN IF NOT EXISTS "bifrost_virtual_key_id" text;

DO $$ BEGIN
 ALTER TABLE "gateway_virtual_keys" ADD CONSTRAINT "gateway_virtual_keys_key_kind_check" CHECK ("key_kind" IN ('hive_router', 'bifrost'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
