ALTER TABLE "incidents" ADD COLUMN "dispatch_note" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "dispatch_note_source" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "dispatch_note_fingerprint" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_dispatch_note_source_check" CHECK ("incidents"."dispatch_note_source" in ('llm', 'template-fallback'));