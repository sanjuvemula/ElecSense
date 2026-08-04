import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const coordinate = { precision: 10, scale: 7 };
const confidenceValue = { precision: 5, scale: 4 };
const timestampTz = (name) => timestamp(name, { withTimezone: true });

export const feeders = pgTable('feeders', {
  feederId: text('feeder_id').primaryKey(),
  name: text('name').notNull(),
});

export const dts = pgTable(
  'dts',
  {
    dtId: text('dt_id').primaryKey(),
    feederId: text('feeder_id')
      .notNull()
      .references(() => feeders.feederId),
    lat: numeric('lat', coordinate).notNull(),
    lon: numeric('lon', coordinate).notNull(),
    capacityKva: integer('capacity_kva').notNull(),
    householdsServed: integer('households_served').notNull(),
  },
  (table) => [index('dts_feeder_id_idx').on(table.feederId)],
);

export const poles = pgTable(
  'poles',
  {
    poleId: text('pole_id').primaryKey(),
    lat: numeric('lat', coordinate).notNull(),
    lon: numeric('lon', coordinate).notNull(),
    feederId: text('feeder_id')
      .notNull()
      .references(() => feeders.feederId),
    dtId: text('dt_id')
      .notNull()
      .references(() => dts.dtId),
    seqOnLine: integer('seq_on_line'),
    parentPoleId: text('parent_pole_id'),
    inferredParentId: text('inferred_parent_id'),
    inferredSeq: integer('inferred_seq'),
    topologyConfidence: numeric('topology_confidence', confidenceValue),
    pincode: text('pincode'),
    deviceId: text('device_id').unique('poles_device_id_unique'),
    lastState: text('last_state', {
      enum: ['live', 'dark', 'unknown'],
    })
      .notNull()
      .default('unknown'),
    lastSeenTs: timestampTz('last_seen_ts'),
    lastSeq: integer('last_seq').default(0),
  },
  (table) => [
    index('poles_feeder_id_idx').on(table.feederId),
    index('poles_dt_id_idx').on(table.dtId),
    index('poles_parent_pole_id_idx').on(table.parentPoleId),
    index('poles_inferred_parent_id_idx').on(table.inferredParentId),
    index('poles_pincode_idx').on(table.pincode),
    index('poles_last_state_idx').on(table.lastState),
    foreignKey({
      name: 'poles_parent_pole_id_fk',
      columns: [table.parentPoleId],
      foreignColumns: [table.poleId],
    }),
    foreignKey({
      name: 'poles_inferred_parent_id_fk',
      columns: [table.inferredParentId],
      foreignColumns: [table.poleId],
    }),
    check(
      'poles_last_state_check',
      sql`${table.lastState} in ('live', 'dark', 'unknown')`,
    ),
  ],
);

export const devices = pgTable(
  'devices',
  {
    deviceId: text('device_id').primaryKey(),
    poleId: text('pole_id').references(() => poles.poleId),
    fwVersion: text('fw_version').notNull(),
    batteryMv: integer('battery_mv').notNull(),
    rssi: integer('rssi').notNull(),
    lastBootAt: timestampTz('last_boot_at'),
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (table) => [index('devices_pole_id_idx').on(table.poleId)],
);

export const telemetryEvents = pgTable(
  'telemetry_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    deviceId: text('device_id').notNull(),
    poleId: text('pole_id').notNull(),
    event: text('event', {
      enum: ['heartbeat', 'power_lost', 'power_restored', 'boot'],
    }).notNull(),
    energized: boolean('energized').notNull(),
    deviceTs: timestampTz('device_ts').notNull(),
    deviceTsSecond: timestampTz('device_ts_second').notNull(),
    seq: integer('seq').notNull(),
    batteryMv: integer('battery_mv'),
    rssi: integer('rssi'),
    receivedAt: timestampTz('received_at').notNull().defaultNow(),
  },
  (table) => [
    index('telemetry_events_device_id_seq_idx').on(table.deviceId, table.seq),
    // Device sequence numbers reset after boot, but duplicate MQTT/HTTP retries
    // should carry the same device timestamp. Until we model boot generations
    // explicitly, this stored second-bucket event identity rejects true duplicate
    // retries while still allowing legitimate sequence reuse in a new lifetime.
    uniqueIndex('telemetry_events_device_seq_ts_second_unique').on(
      table.deviceId,
      table.seq,
      table.deviceTsSecond,
    ),
    index('telemetry_events_pole_id_device_ts_idx').on(
      table.poleId,
      table.deviceTs,
    ),
    check(
      'telemetry_events_event_check',
      sql`${table.event} in ('heartbeat', 'power_lost', 'power_restored', 'boot')`,
    ),
  ],
);

