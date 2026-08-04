ALTER TABLE "telemetry_events" ADD COLUMN "device_ts_second" timestamp with time zone;--> statement-breakpoint
UPDATE "telemetry_events"
SET "device_ts_second" = date_trunc('second', "device_ts");--> statement-breakpoint
DELETE FROM "telemetry_events" AS duplicate
USING "telemetry_events" AS original
WHERE
  duplicate."id" > original."id"
  AND duplicate."device_id" = original."device_id"
  AND duplicate."seq" = original."seq"
  AND duplicate."device_ts_second" = original."device_ts_second";--> statement-breakpoint
ALTER TABLE "telemetry_events" ALTER COLUMN "device_ts_second" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_events_device_seq_ts_second_unique" ON "telemetry_events" USING btree ("device_id","seq","device_ts_second");
