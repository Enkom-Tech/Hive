ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "gateway_metering_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_gateway_metering_key_uidx" ON "cost_events" ("gateway_metering_key") WHERE "gateway_metering_key" IS NOT NULL;
