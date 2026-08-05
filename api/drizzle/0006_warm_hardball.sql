CREATE SEQUENCE "incidents_incident_number_seq";--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "incident_number" integer;--> statement-breakpoint
WITH numbered_incidents AS (
  SELECT
    "id",
    row_number() OVER (ORDER BY "detected_at" ASC, "id" ASC)::integer AS "incident_number"
  FROM "incidents"
)
UPDATE "incidents"
SET "incident_number" = numbered_incidents."incident_number"
FROM numbered_incidents
WHERE "incidents"."id" = numbered_incidents."id";--> statement-breakpoint
SELECT setval(
  '"incidents_incident_number_seq"',
  COALESCE((SELECT max("incident_number") FROM "incidents"), 0) + 1,
  false
);--> statement-breakpoint
ALTER TABLE "incidents" ALTER COLUMN "incident_number" SET DEFAULT nextval('"incidents_incident_number_seq"');--> statement-breakpoint
ALTER TABLE "incidents" ALTER COLUMN "incident_number" SET NOT NULL;--> statement-breakpoint
ALTER SEQUENCE "incidents_incident_number_seq" OWNED BY "incidents"."incident_number";--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_incident_number_unique" UNIQUE("incident_number");
