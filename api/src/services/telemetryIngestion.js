import { count, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { devices, poles, telemetryEvents } from '../db/schema.js';
import {
  processTelemetryEvent,
  telemetryEventTypes,
} from './telemetryProcessor.js';

const telemetryInputSchema = z.object({
  device_id: z.string().min(1),
  pole_id: z.string().min(1),
  event: z.enum(telemetryEventTypes),
  energized: z.boolean(),
  ts: z.string().datetime({ offset: true }),
  seq: z.number().int().nonnegative(),
  battery_mv: z.number().int(),
  rssi: z.number().int(),
  fw: z.string().min(1),
});

const telemetryPayloadSchema = z.union([
  telemetryInputSchema,
  z.array(telemetryInputSchema).min(1).max(10_000),
]);

const INSERT_CHUNK_SIZE = 1000;

export function parseTelemetryPayload(body) {
  const result = telemetryPayloadSchema.safeParse(body);

  if (!result.success) {
    return {
      ok: false,
      message: z.prettifyError(result.error),
    };
  }

  const inputs = Array.isArray(result.data) ? result.data : [result.data];

  return {
    ok: true,
    events: inputs.map(normalizeTelemetryInput),
  };
}

export async function ingestTelemetryEvents(db, events) {
  const telemetryRows = events.map(
    (event) => processTelemetryEvent(event).telemetryRow,
  );
  const insertedKeys = await insertTelemetryRows(db, telemetryRows);
  const storedEvents = filterEventsByInsertedKeys(events, insertedKeys);

  if (storedEvents.length === 0) {
    return {
      stored: 0,
      accepted: 0,
      ignored: events.length,
    };
  }

  const [deviceStates, knownPoleIds] = await Promise.all([
    loadDeviceStates(
      db,
      storedEvents.map((event) => event.deviceId),
    ),
    loadKnownPoleIds(
      db,
      storedEvents.map((event) => event.poleId),
    ),
  ]);
  const decisions = buildTelemetryDecisions(storedEvents, deviceStates);
  const acceptedDecisions = decisions.filter((decision) => decision.accepted);

  if (acceptedDecisions.length > 0) {
    await applyCurrentStateUpdates(db, acceptedDecisions, knownPoleIds);
  }

  return {
    stored: storedEvents.length,
    accepted: acceptedDecisions.length,
    ignored: events.length - acceptedDecisions.length,
  };
}

export async function getTelemetryStats(db, now = new Date()) {
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [
    [{ value: eventsLastMinute }],
    [{ value: eventsLastHour }],
    [{ value: darkPoles }],
    [{ value: livePoles }],
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(telemetryEvents)
      .where(gte(telemetryEvents.receivedAt, oneMinuteAgo)),
    db
      .select({ value: count() })
      .from(telemetryEvents)
      .where(gte(telemetryEvents.receivedAt, oneHourAgo)),
    db
      .select({ value: count() })
      .from(poles)
      .where(eq(poles.lastState, 'dark')),
    db
      .select({ value: count() })
      .from(poles)
      .where(eq(poles.lastState, 'live')),
  ]);

  return {
    eventsLastMinute,
    eventsLastHour,
    darkPoles,
    livePoles,
  };
}

function normalizeTelemetryInput(input) {
  return {
    deviceId: input.device_id,
    poleId: input.pole_id,
    event: input.event,
    energized: input.energized,
    deviceTs: new Date(input.ts),
    seq: input.seq,
    batteryMv: input.battery_mv,
    rssi: input.rssi,
    fwVersion: input.fw,
  };
}

function buildTelemetryDecisions(events, initialDeviceStates) {
  const deviceStates = new Map(initialDeviceStates);

  return events.map((event) => {
    const decision = processTelemetryEvent(
      event,
      deviceStates.get(event.deviceId),
    );

    if (decision.accepted) {
      deviceStates.set(event.deviceId, { lastSeq: event.seq });
    }

    return decision;
  });
}

async function loadDeviceStates(db, deviceIds) {
  const uniqueDeviceIds = unique(deviceIds);

  if (uniqueDeviceIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      deviceId: devices.deviceId,
      lastSeq: devices.lastSeq,
    })
    .from(devices)
    .where(inArray(devices.deviceId, uniqueDeviceIds));

  return new Map(rows.map((row) => [row.deviceId, { lastSeq: row.lastSeq }]));
}

async function loadKnownPoleIds(db, poleIds) {
  const uniquePoleIds = unique(poleIds);

  if (uniquePoleIds.length === 0) {
    return new Set();
  }

  const rows = await db
    .select({ poleId: poles.poleId })
    .from(poles)
    .where(inArray(poles.poleId, uniquePoleIds));

  return new Set(rows.map((row) => row.poleId));
}

