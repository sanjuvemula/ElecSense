import assert from 'node:assert/strict';
import test from 'node:test';

import {
  localizeFaultsForDtSnapshot,
  localizeFaultsForFeederSnapshot,
} from './localization.js';

const now = new Date('2026-07-29T02:30:00.000Z');
const dt = {
  dtId: 'DT-TEST',
  feederId: 'F-01',
  lat: 12.9716,
  lon: 77.5946,
};

test('single span fault on a straight line returns one incident at the boundary', () => {
  const snapshot = makeDtSnapshot({
    paths: [['P1', 'P2', 'P3', 'P4', 'P5']],
    states: {
      P1: live(),
      P2: live(),
      P3: dark(),
      P4: dark(),
      P5: dark(),
    },
  });
  const result = localizeFaultsForDtSnapshot(snapshot);

  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].type, 'span');
  assert.equal(result.incidents[0].boundaryParentId, 'P2');
  assert.equal(result.incidents[0].boundaryPoleId, 'P3');
  assert.deepEqual(result.incidents[0].affectedPoleIds, ['P3', 'P4', 'P5']);
});

test('fault on a branch leaves the live main trunk alone', () => {
  const snapshot = makeDtSnapshot({
    paths: [
      ['P1', 'P2', 'P3', 'P4'],
      ['P2', 'B1', 'B2'],
    ],
    states: {
      P1: live(),
      P2: live(),
      P3: live(),
      P4: live(),
      B1: dark(),
      B2: dark(),
    },
  });
  const result = localizeFaultsForDtSnapshot(snapshot);

  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].boundaryParentId, 'P2');
  assert.equal(result.incidents[0].boundaryPoleId, 'B1');
  assert.deepEqual(result.incidents[0].affectedPoleIds, ['B1', 'B2']);
});

test('whole DT dark creates one DT incident rather than many span incidents', () => {
  const snapshot = makeDtSnapshot({
    paths: [['P1', 'P2', 'P3']],
    states: {
      P1: dark(),
      P2: dark(),
      P3: dark(),
    },
  });
  const result = localizeFaultsForDtSnapshot(snapshot);

  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].type, 'dt');
  assert.equal(result.incidents[0].boundaryPoleId, null);
  assert.deepEqual(result.incidents[0].affectedPoleIds, ['P1', 'P2', 'P3']);
});

test('whole feeder dark creates one feeder incident', () => {
  const first = makeDtSnapshot({
    dtOverride: { dtId: 'DT-A', feederId: 'F-01' },
    paths: [['A1', 'A2']],
    states: { A1: dark(), A2: dark() },
  });
  const second = makeDtSnapshot({
    dtOverride: { dtId: 'DT-B', feederId: 'F-01' },
    paths: [['B1', 'B2']],
    states: { B1: dark(), B2: dark() },
  });
  const result = localizeFaultsForFeederSnapshot({
    feederId: 'F-01',
    dtSnapshots: [first, second],
    scheduledOutages: [],
    now,
  });

  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].type, 'feeder');
  assert.equal(result.incidents[0].dtId, null);
  assert.deepEqual(result.incidents[0].affectedPoleIds, [
    'A1',
    'A2',
    'B1',
    'B2',
  ]);
});

test('isolated dead sensor creates a health flag and no incident', () => {
  const snapshot = makeDtSnapshot({
    paths: [['P1', 'P2', 'P3', 'P4']],
    states: {
      P1: live(),
      P2: staleLive(),
      P3: live(),
      P4: live(),
    },
  });
  const result = localizeFaultsForDtSnapshot(snapshot);

  assert.equal(result.incidents.length, 0);
  assert.equal(result.healthFlags.length, 1);
  assert.equal(result.healthFlags[0].type, 'sensor_fault');
  assert.equal(result.healthFlags[0].poleId, 'P2');
});

test('active scheduled outage suppresses incidents at the DT layer', () => {
  const snapshot = makeDtSnapshot({
    paths: [['P1', 'P2']],
    states: { P1: dark(), P2: dark() },
    scheduledOutages: [
      {
        id: 'SO-1',
        scope: 'dt',
        targetId: dt.dtId,
        startsAt: new Date('2026-07-29T02:00:00.000Z'),
        endsAt: new Date('2026-07-29T03:00:00.000Z'),
        isCancelled: false,
      },
    ],
  });
  const result = localizeFaultsForDtSnapshot(snapshot);

  assert.equal(result.suppressedByOutage, true);
  assert.equal(result.incidents.length, 0);
});

test('two independent branch faults produce two incidents', () => {
  const snapshot = makeDtSnapshot({
    paths: [
      ['P1', 'P2', 'P3'],
      ['P2', 'B1', 'B2'],
      ['P2', 'C1', 'C2'],
    ],
    states: {
      P1: live(),
      P2: live(),
      P3: live(),
      B1: dark(),
      B2: dark(),
      C1: dark(),
      C2: dark(),
    },
  });
  const result = localizeFaultsForDtSnapshot(snapshot);

  assert.equal(result.incidents.length, 2);
  assert.deepEqual(
    result.incidents.map((incident) => incident.boundaryPoleId).sort(),
    ['B1', 'C1'],
  );
});

test('upstream fault masks downstream faults on the same branch', () => {
  const snapshot = makeDtSnapshot({
    paths: [['P1', 'P2', 'P3', 'P4', 'P5']],
    states: {
      P1: live(),
      P2: dark(),
      P3: dark(),
      P4: dark(),
      P5: dark(),
    },
  });
  const result = localizeFaultsForDtSnapshot(snapshot);

  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].boundaryPoleId, 'P2');
  assert.deepEqual(result.incidents[0].affectedPoleIds, [
    'P2',
    'P3',
    'P4',
    'P5',
  ]);
});