export const scheduledOutages = pgTable(
  'scheduled_outages',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['feeder', 'dt'] }).notNull(),
    targetId: text('target_id').notNull(),
    startsAt: timestampTz('starts_at').notNull(),
    endsAt: timestampTz('ends_at').notNull(),
    reason: text('reason').notNull(),
    isCancelled: boolean('is_cancelled').notNull().default(false),
  },
  (table) => [
    index('scheduled_outages_scope_target_id_idx').on(
      table.scope,
      table.targetId,
    ),
    index('scheduled_outages_starts_at_ends_at_idx').on(
      table.startsAt,
      table.endsAt,
    ),
    check(
      'scheduled_outages_scope_check',
      sql`${table.scope} in ('feeder', 'dt')`,
    ),
  ],
);

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: text('type', {
      enum: ['span', 'dt', 'feeder', 'sensor_fault'],
    }).notNull(),
    dtId: text('dt_id').references(() => dts.dtId),
    feederId: text('feeder_id').references(() => feeders.feederId),
    boundaryPoleId: text('boundary_pole_id').references(() => poles.poleId),
    boundaryParentId: text('boundary_parent_id').references(() => poles.poleId),
    lat: numeric('lat', coordinate),
    lon: numeric('lon', coordinate),
    pincode: text('pincode'),
    affectedPoleCount: integer('affected_pole_count').notNull(),
    confidence: numeric('confidence', confidenceValue).notNull(),
    confidenceReason: text('confidence_reason').notNull(),
    topologySource: text('topology_source', {
      enum: ['surveyed', 'inferred', 'unknown'],
    }).notNull(),
    dispatchNote: text('dispatch_note'),
    dispatchNoteSource: text('dispatch_note_source', {
      enum: ['llm', 'template-fallback'],
    }),
    dispatchNoteFingerprint: text('dispatch_note_fingerprint'),
    status: text('status', {
      enum: [
        'detected',
        'acknowledged',
        'crew_assigned',
        'resolved',
        'verified',
        'closed',
      ],
    })
      .notNull()
      .default('detected'),
    detectedAt: timestampTz('detected_at').notNull(),
    acknowledgedAt: timestampTz('acknowledged_at'),
    crewAssignedAt: timestampTz('crew_assigned_at'),
    resolvedAt: timestampTz('resolved_at'),
    verifiedAt: timestampTz('verified_at'),
    closedAt: timestampTz('closed_at'),
  },
  (table) => [
    index('incidents_dt_id_idx').on(table.dtId),
    index('incidents_feeder_id_idx').on(table.feederId),
    index('incidents_boundary_pole_id_idx').on(table.boundaryPoleId),
    index('incidents_boundary_parent_id_idx').on(table.boundaryParentId),
    index('incidents_status_idx').on(table.status),
    index('incidents_detected_at_idx').on(table.detectedAt),
    index('incidents_pincode_idx').on(table.pincode),
    check(
      'incidents_type_check',
      sql`${table.type} in ('span', 'dt', 'feeder', 'sensor_fault')`,
    ),
    check(
      'incidents_confidence_check',
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    check(
      'incidents_topology_source_check',
      sql`${table.topologySource} in ('surveyed', 'inferred', 'unknown')`,
    ),
    check(
      'incidents_dispatch_note_source_check',
      sql`${table.dispatchNoteSource} in ('llm', 'template-fallback')`,
    ),
    check(
      'incidents_status_check',
      sql`${table.status} in ('detected', 'acknowledged', 'crew_assigned', 'resolved', 'verified', 'closed')`,
    ),
  ],
);

