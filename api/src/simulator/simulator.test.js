import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTruthTree,
  collectDownstreamPoleIds,
  createFaultTelemetryPlan,
  createRepairTelemetryPlan,
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
