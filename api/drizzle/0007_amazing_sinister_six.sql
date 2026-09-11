ALTER TABLE "incidents" DROP CONSTRAINT "incidents_status_check";--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_status_check" CHECK ("incidents"."status" in ('detected', 'acknowledged', 'crew_assigned', 'resolved', 'verified', 'superseded', 'closed'));