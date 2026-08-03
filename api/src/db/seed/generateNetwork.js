import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import seedrandom from 'seedrandom';

import { devices, dts, feeders, poles, scheduledOutages } from '../schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SEED = 240731;
const DEFAULT_REFERENCE_NOW = '2026-08-03T12:00:00+05:30';
const DEFAULT_GROUND_TRUTH_PATH = path.join(__dirname, 'groundTruth.json');
const POLE_ID_START = 24431;
const TARGET_POLE_MIN = 3000;
const TARGET_POLE_MAX = 5000;
const INSERT_CHUNK_SIZE = 500;

const feederNames = [
  'MG Road Feeder',
  'Indiranagar Feeder',
  'Jayanagar Feeder',
  'Peenya Feeder',
];

const pincodePool = [
  '560001',
  '560008',
  '560011',
  '560038',
  '560043',
  '560058',
  '560066',
  '560078',
  '560085',
  '560100',
];

const outageReasons = [
  'planned maintenance',
  'line clearance',
  'transformer inspection',
  'load balancing',
  'vegetation trimming',
  'emergency isolation drill',
];

const feederAnchors = [
  { lat: 12.9766, lon: 77.5993 },
  { lat: 12.9784, lon: 77.6408 },
  { lat: 12.925, lon: 77.5938 },
  { lat: 13.0298, lon: 77.5141 },
];

export function createSyntheticNetwork(options = {}) {
  const seed = normalizeSeed(options.seed);
  const rng = seedrandom(String(seed));
  const referenceNow = new Date(options.referenceNow ?? DEFAULT_REFERENCE_NOW);
  const feederCount = randomInt(rng, 3, 4);
  const dtCount = 20;
  const poleCounts = generatePoleCounts(rng, dtCount);
  const dtAssignments = spreadDtsAcrossFeeders(rng, feederCount, dtCount);

  const generatedFeeders = Array.from({ length: feederCount }, (_, index) => ({
    feederId: `F-${String(index + 1).padStart(2, '0')}`,
    name: feederNames[index],
  }));

  const generatedDts = [];
  const generatedPoles = [];
  const groundTruthPoles = [];

  let dtIndex = 0;
  let poleIndex = 0;

  for (const [feederIndex, feederDtCount] of dtAssignments.entries()) {
    const feeder = generatedFeeders[feederIndex];
    const anchor = feederAnchors[feederIndex];
    const feederAngle = randomFloat(rng, 0, Math.PI * 2);

    for (
      let localDtIndex = 0;
      localDtIndex < feederDtCount;
      localDtIndex += 1
    ) {
      dtIndex += 1;

      const dtId = `DT-${String(dtIndex).padStart(3, '0')}`;
      const poleCount = poleCounts[dtIndex - 1];
      const dtLocation = jitterLocation(
        rng,
        anchor,
        450 + localDtIndex * randomFloat(rng, 180, 360),
        feederAngle + randomFloat(rng, -0.75, 0.75),
      );
      const pincodeChoices = pickDtPincodes(rng);
      const dt = {
        dtId,
        feederId: feeder.feederId,
        lat: toCoordinate(dtLocation.lat),
        lon: toCoordinate(dtLocation.lon),
        capacityKva: pickCapacityKva(rng),
        householdsServed: randomInt(rng, 85, 620),
      };

      generatedDts.push(dt);

      const topology = buildDtTopology({
        rng,
        dt,
        poleCount,
        nextPole: () => {
          poleIndex += 1;
          return `P-${String(POLE_ID_START + poleIndex - 1).padStart(6, '0')}`;
        },
        pincodeChoices,
      });

      generatedPoles.push(...topology.poles);
      groundTruthPoles.push(...topology.groundTruth);
    }
  }

  const strippedDtIds = new Set(
    weightedSample(
      rng,
      generatedDts.map((dt) => ({ item: dt.dtId, weight: 1 })),
      Math.round(generatedDts.length * 0.6),
    ),
  );

  for (const pole of generatedPoles) {
    if (strippedDtIds.has(pole.dtId)) {
      pole.seqOnLine = null;
      pole.parentPoleId = null;
    }
  }

  const noDevicePoleIds = new Set(
    weightedSample(
      rng,
      groundTruthPoles.map((pole) => ({
        item: pole.poleId,
        weight: pole.deviceGapWeight,
      })),
      Math.round(generatedPoles.length * 0.09),
    ),
  );
  const deviceSequenceByDt = new Map();
  const generatedDevices = [];

  for (const pole of generatedPoles) {
    if (noDevicePoleIds.has(pole.poleId)) {
      continue;
    }

    const nextDeviceSeq = (deviceSequenceByDt.get(pole.dtId) ?? 0) + 1;
    deviceSequenceByDt.set(pole.dtId, nextDeviceSeq);

    const deviceId = `KSPDB-SD07-${pole.dtId}-${String(nextDeviceSeq).padStart(4, '0')}`;
    pole.deviceId = deviceId;

    generatedDevices.push({
      deviceId,
      poleId: pole.poleId,
      fwVersion: pickFirmwareVersion(rng),
      batteryMv: clamp(Math.round(normal(rng, 3850, 115)), 3600, 4100),
      rssi: Math.round(randomFloat(rng, -100, -60)),
      lastBootAt: randomPastDate(rng, referenceNow, 1, 120),
    });
  }

  for (const truth of groundTruthPoles) {
    const pole = generatedPoles.find(
      (candidate) => candidate.poleId === truth.poleId,
    );
    truth.deviceId = pole.deviceId;
    truth.publicSeqOnLine = pole.seqOnLine;
    truth.publicParentPoleId = pole.parentPoleId;
    truth.topologyExposed = !strippedDtIds.has(pole.dtId);
    delete truth.deviceGapWeight;
  }

  const generatedOutages = buildScheduledOutages({
    rng,
    referenceNow,
    feeders: generatedFeeders,
    dts: generatedDts,
  });

  return {
    seed,
    referenceNow: referenceNow.toISOString(),
    feeders: generatedFeeders,
    dts: generatedDts,
    poles: generatedPoles,
    devices: generatedDevices,
    scheduledOutages: generatedOutages,
    groundTruth: {
      seed,
      referenceNow: referenceNow.toISOString(),
      utility: 'Karnataka State Power Distribution Board',
      counts: {
        feeders: generatedFeeders.length,
        dts: generatedDts.length,
        poles: generatedPoles.length,
        devices: generatedDevices.length,
        scheduledOutages: generatedOutages.length,
      },
      strippedDtIds: Array.from(strippedDtIds).sort(),
      poles: groundTruthPoles,
    },
  };
}

