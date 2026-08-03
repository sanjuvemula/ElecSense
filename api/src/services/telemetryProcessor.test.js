import assert from 'node:assert/strict';
import test from 'node:test';

import { processTelemetryEvent } from './telemetryProcessor.js';

const baseEvent = {
  deviceId: 'KSPDB-SD07-DT-001-0001',
  poleId: 'P-024431',
  event: 'power_lost',
  energized: false,
  deviceTs: new Date('2026-07-29T02:14:07.412Z'),
  seq: 88_213,
  batteryMv: 3480,
  rssi: -91,
  fwVersion: '1.4.2',
};

test('accepts a fresh event and creates current-state updates', () => {
  const result = processTelemetryEvent(baseEvent, { lastSeq: 88_212 });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'accepted');
  assert.equal(result.poleUpdate.lastState, 'dark');
  assert.equal(result.deviceUpdate.lastSeq, 88_213);
});

test('logs but ignores duplicate or stale non-boot events', () => {
  const result = processTelemetryEvent(baseEvent, { lastSeq: 88_213 });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'duplicate_or_stale_seq');
  assert.equal(result.telemetryRow.seq, 88_213);
  assert.equal(result.poleUpdate, null);
  assert.equal(result.deviceUpdate, null);
});

test('always accepts boot events even when seq resets to zero', () => {
  const bootEvent = {
    ...baseEvent,
    event: 'boot',
    energized: true,
    seq: 0,
  };
  const result = processTelemetryEvent(bootEvent, { lastSeq: 88_213 });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'boot_seq_reset');
  assert.equal(result.deviceUpdate.lastBootAt, bootEvent.deviceTs);
  assert.equal(result.poleUpdate.lastState, 'live');
});