test('no-device pole at boundary returns an ambiguous range and midpoint', () => {
  const snapshot = makeDtSnapshot({
    paths: [['P1', 'P2', 'P3', 'P4']],
    states: {
      P1: live(),
      P2: noDevice(),
      P3: dark(),
      P4: dark(),
    },
  });
  const result = localizeFaultsForDtSnapshot(snapshot);
  const incident = result.incidents[0];

  assert.equal(result.incidents.length, 1);
  assert.deepEqual(incident.boundaryRange, {
    fromPoleId: 'P1',
    toPoleId: 'P3',
    poleIds: ['P1', 'P2', 'P3'],
  });
  assert.match(incident.confidenceReason, /no-device pole/);
  assert.equal(
    incident.lat,
    midpoint(snapshot.tree.nodes.P1, snapshot.tree.nodes.P3).lat,
  );
  assert.equal(
    incident.lon,
    midpoint(snapshot.tree.nodes.P1, snapshot.tree.nodes.P3).lon,
  );
});

test('known-bad inferred edge lowers confidence versus surveyed topology', () => {
  const states = {
    A1: live(),
    B1: live(),
    B2: live(),
    B3: live(),
    A4: dark(),
  };
  const inferred = makeDtSnapshot({
    topologySource: 'inferred',
    paths: [['A1'], ['B1', 'B2', 'B3', 'A4']],
    states,
    confidenceByPole: { A4: 0.2 },
  });
  const surveyed = makeDtSnapshot({
    topologySource: 'surveyed',
    paths: [['A1'], ['B1', 'B2', 'B3', 'A4']],
    states,
    confidenceByPole: { A4: 1 },
  });

  const inferredIncident = localizeFaultsForDtSnapshot(inferred).incidents[0];
  const surveyedIncident = localizeFaultsForDtSnapshot(surveyed).incidents[0];

  assert.equal(inferredIncident.boundaryPoleId, 'A4');
  assert.ok(inferredIncident.confidence < surveyedIncident.confidence);
  assert.match(inferredIncident.confidenceReason, /suspicious inferred edge/);
});

function makeDtSnapshot({
  paths,
  states,
  topologySource = 'surveyed',
  confidenceByPole = {},
  scheduledOutages = [],
  dtOverride = {},
}) {
  const snapshotDt = { ...dt, ...dtOverride };
  const tree = buildTree(paths, topologySource, confidenceByPole, snapshotDt);

  return {
    dt: snapshotDt,
    tree,
    poles: Object.keys(tree.nodes).map((poleId, index) => ({
      poleId,
      lat: tree.nodes[poleId].lat,
      lon: tree.nodes[poleId].lon,
      pincode: '560001',
      topologyConfidence: tree.nodes[poleId].topologyConfidence,
      ...states[poleId],
      deviceId: Object.hasOwn(states[poleId], 'deviceId')
        ? states[poleId].deviceId
        : `DEV-${poleId}`,
      fwVersion: states[poleId].fwVersion ?? '1.4.2',
      lastSeq: index,
    })),
    scheduledOutages,
    now,
  };
}

function buildTree(paths, topologySource, confidenceByPole, snapshotDt) {
  const nodes = {};
  const rootChildren = new Set();

  for (const path of paths) {
    for (const [index, poleId] of path.entries()) {
      const parentPoleId = index === 0 ? null : path[index - 1];
      const existingNode = nodes[poleId];

      if (!existingNode) {
        nodes[poleId] = {
          poleId,
          parentPoleId,
          children: [],
          seq: index + 1,
          depth: parentPoleId ? nodes[parentPoleId].depth + 1 : 1,
          lat: round(Number(snapshotDt.lat) + index * 0.0002, 7),
          lon: round(
            Number(snapshotDt.lon) + Object.keys(nodes).length * 0.0002,
            7,
          ),
          topologyConfidence: confidenceByPole[poleId] ?? 1,
        };
      }

      if (parentPoleId && !nodes[parentPoleId].children.includes(poleId)) {
        nodes[parentPoleId].children.push(poleId);
      }

      if (!parentPoleId && !existingNode) {
        rootChildren.add(poleId);
      }
    }
  }

  return {
    dtId: snapshotDt.dtId,
    topologySource,
    root: {
      id: snapshotDt.dtId,
      type: 'dt',
      lat: Number(snapshotDt.lat),
      lon: Number(snapshotDt.lon),
      children: Array.from(rootChildren),
    },
    nodes,
    edges: [],
  };
}

function live() {
  return {
    lastState: 'live',
    lastSeenTs: new Date(now.getTime() - 5 * 60 * 1000),
  };
}

function dark() {
  return {
    lastState: 'dark',
    lastSeenTs: new Date(now.getTime() - 3 * 60 * 1000),
  };
}

function staleLive() {
  return {
    lastState: 'live',
    lastSeenTs: new Date(now.getTime() - 45 * 60 * 1000),
  };
}

function noDevice() {
  return {
    deviceId: null,
    lastState: 'unknown',
    lastSeenTs: null,
    fwVersion: null,
  };
}

function midpoint(first, second) {
  return {
    lat: round((Number(first.lat) + Number(second.lat)) / 2, 7),
    lon: round((Number(first.lon) + Number(second.lon)) / 2, 7),
  };
}

function round(value, decimals) {
  const scale = 10 ** decimals;

  return Math.round(value * scale) / scale;
}