export async function generateNetwork(db, options = {}) {
  const network = createSyntheticNetwork(options);
  const groundTruthPath = options.groundTruthPath ?? DEFAULT_GROUND_TRUTH_PATH;

  await db.transaction(async (tx) => {
    await insertRows(tx, feeders, network.feeders);
    await insertRows(tx, dts, network.dts);
    await insertRows(tx, poles, network.poles);
    await insertRows(tx, devices, network.devices);
    await insertRows(tx, scheduledOutages, network.scheduledOutages);
  });

  await mkdir(path.dirname(groundTruthPath), { recursive: true });
  await writeFile(
    groundTruthPath,
    `${JSON.stringify(network.groundTruth, null, 2)}\n`,
    'utf8',
  );

  return {
    seed: network.seed,
    counts: network.groundTruth.counts,
    strippedDtIds: network.groundTruth.strippedDtIds,
    groundTruthPath,
  };
}

function buildDtTopology({ rng, dt, poleCount, nextPole, pincodeChoices }) {
  const branchCount = clamp(
    Math.round(randomFloat(rng, 1, Math.min(5, 1 + poleCount / 45))),
    1,
    5,
  );
  const trunkCount = clamp(
    Math.round(poleCount * randomFloat(rng, 0.48, 0.66)),
    branchCount + 2,
    poleCount - branchCount,
  );
  const branchLengths = splitPositiveInteger(
    rng,
    poleCount - trunkCount,
    branchCount,
  );
  const baseAngle = randomFloat(rng, 0, Math.PI * 2);
  const polesForDt = [];
  const truthForDt = [];
  const trunkPoles = [];

  let current = {
    lat: Number(dt.lat),
    lon: Number(dt.lon),
  };

  for (let seq = 1; seq <= trunkCount; seq += 1) {
    current = stepFrom(rng, current, baseAngle, 30, 80);

    const parentPoleId =
      seq === 1 ? null : trunkPoles[trunkPoles.length - 1].poleId;
    const pole = createPoleRow({
      poleId: nextPole(),
      feederId: dt.feederId,
      dtId: dt.dtId,
      location: current,
      seqOnLine: seq,
      parentPoleId,
      pincode: pickPolePincode(rng, pincodeChoices),
    });

    polesForDt.push(pole);
    trunkPoles.push(pole);
    truthForDt.push(
      createTruthRow({
        pole,
        trueSeqOnLine: seq,
        trueParentPoleId: parentPoleId,
        lineId: `${dt.dtId}-TRUNK`,
        lineKind: 'trunk',
        linePositionRatio: seq / trunkCount,
        isTip: seq === trunkCount,
      }),
    );
  }

  for (const [branchIndex, branchLength] of branchLengths.entries()) {
    const splitIndex = randomInt(rng, 1, Math.max(1, trunkPoles.length - 2));
    const splitPole = trunkPoles[splitIndex - 1];
    const turn = randomChoice(rng, [-1, 1]) * randomFloat(rng, 0.65, 1.9);
    const branchAngle = baseAngle + turn + randomFloat(rng, -0.25, 0.25);

    current = {
      lat: Number(splitPole.lat),
      lon: Number(splitPole.lon),
    };

    let upstreamPoleId = splitPole.poleId;

    for (let seq = 1; seq <= branchLength; seq += 1) {
      current = stepFrom(rng, current, branchAngle, 30, 80);

      const pole = createPoleRow({
        poleId: nextPole(),
        feederId: dt.feederId,
        dtId: dt.dtId,
        location: current,
        seqOnLine: seq,
        parentPoleId: upstreamPoleId,
        pincode: pickPolePincode(rng, pincodeChoices),
      });

      polesForDt.push(pole);
      truthForDt.push(
        createTruthRow({
          pole,
          trueSeqOnLine: seq,
          trueParentPoleId: upstreamPoleId,
          lineId: `${dt.dtId}-SPUR-${String(branchIndex + 1).padStart(2, '0')}`,
          lineKind: 'spur',
          linePositionRatio: seq / branchLength,
          isTip: seq === branchLength,
        }),
      );

      upstreamPoleId = pole.poleId;
    }
  }

  return {
    poles: polesForDt,
    groundTruth: truthForDt,
  };
}

