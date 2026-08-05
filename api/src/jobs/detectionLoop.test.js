import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActiveOutageSet,
  DARK_DEBOUNCE_MS,
  runDetectionOnce,
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

test('runtime creates one feeder incident when every DT under a feeder is dark', async () => {
  const now = new Date('2026-08-04T10:00:20.000Z');
  const persistedIncidents = [];
  let dtLocalizationCalls = 0;

  const result = await runDetectionOnce({
    db: {},
    now,
    fetchScheduledOutages: async () => [],
    fetchConfirmedDarkPoles: async () => [
      darkPole({ poleId: 'A1', dtId: 'DT-A', feederId: 'F-01' }),
      darkPole({ poleId: 'A2', dtId: 'DT-A', feederId: 'F-01' }),
      darkPole({ poleId: 'B1', dtId: 'DT-B', feederId: 'F-01' }),
      darkPole({ poleId: 'B2', dtId: 'DT-B', feederId: 'F-01' }),
    ],
    localizeFaultsForFeeder: async (feederId, options) => {
      assert.equal(feederId, 'F-01');
      assert.deepEqual(new Set(options.confirmedDarkPoleIds), new Set([
        'A1',
        'A2',
        'B1',
        'B2',
      ]));

      return {
        feederId,
        incidents: [
          makeIncident({
            type: 'feeder',
            dtId: null,
            feederId,
            affectedPoleIds: ['A1', 'A2', 'B1', 'B2'],
          }),
        ],
        healthFlags: [],
        suppressedByOutage: false,
        suppressedBy: null,
      };
    },
    localizeFaultsForDt: async () => {
      dtLocalizationCalls += 1;
      throw new Error('per-DT localization should be skipped');
    },
    persistLocalizedIncidents: async (_database, incidents) => {
      persistedIncidents.push(...incidents);

      return {
        createdIncidentCount: incidents.length,
        updatedIncidentCount: 0,
      };
    },
    markOpenFeederIncidentsDowngraded: async () => ({
      downgradedFeederIncidentCount: 0,
    }),
    autoVerifyIncidents: async () => ({ verifiedIncidentCount: 0 }),
  });

  assert.equal(dtLocalizationCalls, 0);
  assert.equal(persistedIncidents.length, 1);
  assert.equal(persistedIncidents[0].type, 'feeder');
  assert.equal(result.checkedFeederCount, 1);
  assert.equal(result.createdIncidentCount, 1);
  assert.equal(result.updatedIncidentCount, 0);
});

test('runtime downgrades stale feeder scope before localizing remaining dark DTs', async () => {
  const now = new Date('2026-08-04T10:00:20.000Z');
  const downgradedFeederIds = [];
  const dtLocalizationCalls = [];
  const persistedIncidents = [];

  const result = await runDetectionOnce({
    db: {},
    now,
    fetchScheduledOutages: async () => [],
    fetchConfirmedDarkPoles: async () => [
      darkPole({ poleId: 'A1', dtId: 'DT-A', feederId: 'F-01' }),
      darkPole({ poleId: 'A2', dtId: 'DT-A', feederId: 'F-01' }),
    ],
    localizeFaultsForFeeder: async (feederId) => ({
      feederId,
      incidents: [],
      healthFlags: [],
      suppressedByOutage: false,
      suppressedBy: null,
    }),
    markOpenFeederIncidentsDowngraded: async (_database, feederIds) => {
      downgradedFeederIds.push(...feederIds);

      return { downgradedFeederIncidentCount: feederIds.length };
    },
    localizeFaultsForDt: async (dtId) => {
      dtLocalizationCalls.push(dtId);

      return {
        incidents: [
          makeIncident({
            type: 'dt',
            dtId,
            feederId: 'F-01',
            affectedPoleIds: ['A1', 'A2'],
          }),
        ],
      };
    },
    persistLocalizedIncidents: async (_database, incidents) => {
      persistedIncidents.push(...incidents);

      return {
        createdIncidentCount: incidents.length,
        updatedIncidentCount: 0,
      };
    },
    autoVerifyIncidents: async () => ({ verifiedIncidentCount: 0 }),
  });

  assert.deepEqual(downgradedFeederIds, ['F-01']);
  assert.deepEqual(dtLocalizationCalls, ['DT-A']);
  assert.equal(persistedIncidents.length, 1);
  assert.equal(persistedIncidents[0].type, 'dt');
  assert.equal(result.downgradedFeederIncidentCount, 1);
  assert.equal(result.createdIncidentCount, 1);
});

function event(input) {
  return {
    deviceTs: new Date(input.receivedAt),
    receivedAt: new Date(input.receivedAt),
    ...input,
  };
}

function darkPole({ poleId, dtId, feederId }) {
  return {
    poleId,
    dtId,
    feederId,
    lastSeenTs: new Date('2026-08-04T10:00:10.000Z'),
    lastSeq: 20,
  };
}

function makeIncident({ type, dtId, feederId, affectedPoleIds }) {
  return {
    type,
    dtId,
    feederId,
    boundaryPoleId: null,
    boundaryParentId: null,
    lat: 12.9716,
    lon: 77.5946,
    pincode: '560001',
    affectedPoleCount: affectedPoleIds.length,
    affectedPoleIds,
    confidence: 0.9,
    confidenceReason: 'test incident',
    topologySource: 'surveyed',
  };
}
