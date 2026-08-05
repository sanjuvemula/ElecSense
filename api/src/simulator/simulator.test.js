import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../db/schema.js';
import {
  assertGroundTruthSeedMatches,
  buildTruthTree,
  collectDownstreamPoleIds,
  createFaultTelemetryPlan,
  createLiveHeartbeatPlan,
  createRepairTelemetryPlan,
  injectDuplicateTelemetry,
  injectOutOfOrderTelemetry,
  injectScheduledOutage,
  injectSpanFault,
} from './simulator.js';

const now = new Date('2026-08-04T10:00:00.000Z');

test('collects all poles downstream of a true topology edge', () => {
  const tree = buildTruthTree([
    truthPole('P1', null),
    truthPole('P2', 'P1'),
    truthPole('P3', 'P2'),
    truthPole('B1', 'P2'),
    truthPole('B2', 'B1'),
  ]);

  assert.deepEqual(collectDownstreamPoleIds(tree, 'P2'), [
    'B1',
    'B2',
    'P2',
    'P3',
  ]);
});

test('fault telemetry uses live baselines and never power_lost for legacy devices', () => {
  const statesByPoleId = new Map([
    ['P1', deviceState('P1', 'D1', '1.4.2')],
    ['P2', deviceState('P2', 'D2', '1.4.2')],
    ['P3', deviceState('P3', 'D3', '1.2.x')],
    ['P4', { poleId: 'P4', deviceId: null }],
  ]);
  const plan = createFaultTelemetryPlan({
    affectedPoleIds: ['P2', 'P3', 'P4'],
    baselineLivePoleIds: ['P1'],
    statesByPoleId,
    now,
    rng: repeatingRng([0.1, 0.5, 0.5, 0.5]),
  });

  assert.equal(plan.counts.liveHeartbeatEvents, 1);
  assert.equal(plan.counts.powerLostEvents, 1);
  assert.equal(
    plan.events.some(
      (event) => event.poleId === 'P3' && event.event === 'power_lost',
    ),
    false,
  );
  assert.deepEqual(plan.skipped.legacySilentPoleIds, ['P3']);
  assert.deepEqual(plan.skipped.noDevicePoleIds, ['P4']);
});

test('fault telemetry skips devices silenced by a prior dead-sensor simulation', () => {
  const statesByPoleId = new Map([
    ['P1', deviceState('P1', 'D1', '1.4.2')],
    ['P2', deviceState('P2', 'D2', '1.4.2')],
  ]);
  const plan = createFaultTelemetryPlan({
    affectedPoleIds: ['P2'],
    baselineLivePoleIds: ['P1'],
    statesByPoleId,
    silencedDeviceIds: new Set(['D1', 'D2']),
    now,
    rng: repeatingRng([0.1, 0.5, 0.5, 0.5]),
  });

  assert.equal(plan.events.length, 0);
  assert.deepEqual(plan.skipped.silencedPoleIds, ['P2']);
  assert.deepEqual(plan.skipped.silencedDeviceIds, ['D2']);
  assert.deepEqual(plan.skipped.silencedBaselinePoleIds, ['P1']);
  assert.deepEqual(plan.skipped.silencedBaselineDeviceIds, ['D1']);
});

test('live heartbeat plan excludes silenced devices from future manual batches', () => {
  const statesByPoleId = new Map([
    ['P1', deviceState('P1', 'D1', '1.4.2')],
    ['P2', deviceState('P2', 'D2', '1.4.2')],
  ]);
  const plan = createLiveHeartbeatPlan({
    poleIds: ['P1', 'P2'],
    statesByPoleId,
    silencedDeviceIds: ['D2'],
    now,
    rng: repeatingRng([0.1, 0.5, 0.5, 0.5]),
  });

  assert.deepEqual(
    plan.events.map((event) => event.deviceId),
    ['D1'],
  );
  assert.deepEqual(plan.skipped.silencedPoleIds, ['P2']);
  assert.deepEqual(plan.skipped.silencedDeviceIds, ['D2']);
});

