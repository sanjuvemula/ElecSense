import assert from 'node:assert/strict';
import test from 'node:test';

import { devices, poles, telemetryEvents } from '../db/schema.js';
import {
  ingestTelemetryEvents,
  parseTelemetryPayload,
} from './telemetryIngestion.js';

test('stores a duplicate telemetry retry only once', async () => {
  const db = new InMemoryTelemetryDb();
  const body = telemetryBody({
    seq: 100,
    ts: '2026-08-05T10:00:00.250Z',
  });

  const first = await sendTelemetryRequest(db, body);
  const second = await sendTelemetryRequest(db, body);

  assert.equal(first.stored, 1);
  assert.equal(second.stored, 0);
  assert.equal(db.telemetryEventRows.length, 1);
});

test('stores legitimate sequence reuse after a boot reset', async () => {
  const db = new InMemoryTelemetryDb();

  await sendTelemetryRequest(
    db,
    telemetryBody({
      event: 'heartbeat',
      energized: true,
      seq: 100,
      ts: '2026-08-05T10:00:00.000Z',
    }),
  );
  await sendTelemetryRequest(
    db,
    telemetryBody({
      event: 'boot',
      energized: true,
      seq: 0,
      ts: '2026-08-05T10:01:00.000Z',
    }),
  );
  const reused = await sendTelemetryRequest(
    db,
    telemetryBody({
      event: 'heartbeat',
      energized: true,
      seq: 0,
      ts: '2026-08-05T10:01:03.000Z',
    }),
  );

  assert.equal(reused.stored, 1);
  assert.equal(db.telemetryEventRows.length, 3);
  assert.equal(
    db.telemetryEventRows.filter((row) => row.deviceId === deviceId && row.seq === 0)
      .length,
    2,
  );
});

const deviceId = 'KSPDB-SD07-DT-001-0001';
const poleId = 'P-024431';

async function sendTelemetryRequest(db, body) {
  const parsed = parseTelemetryPayload(body);

  assert.equal(parsed.ok, true);

  return ingestTelemetryEvents(db, parsed.events);
}

function telemetryBody(overrides = {}) {
  return {
    device_id: deviceId,
    pole_id: poleId,
    event: 'heartbeat',
    energized: true,
    ts: '2026-08-05T10:00:00.000Z',
    seq: 1,
    battery_mv: 3890,
    rssi: -72,
    fw: '1.4.2',
    ...overrides,
  };
}

class InMemoryTelemetryDb {
  constructor() {
    this.telemetryEventRows = [];
    this.deviceRows = new Map();
    this.poleRows = new Map([
      [
        poleId,
        {
          poleId,
          lastState: 'unknown',
          lastSeenTs: null,
          lastSeq: 0,
        },
      ],
    ]);
    this.nextTelemetryId = 1;
  }

  insert(table) {
    return new InsertBuilder(this, table);
  }

  select() {
    return {
      from: (table) => ({
        where: async () => {
          if (table === devices) {
            return Array.from(this.deviceRows.values());
          }

          if (table === poles) {
            return Array.from(this.poleRows.values());
          }

          return [];
        },
      }),
    };
  }

  async execute() {}
}

class InsertBuilder {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.rows = [];
  }

  values(rows) {
    this.rows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  onConflictDoNothing() {
    const inserted = [];

    if (this.table !== telemetryEvents) {
      return {
        returning: async () => inserted,
      };
    }

    for (const row of this.rows) {
      const dedupKey = telemetryDedupKey(row);
      const alreadyStored = this.db.telemetryEventRows.some(
        (stored) => telemetryDedupKey(stored) === dedupKey,
      );

      if (alreadyStored) {
        continue;
      }

      const stored = {
        ...row,
        id: this.db.nextTelemetryId,
      };

      this.db.nextTelemetryId += 1;
      this.db.telemetryEventRows.push(stored);
      inserted.push(stored);
    }

    return {
      returning: async () => inserted,
    };
  }

  async onConflictDoUpdate() {
    if (this.table !== devices) {
      return;
    }

    for (const row of this.rows) {
      const existing = this.db.deviceRows.get(row.deviceId);

      if (
        !existing ||
        existing.lastSeq < row.lastSeq ||
        row.lastBootAt !== null
      ) {
        this.db.deviceRows.set(row.deviceId, {
          ...existing,
          ...row,
        });
      }
    }
  }
}

function telemetryDedupKey(row) {
  return [
    row.deviceId,
    row.seq,
    normalizeDate(row.deviceTsSecond).toISOString(),
  ].join('|');
}

function normalizeDate(value) {
  return value instanceof Date ? value : new Date(value);
}
