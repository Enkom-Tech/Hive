-- Set existing agents to managed_worker adapter and safe adapter_config
UPDATE "agents" SET adapter_type = 'managed_worker' WHERE adapter_type IS DISTINCT FROM 'managed_worker';
--> statement-breakpoint
UPDATE "agents" SET adapter_config = '{}' WHERE adapter_config IS NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN adapter_type SET DEFAULT 'managed_worker';