function createPoleRow({
  poleId,
  feederId,
  dtId,
  location,
  seqOnLine,
  parentPoleId,
  pincode,
}) {
  return {
    poleId,
    lat: toCoordinate(location.lat),
    lon: toCoordinate(location.lon),
    feederId,
    dtId,
    seqOnLine,
    parentPoleId,
    inferredParentId: null,
    inferredSeq: null,
    pincode,
    deviceId: null,
    lastState: 'unknown',
    lastSeenTs: null,
    lastSeq: 0,
  };
}

function createTruthRow({
  pole,
  trueSeqOnLine,
  trueParentPoleId,
  lineId,
  lineKind,
  linePositionRatio,
  isTip,
}) {
  return {
    poleId: pole.poleId,
    feederId: pole.feederId,
    dtId: pole.dtId,
    lat: pole.lat,
    lon: pole.lon,
    pincode: pole.pincode,
    trueSeqOnLine,
    trueParentPoleId,
    lineId,
    lineKind,
    isTip,
    deviceId: null,
    publicSeqOnLine: pole.seqOnLine,
    publicParentPoleId: pole.parentPoleId,
    topologyExposed: true,
    deviceGapWeight: 1 + linePositionRatio * 3 + (isTip ? 3 : 0),
  };
}

function generatePoleCounts(rng, dtCount) {
  const highLoadCount = Math.round(dtCount * 0.45);
  const lowLoadCount = dtCount - highLoadCount;
  const counts = [
    ...Array.from({ length: lowLoadCount }, () =>
      clamp(Math.round(logNormal(rng, Math.log(70), 0.18)), 9, 80),
    ),
    ...Array.from({ length: highLoadCount }, () =>
      clamp(Math.round(logNormal(rng, Math.log(232), 0.13)), 150, 240),
    ),
  ];

  shuffle(rng, counts);

  while (sum(counts) < TARGET_POLE_MIN) {
    const highLoadGrowableIndexes = counts
      .map((count, index) => ({ count, index }))
      .filter(({ count }) => count >= 120 && count < 240);
    const lowerHalfGrowableIndexes = counts
      .map((count, index) => ({ count, index }))
      .filter(({ count }) => count < 80);
    const anyGrowableIndexes = counts
      .map((count, index) => ({ count, index }))
      .filter(({ count }) => count < 240);
    const growableIndexes =
      highLoadGrowableIndexes.length > 0
        ? highLoadGrowableIndexes
        : lowerHalfGrowableIndexes.length > 0
          ? lowerHalfGrowableIndexes
          : anyGrowableIndexes;
    const selected = randomChoice(rng, growableIndexes);

    counts[selected.index] = Math.min(
      selected.count >= 120 ? 240 : 90,
      counts[selected.index] + randomInt(rng, 1, 8),
    );
  }

  while (sum(counts) > TARGET_POLE_MAX) {
    const shrinkableIndexes = counts
      .map((count, index) => ({ count, index }))
      .filter(({ count }) => count > 9);
    const selected = randomChoice(rng, shrinkableIndexes);

    counts[selected.index] = Math.max(
      9,
      counts[selected.index] - randomInt(rng, 1, 8),
    );
  }

  return counts;
}

