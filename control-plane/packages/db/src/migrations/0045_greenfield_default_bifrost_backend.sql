-- Greenfield default (ADR 006b): board mints sk-bf-* for the default deployment when backend is bifrost.
-- If this cluster uses ONLY infra/model-gateway-go, revert:
--   UPDATE hive_deployments SET model_gateway_backend = 'hive_router' WHERE id = 'a0000000-0000-4000-8000-000000000001'::uuid;
--   ALTER TABLE hive_deployments ALTER COLUMN model_gateway_backend SET DEFAULT 'hive_router';

UPDATE "hive_deployments"
SET "model_gateway_backend" = 'bifrost'
WHERE "id" = 'a0000000-0000-4000-8000-000000000001'::uuid;

ALTER TABLE "hive_deployments" ALTER COLUMN "model_gateway_backend" SET DEFAULT 'bifrost';
