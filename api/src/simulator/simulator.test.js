import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

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