function spreadDtsAcrossFeeders(rng, feederCount, dtCount) {
  const assignments = Array.from({ length: feederCount }, () =>
    Math.floor(dtCount / feederCount),
  );
  let remaining = dtCount - sum(assignments);
  const feederIndexes = assignments.map((_, index) => index);

  shuffle(rng, feederIndexes);

  for (const feederIndex of feederIndexes) {
    if (remaining === 0) {
      break;
    }

    assignments[feederIndex] += 1;
    remaining -= 1;
  }

  return assignments;
}

function buildScheduledOutages({
  rng,
  referenceNow,
  feeders: feederRows,
  dts: dtRows,
}) {
  const outages = [];
  const addOutage = ({ index, scope, targetId, startsAt, endsAt }) => {
    outages.push({
      id: `SO-${String(index).padStart(4, '0')}`,
      scope,
      targetId,
      startsAt,
      endsAt,
      reason: randomChoice(rng, outageReasons),
      isCancelled: rng() < 0.08,
    });
  };

  addOutage({
    index: 1,
    scope: 'feeder',
    targetId: randomChoice(rng, feederRows).feederId,
    startsAt: addMinutes(referenceNow, -randomInt(rng, 45, 180)),
    endsAt: addMinutes(referenceNow, randomInt(rng, 45, 240)),
  });
  addOutage({
    index: 2,
    scope: 'dt',
    targetId: randomChoice(rng, dtRows).dtId,
    startsAt: addMinutes(referenceNow, -randomInt(rng, 20, 90)),
    endsAt: addMinutes(referenceNow, randomInt(rng, 30, 180)),
  });

  for (let index = 3; index <= 7; index += 1) {
    const isFuture = rng() < 0.65;
    const startOffsetHours = isFuture
      ? randomInt(rng, 12, 240)
      : -randomInt(rng, 12, 240);
    const durationMinutes = randomInt(rng, 90, 420);
    const startsAt = addMinutes(referenceNow, startOffsetHours * 60);
    const scope = rng() < 0.45 ? 'feeder' : 'dt';
    const targetId =
      scope === 'feeder'
        ? randomChoice(rng, feederRows).feederId
        : randomChoice(rng, dtRows).dtId;

    addOutage({
      index,
      scope,
      targetId,
      startsAt,
      endsAt: addMinutes(startsAt, durationMinutes),
    });
  }

  return outages;
}

async function insertRows(db, table, rows) {
  for (const chunk of chunks(rows, INSERT_CHUNK_SIZE)) {
    await db.insert(table).values(chunk);
  }
}

function pickFirmwareVersion(rng) {
  if (rng() < 0.08) {
    return '1.2.x';
  }

  return rng() < 0.7 ? '1.4.2' : '1.3.1';
}

function pickCapacityKva(rng) {
  return randomChoice(rng, [63, 100, 160, 250, 315, 500]);
}