test('repair telemetry keeps each device boot before power_restored', () => {
  const statesByPoleId = new Map([
    ['P1', deviceState('P1', 'D1', '1.4.2')],
    ['P2', deviceState('P2', 'D2', '1.4.2')],
  ]);
  const plan = createRepairTelemetryPlan({
    poleIds: ['P1', 'P2'],
    statesByPoleId,
    now,
    rng: repeatingRng([0.9, 0.1, 0.5, 0.2, 0.8]),
  });

  for (const deviceId of ['D1', 'D2']) {
    const deviceEvents = plan.events.filter(
      (event) => event.deviceId === deviceId,
    );

    assert.deepEqual(
      deviceEvents.map((event) => event.event),
      ['boot', 'power_restored'],
    );
  }
});

test('ground-truth seed mismatch fails loudly instead of regenerating fallback topology', () => {
  assert.throws(
    () =>
      assertGroundTruthSeedMatches(
        { seed: 240731 },
        '240999',
        'groundTruth.json',
      ),
    /Ground-truth seed mismatch/,
  );
});

test('missing database seed metadata fails loudly before simulator injection', () => {
  assert.throws(
    () => assertGroundTruthSeedMatches({ seed: 240731 }, null),
    /Database network seed metadata is missing/,
  );
});

test('span fault injection succeeds against a seeded database DT', async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  const groundTruthPath = process.env.GROUND_TRUTH_PATH;

  if (!databaseUrl || !groundTruthPath) {
    t.skip('requires DATABASE_URL and GROUND_TRUTH_PATH');
    return;
  }

  try {
    await access(groundTruthPath);
  } catch {
    t.skip(`requires readable ground truth at ${groundTruthPath}`);
    return;
  }

  const client = postgres(databaseUrl, { max: 1 });
  const database = drizzle(client, { schema });

  try {
    const [dt] = await database
      .select({ dtId: schema.dts.dtId })
      .from(schema.dts)
      .orderBy(schema.dts.dtId)
      .limit(1);

    assert.ok(dt, 'expected a seeded database DT');

    const result = await injectSpanFault(
      { dtId: dt.dtId },
      {
        db: database,
        groundTruthPath,
        rng: repeatingRng([0.01, 0.2, 0.3, 0.4, 0.5]),
        runDetection: false,
      },
    );

    assert.equal(result.type, 'span_fault');
    assert.equal(result.dtId, dt.dtId);
    assert.ok(result.affectedPoleCount > 0);
    assert.ok(result.telemetry.generatedEventCount > 0);
    assert.ok(result.telemetry.ingestion.stored > 0);
  } finally {
    await client.end();
  }
});

test('scheduled outage injects dark telemetry without creating incidents', async (t) => {
  const harness = await openDatabaseHarness(t, { requireGroundTruth: true });

  if (!harness) {
    return;
  }

  const { database, groundTruthPath, client } = harness;

  try {
    const target = await pickSeededDtWithDevice(database);
    const incidentTotalBefore = await countIncidents(database);
    const result = await injectScheduledOutage(
      { scope: 'dt', targetId: target.dtId },
      {
        db: database,
        groundTruthPath,
        now: new Date(),
        runDetection: true,
      },
    );
    const incidentTotalAfter = await countIncidents(database);

    assert.equal(result.type, 'scheduled_outage');
    assert.equal(result.outage.scope, 'dt');
    assert.equal(result.outage.targetId, target.dtId);
    assert.ok(result.telemetry.generatedEventCount > 0);
    assert.equal(result.detection.createdIncidentCount, 0);
    assert.equal(incidentTotalAfter, incidentTotalBefore);
  } finally {
    await client.end();
  }
});

test('duplicate telemetry demo persists only one duplicate packet', async (t) => {
  const harness = await openDatabaseHarness(t);

  if (!harness) {
    return;
  }

  const { database, client } = harness;

  try {
    const target = await pickTelemetryDemoPole(database);
    const result = await injectDuplicateTelemetry(
      { poleId: target.poleId },
      { db: database, now: new Date() },
    );
    const persistedRows = await countTelemetryRows(database, result.event);

    assert.equal(result.type, 'duplicate_telemetry');
    assert.equal(result.sent, 2);
    assert.equal(result.persisted, 1);
    assert.equal(result.deduped, 1);
    assert.equal(persistedRows, 1);
  } finally {
    await client.end();
  }
});

