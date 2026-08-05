CREATE TABLE "app_metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "silenced_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"pole_id" text,
	"reason" text DEFAULT 'simulator dead sensor' NOT NULL,
	"silenced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "silenced_devices" ADD CONSTRAINT "silenced_devices_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "silenced_devices" ADD CONSTRAINT "silenced_devices_pole_id_poles_pole_id_fk" FOREIGN KEY ("pole_id") REFERENCES "public"."poles"("pole_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "silenced_devices_pole_id_idx" ON "silenced_devices" USING btree ("pole_id");