function pickDtPincodes(rng) {
  const first = randomChoice(rng, pincodePool);

  if (rng() < 0.35) {
    const second = randomChoice(
      rng,
      pincodePool.filter((pincode) => pincode !== first),
    );

    return [first, second];
  }

  return [first];
}

function pickPolePincode(rng, pincodeChoices) {
  if (rng() < 0.03) {
    return null;
  }

  if (pincodeChoices.length === 1) {
    return pincodeChoices[0];
  }

  return rng() < 0.72 ? pincodeChoices[0] : pincodeChoices[1];
}

function randomPastDate(rng, referenceDate, minDaysAgo, maxDaysAgo) {
  const minutesAgo = randomInt(rng, minDaysAgo * 24 * 60, maxDaysAgo * 24 * 60);

  return addMinutes(referenceDate, -minutesAgo);
}

function splitPositiveInteger(rng, total, parts) {
  if (parts === 1) {
    return [total];
  }

  const weights = Array.from({ length: parts }, () =>
    randomFloat(rng, 0.4, 1.8),
  );
  let remaining = total;
  const result = [];

  for (let index = 0; index < parts; index += 1) {
    const partsLeft = parts - index;

    if (partsLeft === 1) {
      result.push(remaining);
      break;
    }

    const raw = Math.round((total * weights[index]) / sum(weights));
    const value = clamp(raw, 1, remaining - (partsLeft - 1));
    result.push(value);
    remaining -= value;
  }

  return result;
}

function weightedSample(rng, weightedItems, count) {
  const pool = [...weightedItems];
  const selected = [];

  while (selected.length < count && pool.length > 0) {
    const totalWeight = pool.reduce((total, entry) => total + entry.weight, 0);
    let threshold = rng() * totalWeight;
    const index = pool.findIndex((entry) => {
      threshold -= entry.weight;
      return threshold <= 0;
    });
    const [entry] = pool.splice(index === -1 ? pool.length - 1 : index, 1);

    selected.push(entry.item);
  }

  return selected;
}

function jitterLocation(rng, anchor, distanceMeters, angleRadians) {
  return moveCoordinate(
    anchor.lat,
    anchor.lon,
    distanceMeters * randomFloat(rng, 0.25, 1.1),
    angleRadians,
  );
}

function stepFrom(rng, location, angleRadians, minMeters, maxMeters) {
  const distanceMeters = randomFloat(rng, minMeters, maxMeters);
  const jitteredAngle = angleRadians + normal(rng, 0, 0.12);

  return moveCoordinate(
    location.lat,
    location.lon,
    distanceMeters,
    jitteredAngle,
  );
}

function moveCoordinate(lat, lon, distanceMeters, angleRadians) {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(toRadians(lat));
  const deltaLat =
    (Math.cos(angleRadians) * distanceMeters) / metersPerDegreeLat;
  const deltaLon =
    (Math.sin(angleRadians) * distanceMeters) / metersPerDegreeLon;

  return {
    lat: lat + deltaLat,
    lon: lon + deltaLon,
  };
}

function normal(rng, mean = 0, standardDeviation = 1) {
  const first = Math.max(rng(), Number.EPSILON);
  const second = Math.max(rng(), Number.EPSILON);
  const magnitude = Math.sqrt(-2 * Math.log(first));
  const z = magnitude * Math.cos(2 * Math.PI * second);

  return mean + z * standardDeviation;
}

function logNormal(rng, mean, standardDeviation) {
  return Math.exp(normal(rng, mean, standardDeviation));
}

function randomInt(rng, min, max) {
  return Math.floor(randomFloat(rng, min, max + 1));
}

function randomFloat(rng, min, max) {
  return rng() * (max - min) + min;
}

function randomChoice(rng, values) {
  return values[randomInt(rng, 0, values.length - 1)];
}

function shuffle(rng, values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(rng, 0, index);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }

  return values;
}

function chunks(values, size) {
  const result = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function toCoordinate(value) {
  return value.toFixed(7);
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function normalizeSeed(seed) {
  const numericSeed = Number(seed ?? DEFAULT_SEED);

  if (!Number.isFinite(numericSeed)) {
    throw new Error(`Invalid seed value: ${seed}`);
  }

  return numericSeed;
}