test('out-of-order telemetry keeps the higher sequence authoritative', async (t) => {
  const harness = await openDatabaseHarness(t);

  if (!harness) {
    return;
  }

  const { database, client } = harness;

  try {
    const target = await pickTelemetryDemoPole(database);
    const result = await injectOutOfOrderTelemetry(
      { poleId: target.poleId },
      { db: database, now: new Date() },
    );
    const [pole] = await database
      .select({ lastSeq: schema.poles.lastSeq })
      .from(schema.poles)
      .where(eq(schema.poles.poleId, target.poleId))
      .limit(1);

    assert.equal(result.type, 'out_of_order_telemetry');
    assert.deepEqual(
      result.sent.map((event) => event.seq),
      [result.winner.expectedSeq, result.winner.expectedSeq - 1],
    );
    assert.equal(result.winner.seq, result.winner.expectedSeq);
    assert.equal(pole.lastSeq, result.winner.expectedSeq);
  } finally {
    await client.end();
  }
});

async function openDatabaseHarness(t, { requireGroundTruth = false } = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  const groundTruthPath = process.env.GROUND_TRUTH_PATH;

  if (!databaseUrl) {
    t.skip('requires DATABASE_URL');
    return null;
  }

  if (requireGroundTruth && !groundTruthPath) {
    t.skip('requires GROUND_TRUTH_PATH');
    return null;
  }

  if (requireGroundTruth) {
    try {
      await access(groundTruthPath);
    } catch {
      t.skip(`requires readable ground truth at ${groundTruthPath}`);
      return null;
    }
  }

  const client = postgres(databaseUrl, { max: 1 });

  try {
    await client`select 1`;
  } catch (error) {
    await client.end().catch(() => {});
    t.skip(`requires reachable database: ${error.message}`);
    return null;
  }

  return {
    client,
    database: drizzle(client, { schema }),
    groundTruthPath,
  };
}

async function pickSeededDtWithDevice(database) {
  const row = (await fetchTelemetryDemoPoleRows(database)).find(
    (pole) => pole.dtId,
  );

  assert.ok(row?.dtId, 'expected a seeded database DT with a reporting pole');

  return row;
}

async function pickTelemetryDemoPole(database) {
  const row = (await fetchTelemetryDemoPoleRows(database))[0];

  assert.ok(row?.poleId, 'expected a seeded reporting demo pole');

  return row;
}

async function fetchTelemetryDemoPoleRows(database) {
  const [poleRows, silencedRows] = await Promise.all([
    database
      .select({
        poleId: schema.poles.poleId,
        dtId: schema.poles.dtId,
        deviceId: schema.poles.deviceId,
        fwVersion: schema.devices.fwVersion,
      })
      .from(schema.poles)
      .leftJoin(schema.devices, eq(schema.poles.deviceId, schema.devices.deviceId))
      .orderBy(schema.poles.poleId),
    database
      .select({ deviceId: schema.silencedDevices.deviceId })
      .from(schema.silencedDevices),
  ]);
  const silencedDeviceIds = new Set(silencedRows.map((row) => row.deviceId));

  return poleRows.filter(
    (pole) =>
      pole.deviceId &&
      !silencedDeviceIds.has(pole.deviceId) &&
      !pole.fwVersion?.startsWith('1.2'),
  );
}

async function countTelemetryRows(database, event) {
  const [{ value }] = await database
    .select({ value: count() })
    .from(schema.telemetryEvents)
    .where(
      and(
        eq(schema.telemetryEvents.deviceId, event.deviceId),
        eq(schema.telemetryEvents.seq, event.seq),
        eq(
          schema.telemetryEvents.deviceTsSecond,
          new Date(Math.floor(new Date(event.deviceTs).getTime() / 1000) * 1000),
        ),
      ),
    );

  return value;
}

async function countIncidents(database) {
  const [{ value }] = await database.select({ value: count() }).from(schema.incidents);

  return value;
}

function truthPole(poleId, trueParentPoleId) {
  return {
    poleId,
    feederId: 'F-01',
    dtId: 'DT-001',
    trueParentPoleId,
  };
}

function deviceState(poleId, deviceId, fwVersion) {
  return {
    poleId,
    deviceId,
    fwVersion,
    batteryMv: 3900,
    rssi: -70,
    lastSeq: 10,
    deviceLastSeq: 10,
  };
}

function repeatingRng(values) {
  let index = 0;

  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}
