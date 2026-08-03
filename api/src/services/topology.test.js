import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTopologyForDt } from './topology.js';

const origin = { lat: 12.9716, lon: 77.5946 };
const dt = {
  dtId: 'DT-TEST',
  lat: origin.lat.toFixed(7),
  lon: origin.lon.toFixed(7),
};

test('infers a straight line of ten poles', () => {
  const poles = Array.from({ length: 10 }, (_, index) =>
    pole(`P-${index + 1}`, (index + 1) * 50, 0),
  );
  const tree = buildTopologyForDt({ dt, poles });

  assert.equal(tree.topologySource, 'inferred');
  assert.equal(tree.root.children[0], 'P-1');

  for (let index = 2; index <= 10; index += 1) {
    assert.equal(tree.nodes[`P-${index}`].parentPoleId, `P-${index - 1}`);
  }
});

test('infers a line with one branch', () => {
  const tree = buildTopologyForDt({
    dt,
    poles: [
      pole('P-1', 50, 0),
      pole('P-2', 100, 0),
      pole('P-3', 150, 0),
      pole('P-4', 200, 0),
      pole('B-1', 100, 45),
      pole('B-2', 100, 95),
    ],
  });

  assert.equal(tree.nodes['P-2'].parentPoleId, 'P-1');
  assert.equal(tree.nodes['B-1'].parentPoleId, 'P-2');
  assert.equal(tree.nodes['B-2'].parentPoleId, 'B-1');
});

test('infers a branch with its own branch', () => {
  const tree = buildTopologyForDt({
    dt,
    poles: [
      pole('P-1', 50, 0),
      pole('P-2', 100, 0),
      pole('P-3', 150, 0),
      pole('S-1', 100, 45),
      pole('S-2', 100, 95),
      pole('T-1', 145, 95),
      pole('T-2', 195, 95),
    ],
  });

  assert.equal(tree.nodes['S-1'].parentPoleId, 'P-2');
  assert.equal(tree.nodes['S-2'].parentPoleId, 'S-1');
  assert.equal(tree.nodes['T-1'].parentPoleId, 'S-2');
  assert.equal(tree.nodes['T-2'].parentPoleId, 'T-1');
});

test('documents the nearest-neighbor failure mode across adjacent lines', () => {
  const tree = buildTopologyForDt({
    dt,
    poles: [
      pole('A-1', 50, 0),
      pole('A-2', 100, 0),
      pole('A-3', 150, 0),
      pole('A-4', 110, 150),
      pole('B-1', 100, 50),
      pole('B-2', 100, 100),
      pole('B-3', 100, 150),
    ],
  });

  assert.equal(tree.nodes['B-3'].parentPoleId, 'B-2');

  // In real surveyed topology, A-4 could belong to A-3's line. Pure geometry
  // cannot know that when A-4 is only 10m from B-3, so the MST joins it there.
  assert.equal(tree.nodes['A-4'].parentPoleId, 'B-3');
  assert.notEqual(tree.nodes['A-4'].parentPoleId, 'A-3');
});

function pole(poleId, eastMeters, northMeters) {
  const coordinate = offsetFromOrigin(eastMeters, northMeters);

  return {
    poleId,
    lat: coordinate.lat.toFixed(7),
    lon: coordinate.lon.toFixed(7),
    dtId: dt.dtId,
    seqOnLine: null,
    parentPoleId: null,
    inferredParentId: null,
    inferredSeq: null,
    topologyConfidence: null,
  };
}

function offsetFromOrigin(eastMeters, northMeters) {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon =
    metersPerDegreeLat * Math.cos(toRadians(origin.lat));

  return {
    lat: origin.lat + northMeters / metersPerDegreeLat,
    lon: origin.lon + eastMeters / metersPerDegreeLon,
  };
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}