export const incidentPoles = pgTable(
  'incident_poles',
  {
    incidentId: uuid('incident_id').notNull(),
    poleId: text('pole_id')
      .notNull()
      .references(() => poles.poleId),
  },
  (table) => [
    primaryKey({
      name: 'incident_poles_pk',
      columns: [table.incidentId, table.poleId],
    }),
    foreignKey({
      name: 'incident_poles_incident_id_fk',
      columns: [table.incidentId],
      foreignColumns: [incidents.id],
    }).onDelete('cascade'),
    index('incident_poles_pole_id_idx').on(table.poleId),
  ],
);

export const incidentEvents = pgTable(
  'incident_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestampTz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('incident_events_incident_id_created_at_idx').on(
      table.incidentId,
      table.createdAt,
    ),
  ],
);

export const feedersRelations = relations(feeders, ({ many }) => ({
  dts: many(dts),
  poles: many(poles),
  incidents: many(incidents),
}));

export const dtsRelations = relations(dts, ({ one, many }) => ({
  feeder: one(feeders, {
    fields: [dts.feederId],
    references: [feeders.feederId],
  }),
  poles: many(poles),
  incidents: many(incidents),
}));

export const polesRelations = relations(poles, ({ one, many }) => ({
  feeder: one(feeders, {
    fields: [poles.feederId],
    references: [feeders.feederId],
  }),
  dt: one(dts, {
    fields: [poles.dtId],
    references: [dts.dtId],
  }),
  parentPole: one(poles, {
    fields: [poles.parentPoleId],
    references: [poles.poleId],
    relationName: 'pole_parent',
  }),
  childPoles: many(poles, {
    relationName: 'pole_parent',
  }),
  inferredParent: one(poles, {
    fields: [poles.inferredParentId],
    references: [poles.poleId],
    relationName: 'pole_inferred_parent',
  }),
  inferredChildren: many(poles, {
    relationName: 'pole_inferred_parent',
  }),
  currentDevice: one(devices, {
    fields: [poles.deviceId],
    references: [devices.deviceId],
    relationName: 'pole_current_device',
  }),
  assignedDevices: many(devices, {
    relationName: 'device_assigned_pole',
  }),
  telemetryEvents: many(telemetryEvents),
  incidentsAsBoundary: many(incidents, {
    relationName: 'incident_boundary_pole',
  }),
  incidentsAsBoundaryParent: many(incidents, {
    relationName: 'incident_boundary_parent',
  }),
  incidentPoles: many(incidentPoles),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  pole: one(poles, {
    fields: [devices.poleId],
    references: [poles.poleId],
    relationName: 'device_assigned_pole',
  }),
  poleWithCurrentDevice: many(poles, {
    relationName: 'pole_current_device',
  }),
  telemetryEvents: many(telemetryEvents),
}));

export const telemetryEventsRelations = relations(
  telemetryEvents,
  ({ one }) => ({
    device: one(devices, {
      fields: [telemetryEvents.deviceId],
      references: [devices.deviceId],
    }),
    pole: one(poles, {
      fields: [telemetryEvents.poleId],
      references: [poles.poleId],
    }),
  }),
);

export const incidentsRelations = relations(incidents, ({ one, many }) => ({
  dt: one(dts, {
    fields: [incidents.dtId],
    references: [dts.dtId],
  }),
  feeder: one(feeders, {
    fields: [incidents.feederId],
    references: [feeders.feederId],
  }),
  boundaryPole: one(poles, {
    fields: [incidents.boundaryPoleId],
    references: [poles.poleId],
    relationName: 'incident_boundary_pole',
  }),
  boundaryParent: one(poles, {
    fields: [incidents.boundaryParentId],
    references: [poles.poleId],
    relationName: 'incident_boundary_parent',
  }),
  incidentPoles: many(incidentPoles),
  events: many(incidentEvents),
}));

export const incidentPolesRelations = relations(incidentPoles, ({ one }) => ({
  incident: one(incidents, {
    fields: [incidentPoles.incidentId],
    references: [incidents.id],
  }),
  pole: one(poles, {
    fields: [incidentPoles.poleId],
    references: [poles.poleId],
  }),
}));

export const incidentEventsRelations = relations(incidentEvents, ({ one }) => ({
  incident: one(incidents, {
    fields: [incidentEvents.incidentId],
    references: [incidents.id],
  }),
}));
