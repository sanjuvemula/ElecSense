CREATE TABLE "devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"pole_id" text,
	"fw_version" text NOT NULL,
	"battery_mv" integer NOT NULL,
	"rssi" integer NOT NULL,
	"last_boot_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dts" (
	"dt_id" text PRIMARY KEY NOT NULL,
	"feeder_id" text NOT NULL,
	"lat" numeric(10, 7) NOT NULL,
	"lon" numeric(10, 7) NOT NULL,
	"capacity_kva" integer NOT NULL,
	"households_served" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feeders" (
	"feeder_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_poles" (
	"incident_id" uuid NOT NULL,
	"pole_id" text NOT NULL,
	CONSTRAINT "incident_poles_pk" PRIMARY KEY("incident_id","pole_id")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"dt_id" text,
	"feeder_id" text,
	"boundary_pole_id" text,
	"boundary_parent_id" text,
	"lat" numeric(10, 7),
	"lon" numeric(10, 7),
	"pincode" text,
	"affected_pole_count" integer NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"confidence_reason" text NOT NULL,
	"topology_source" text NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"crew_assigned_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "incidents_type_check" CHECK ("incidents"."type" in ('span', 'dt', 'feeder', 'sensor_fault')),
	CONSTRAINT "incidents_confidence_check" CHECK ("incidents"."confidence" >= 0 and "incidents"."confidence" <= 1),
	CONSTRAINT "incidents_topology_source_check" CHECK ("incidents"."topology_source" in ('surveyed', 'inferred', 'unknown')),
	CONSTRAINT "incidents_status_check" CHECK ("incidents"."status" in ('detected', 'acknowledged', 'crew_assigned', 'resolved', 'verified', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "poles" (
	"pole_id" text PRIMARY KEY NOT NULL,
	"lat" numeric(10, 7) NOT NULL,
	"lon" numeric(10, 7) NOT NULL,
	"feeder_id" text NOT NULL,
	"dt_id" text NOT NULL,
	"seq_on_line" integer,
	"parent_pole_id" text,
	"inferred_parent_id" text,
	"inferred_seq" integer,
	"pincode" text,
	"device_id" text,
	"last_state" text DEFAULT 'unknown' NOT NULL,
	"last_seen_ts" timestamp with time zone,
	"last_seq" integer DEFAULT 0,
	CONSTRAINT "poles_device_id_unique" UNIQUE("device_id"),
	CONSTRAINT "poles_last_state_check" CHECK ("poles"."last_state" in ('live', 'dark', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "scheduled_outages" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"target_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"is_cancelled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "scheduled_outages_scope_check" CHECK ("scheduled_outages"."scope" in ('feeder', 'dt'))
);
--> statement-breakpoint
CREATE TABLE "telemetry_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"pole_id" text NOT NULL,
	"event" text NOT NULL,
	"energized" boolean NOT NULL,
	"device_ts" timestamp with time zone NOT NULL,
	"seq" integer NOT NULL,
	"battery_mv" integer,
	"rssi" integer,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_events_event_check" CHECK ("telemetry_events"."event" in ('heartbeat', 'power_lost', 'power_restored', 'boot'))
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_pole_id_poles_pole_id_fk" FOREIGN KEY ("pole_id") REFERENCES "public"."poles"("pole_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dts" ADD CONSTRAINT "dts_feeder_id_feeders_feeder_id_fk" FOREIGN KEY ("feeder_id") REFERENCES "public"."feeders"("feeder_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_poles" ADD CONSTRAINT "incident_poles_pole_id_poles_pole_id_fk" FOREIGN KEY ("pole_id") REFERENCES "public"."poles"("pole_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_poles" ADD CONSTRAINT "incident_poles_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_dt_id_dts_dt_id_fk" FOREIGN KEY ("dt_id") REFERENCES "public"."dts"("dt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_feeder_id_feeders_feeder_id_fk" FOREIGN KEY ("feeder_id") REFERENCES "public"."feeders"("feeder_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_boundary_pole_id_poles_pole_id_fk" FOREIGN KEY ("boundary_pole_id") REFERENCES "public"."poles"("pole_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_boundary_parent_id_poles_pole_id_fk" FOREIGN KEY ("boundary_parent_id") REFERENCES "public"."poles"("pole_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poles" ADD CONSTRAINT "poles_feeder_id_feeders_feeder_id_fk" FOREIGN KEY ("feeder_id") REFERENCES "public"."feeders"("feeder_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poles" ADD CONSTRAINT "poles_dt_id_dts_dt_id_fk" FOREIGN KEY ("dt_id") REFERENCES "public"."dts"("dt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poles" ADD CONSTRAINT "poles_parent_pole_id_fk" FOREIGN KEY ("parent_pole_id") REFERENCES "public"."poles"("pole_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poles" ADD CONSTRAINT "poles_inferred_parent_id_fk" FOREIGN KEY ("inferred_parent_id") REFERENCES "public"."poles"("pole_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_pole_id_idx" ON "devices" USING btree ("pole_id");--> statement-breakpoint
CREATE INDEX "dts_feeder_id_idx" ON "dts" USING btree ("feeder_id");--> statement-breakpoint
CREATE INDEX "incident_events_incident_id_created_at_idx" ON "incident_events" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incident_poles_pole_id_idx" ON "incident_poles" USING btree ("pole_id");--> statement-breakpoint
CREATE INDEX "incidents_dt_id_idx" ON "incidents" USING btree ("dt_id");--> statement-breakpoint
CREATE INDEX "incidents_feeder_id_idx" ON "incidents" USING btree ("feeder_id");--> statement-breakpoint
CREATE INDEX "incidents_boundary_pole_id_idx" ON "incidents" USING btree ("boundary_pole_id");--> statement-breakpoint
CREATE INDEX "incidents_boundary_parent_id_idx" ON "incidents" USING btree ("boundary_parent_id");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "incidents_detected_at_idx" ON "incidents" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "incidents_pincode_idx" ON "incidents" USING btree ("pincode");--> statement-breakpoint
CREATE INDEX "poles_feeder_id_idx" ON "poles" USING btree ("feeder_id");--> statement-breakpoint
CREATE INDEX "poles_dt_id_idx" ON "poles" USING btree ("dt_id");--> statement-breakpoint
CREATE INDEX "poles_parent_pole_id_idx" ON "poles" USING btree ("parent_pole_id");--> statement-breakpoint
CREATE INDEX "poles_inferred_parent_id_idx" ON "poles" USING btree ("inferred_parent_id");--> statement-breakpoint
CREATE INDEX "poles_pincode_idx" ON "poles" USING btree ("pincode");--> statement-breakpoint
CREATE INDEX "poles_last_state_idx" ON "poles" USING btree ("last_state");--> statement-breakpoint
CREATE INDEX "scheduled_outages_scope_target_id_idx" ON "scheduled_outages" USING btree ("scope","target_id");--> statement-breakpoint
CREATE INDEX "scheduled_outages_starts_at_ends_at_idx" ON "scheduled_outages" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "telemetry_events_device_id_seq_idx" ON "telemetry_events" USING btree ("device_id","seq");--> statement-breakpoint
CREATE INDEX "telemetry_events_pole_id_device_ts_idx" ON "telemetry_events" USING btree ("pole_id","device_ts");