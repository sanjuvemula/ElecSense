import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActiveOutageSet,
  DARK_DEBOUNCE_MS,
  selectConfirmedDarkPoles,
  summarizeCurrentDarkRun,
} from './detectionLoop.js';

test('active outage set applies grace before and after planned window', () => {
  const now = new Date('2026-08-04T10:00:00.000Z');
  const result = buildActiveOutageSet(
    [
      {
        id: 'SO-1',
        scope: 'dt',
        targetId: 'D0112',
        startsAt: new Date('2026-08-04T10:10:00.000Z'),
        endsAt: new Date('2026-08-04T11:00:00.000Z'),
        isCancelled: false,
      },
      {
        id: 'SO-2',
        scope: 'feeder',
        targetId: 'F-01',
        startsAt: new Date('2026-08-04T08:00:00.000Z'),
        endsAt: new Date('2026-08-04T09:20:00.000Z'),
        isCancelled: false,
      },
      {
        id: 'SO-3',
        scope: 'dt',
        targetId: 'D0220',
        startsAt: new Date('2026-08-04T09:00:00.000Z'),
        endsAt: new Date('2026-08-04T12:00:00.000Z'),
        isCancelled: true,
      },
    ],
    now,
  );

  assert.equal(result.keys.has('dt:D0112'), true);
  assert.equal(result.keys.has('feeder:F-01'), true);
  assert.equal(result.keys.has('dt:D0220'), false);
});

test('explicit power_lost confirms a dark pole immediately', () => {
  const now = new Date('2026-08-04T10:00:20.000Z');
  const darkPoles = [
    {
      poleId: 'P-000001',
      lastSeenTs: new Date('2026-08-04T10:00:19.000Z'),
      lastSeq: 20,
    },
  ];
  const confirmed = selectConfirmedDarkPoles({
    darkPoles,
    recentEvents: [
      event({
        poleId: 'P-000001',
        event: 'power_lost',
        energized: false,
        seq: 20,
        receivedAt: '2026-08-04T10:00:19.000Z',
      }),
    ],
    now,
  });

  assert.deepEqual(
    confirmed.map((pole) => pole.poleId),
    ['P-000001'],
  );
});

test('dark heartbeat under debounce is ignored until it stays dark', () => {
  const now = new Date('2026-08-04T10:00:20.000Z');
  const darkPoles = [
    {
      poleId: 'P-000001',
      lastSeenTs: new Date('2026-08-04T10:00:10.000Z'),
      lastSeq: 20,
    },
  ];
  const confirmed = selectConfirmedDarkPoles({
    darkPoles,
    recentEvents: [
      event({
        poleId: 'P-000001',
        event: 'heartbeat',
        energized: false,
        seq: 20,
        receivedAt: '2026-08-04T10:00:10.000Z',
      }),
    ],
    now,
  });

  assert.equal(confirmed.length, 0);
});

test('dark run start comes from telemetry history, not only last_seen_ts', () => {
  const now = new Date('2026-08-04T10:01:00.000Z');
  const summary = summarizeCurrentDarkRun(
    {
      poleId: 'P-000001',
      lastSeenTs: new Date('2026-08-04T10:00:55.000Z'),
      lastSeq: 12,
    },
    [
      event({
        poleId: 'P-000001',
        event: 'power_restored',
        energized: true,
        seq: 8,
        receivedAt: '2026-08-04T09:59:00.000Z',
      }),
      event({
        poleId: 'P-000001',
        event: 'heartbeat',
        energized: false,
        seq: 9,
        receivedAt: '2026-08-04T10:00:00.000Z',
      }),
      event({
        poleId: 'P-000001',
        event: 'heartbeat',
        energized: false,
        seq: 12,
        receivedAt: '2026-08-04T10:00:55.000Z',
      }),
    ],
  );
  const confirmed = selectConfirmedDarkPoles({
    darkPoles: [
      {
        poleId: 'P-000001',
        lastSeenTs: new Date('2026-08-04T10:00:55.000Z'),
        lastSeq: 12,
      },
    ],
    recentEvents: [
      event({
        poleId: 'P-000001',
        event: 'heartbeat',
        energized: false,
        seq: 9,
        receivedAt: '2026-08-04T10:00:00.000Z',
      }),
      event({
        poleId: 'P-000001',
        event: 'heartbeat',
        energized: false,
        seq: 12,
        receivedAt: '2026-08-04T10:00:55.000Z',
      }),
    ],
    now,
    debounceMs: DARK_DEBOUNCE_MS,
  });

  assert.equal(summary.startedAt.toISOString(), '2026-08-04T10:00:00.000Z');
  assert.deepEqual(
    confirmed.map((pole) => pole.poleId),
    ['P-000001'],
  );
});

function event(input) {
  return {
    deviceTs: new Date(input.receivedAt),
    receivedAt: new Date(input.receivedAt),
    ...input,
  };
}