async function applyCurrentStateUpdates(db, decisions, knownPoleIds) {
  const deviceUpdates = collapseDeviceUpdates(decisions, knownPoleIds);
  const poleUpdates = collapsePoleUpdates(decisions);

  await Promise.all([
    upsertDeviceUpdates(db, deviceUpdates),
    updatePoleStates(db, poleUpdates),
  ]);
}

function collapseDeviceUpdates(decisions, knownPoleIds) {
  const updates = new Map();

  for (const decision of decisions) {
    const update = decision.deviceUpdate;
    const previous = updates.get(update.deviceId);

    updates.set(update.deviceId, {
      ...update,
      poleId: knownPoleIds.has(update.poleId) ? update.poleId : null,
      lastBootAt: update.lastBootAt ?? previous?.lastBootAt ?? null,
      isBoot: update.isBoot || previous?.isBoot === true,
    });
  }

  return Array.from(updates.values());
}

function collapsePoleUpdates(decisions) {
  const updates = new Map();

  for (const decision of decisions) {
    const update = decision.poleUpdate;
    const previous = updates.get(update.poleId);

    updates.set(update.poleId, {
      ...update,
      isBoot: update.isBoot || previous?.isBoot === true,
    });
  }

  return Array.from(updates.values());
}

async function upsertDeviceUpdates(db, updates) {
  for (const chunk of chunks(updates, INSERT_CHUNK_SIZE)) {
    await db
      .insert(devices)
      .values(chunk.map(toDeviceInsertRow))
      .onConflictDoUpdate({
        target: devices.deviceId,
        set: {
          poleId: sql`coalesce(excluded.pole_id, ${devices.poleId})`,
          fwVersion: sql`excluded.fw_version`,
          batteryMv: sql`excluded.battery_mv`,
          rssi: sql`excluded.rssi`,
          lastBootAt: sql`coalesce(excluded.last_boot_at, ${devices.lastBootAt})`,
          lastSeq: sql`excluded.last_seq`,
        },
        setWhere: sql`${devices.lastSeq} < excluded.last_seq or excluded.last_boot_at is not null`,
      });
  }
}

async function updatePoleStates(db, updates) {
  for (const chunk of chunks(updates, INSERT_CHUNK_SIZE)) {
    const values = sql.join(
      chunk.map(
        (update) =>
          sql`(${update.poleId}, ${update.lastState}, ${update.lastSeenTs}, ${update.lastSeq}, ${update.isBoot})`,
      ),
      sql`, `,
    );

    await db.execute(sql`
      update ${poles}
      set
        last_state = incoming.last_state,
        last_seen_ts = incoming.last_seen_ts,
        last_seq = incoming.last_seq
      from (
        values ${values}
      ) as incoming(
        pole_id,
        last_state,
        last_seen_ts,
        last_seq,
        is_boot
      )
      where
        ${poles.poleId} = incoming.pole_id
        and (${poles.lastSeq} < incoming.last_seq or incoming.is_boot = true)
    `);
  }
}

async function insertTelemetryRows(db, rows) {
  const insertedKeys = [];

  for (const chunk of chunks(rows, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(telemetryEvents)
      .values(chunk)
      .onConflictDoNothing({
        target: [
          telemetryEvents.deviceId,
          telemetryEvents.seq,
          telemetryEvents.deviceTsSecond,
        ],
      })
      .returning({
        deviceId: telemetryEvents.deviceId,
        seq: telemetryEvents.seq,
        deviceTsSecond: telemetryEvents.deviceTsSecond,
      });

    insertedKeys.push(
      ...inserted.map((row) =>
        telemetryDedupKey(row.deviceId, row.seq, row.deviceTsSecond),
      ),
    );
  }

  return insertedKeys;
}

function toDeviceInsertRow(update) {
  return {
    deviceId: update.deviceId,
    poleId: update.poleId,
    fwVersion: update.fwVersion,
    batteryMv: update.batteryMv,
    rssi: update.rssi,
    lastBootAt: update.lastBootAt,
    lastSeq: update.lastSeq,
  };
}

function chunks(values, size) {
  const result = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

function unique(values) {
  return Array.from(new Set(values));
}

function filterEventsByInsertedKeys(events, insertedKeys) {
  const remainingByKey = new Map();

  for (const key of insertedKeys) {
    remainingByKey.set(key, (remainingByKey.get(key) ?? 0) + 1);
  }

  return events.filter((event) => {
    const key = telemetryDedupKey(
      event.deviceId,
      event.seq,
      truncateToSecond(event.deviceTs),
    );
    const remaining = remainingByKey.get(key) ?? 0;

    if (remaining === 0) {
      return false;
    }

    remainingByKey.set(key, remaining - 1);

    return true;
  });
}

function telemetryDedupKey(deviceId, seq, deviceTsSecond) {
  return `${deviceId}|${seq}|${normalizeDate(deviceTsSecond).toISOString()}`;
}

function truncateToSecond(value) {
  const date = normalizeDate(value);

  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function normalizeDate(value) {
  return value instanceof Date ? value : new Date(value);
}
