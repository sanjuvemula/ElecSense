import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { eq, inArray } from 'drizzle-orm';

import { db as defaultDb } from '../db/index.js';
import {
  appMetadata,
  devices,
  dts,
  feeders,
  incidentPoles,
  incidents,
  poles,
  scheduledOutages,
  silencedDevices,
} from '../db/schema.js';
import { runDetectionOnce } from '../jobs/detectionLoop.js';
import { ingestTelemetryEvents } from '../services/telemetryIngestion.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../db/seed/groundTruth.json',
);
const DEFAULT_POWER_LOST_PROBABILITY = 0.7;
const DEFAULT_SCHEDULED_OUTAGE_DURATION_MINUTES = 90;
const DEFAULT_BATTERY_MV = 3850;
const DEFAULT_RSSI = -72;
const DEFAULT_FIRMWARE = '1.4.2';
const SIMULATOR_EVENT_BATCH_SOURCE = 'simulator';
const NETWORK_SEED_METADATA_KEY = 'network_seed';

export async function injectSpanFault(input, options = {}) {
  const database = requireDatabase(options.db);
  const rng = options.rng ?? Math.random;
  const now = normalizeDate(options.now ?? new Date());
  const { dtId, atPoleId = null } = input ?? {};

  if (!dtId) {
    throwHttpError(400, 'dtId is required.');
  }

  const truth = await loadGroundTruth(database, options);
  const tree = buildTruthTree(truth.poles);
  const dtPoleIds = getPoleIdsForDt(tree, dtId);

  if (dtPoleIds.length === 0) {
    throwHttpError(404, `DT not found in ground-truth topology: ${dtId}`);
  }

  const currentStates = await fetchPoleDeviceStates(database, dtPoleIds);
  const silencedDeviceIds = await fetchSilencedDeviceIdsForStates(
    database,
    currentStates.statesByPoleId,
  );
  const edgePoleId =
    atPoleId ??
    pickRandomFaultablePole({
      poleIds: dtPoleIds,
      tree,
      statesByPoleId: currentStates.statesByPoleId,
      silencedDeviceIds,
      rng,
    });

  assertPoleBelongsToDt(tree, edgePoleId, dtId);

  const affectedPoleIds = collectDownstreamPoleIds(tree, edgePoleId);
  const unaffectedPoleIds = dtPoleIds.filter(
    (poleId) => !affectedPoleIds.includes(poleId),
  );
  const telemetryPlan = createFaultTelemetryPlan({
    affectedPoleIds,
    baselineLivePoleIds: unaffectedPoleIds,
    statesByPoleId: currentStates.statesByPoleId,
    silencedDeviceIds,
    now,
    rng,
  });
  const ingestion = await ingestTelemetryPlan(database, telemetryPlan);
  const detection = await maybeRunDetection(database, now, options);

  return {
    type: 'span_fault',
    dtId,
    boundaryPoleId: edgePoleId,
    boundaryParentId: tree.polesById.get(edgePoleId).trueParentPoleId,
    affectedPoleCount: affectedPoleIds.length,
    affectedPoleIds,
    telemetry: summarizeTelemetryPlan(telemetryPlan, ingestion),
    detection,
  };
}

export async function injectDtFault(input, options = {}) {
  const database = requireDatabase(options.db);
  const rng = options.rng ?? Math.random;
  const now = normalizeDate(options.now ?? new Date());
  const { dtId } = input ?? {};

  if (!dtId) {
    throwHttpError(400, 'dtId is required.');
  }

  const truth = await loadGroundTruth(database, options);
  const tree = buildTruthTree(truth.poles);
  const affectedPoleIds = getPoleIdsForDt(tree, dtId);

  if (affectedPoleIds.length === 0) {
    throwHttpError(404, `DT not found in ground-truth topology: ${dtId}`);
  }

  const currentStates = await fetchPoleDeviceStates(database, affectedPoleIds);
  const silencedDeviceIds = await fetchSilencedDeviceIdsForStates(
    database,
    currentStates.statesByPoleId,
  );
  const telemetryPlan = createFaultTelemetryPlan({
    affectedPoleIds,
    baselineLivePoleIds: [],
    statesByPoleId: currentStates.statesByPoleId,
    silencedDeviceIds,
    now,
    rng,
  });
  const ingestion = await ingestTelemetryPlan(database, telemetryPlan);
  const detection = await maybeRunDetection(database, now, options);

  return {
    type: 'dt_fault',
    dtId,
    affectedPoleCount: affectedPoleIds.length,
    affectedPoleIds,
    telemetry: summarizeTelemetryPlan(telemetryPlan, ingestion),
    detection,
  };
}

export async function injectFeederFault(input, options = {}) {
  const database = requireDatabase(options.db);
  const rng = options.rng ?? Math.random;
  const now = normalizeDate(options.now ?? new Date());
  const { feederId } = input ?? {};

  if (!feederId) {
    throwHttpError(400, 'feederId is required.');
  }

  const truth = await loadGroundTruth(database, options);
  const tree = buildTruthTree(truth.poles);
  const affectedPoleIds = getPoleIdsForFeeder(tree, feederId);

  if (affectedPoleIds.length === 0) {
    throwHttpError(
      404,
      `Feeder not found in ground-truth topology: ${feederId}`,
    );
  }

  const currentStates = await fetchPoleDeviceStates(database, affectedPoleIds);
  const silencedDeviceIds = await fetchSilencedDeviceIdsForStates(
    database,
    currentStates.statesByPoleId,
  );
  const telemetryPlan = createFaultTelemetryPlan({
    affectedPoleIds,
    baselineLivePoleIds: [],
    statesByPoleId: currentStates.statesByPoleId,
    silencedDeviceIds,
    now,
    rng,
  });
  const ingestion = await ingestTelemetryPlan(database, telemetryPlan);
  const detection = await maybeRunDetection(database, now, options);

  return {
    type: 'feeder_fault',
    feederId,
    affectedPoleCount: affectedPoleIds.length,
    affectedPoleIds,
    telemetry: summarizeTelemetryPlan(telemetryPlan, ingestion),
    detection,
  };
}

export async function injectDeadSensor(input, options = {}) {
  const database = requireDatabase(options.db);
  const rng = options.rng ?? Math.random;
  const now = normalizeDate(options.now ?? new Date());
  const { poleId } = input ?? {};

  if (!poleId) {
    throwHttpError(400, 'poleId is required.');
  }

  const truth = await loadGroundTruth(database, options);
  const tree = buildTruthTree(truth.poles);
  const pole = tree.polesById.get(poleId);

  if (!pole) {
    throwHttpError(404, `Pole not found in ground-truth topology: ${poleId}`);
  }

  const neighborPoleIds = getNeighborPoleIds(tree, poleId);
  const currentStates = await fetchPoleDeviceStates(database, [
    poleId,
    ...neighborPoleIds,
  ]);
  const target = currentStates.statesByPoleId.get(poleId);

  if (!target?.deviceId) {
    throwHttpError(409, `Pole ${poleId} does not have a device to silence.`);
  }

  await silenceDevice(database, target, now, input?.reason);
  const silencedDeviceIds = await fetchSilencedDeviceIdsForStates(
    database,
    currentStates.statesByPoleId,
  );
  const telemetryPlan = createLiveHeartbeatPlan({
    poleIds: neighborPoleIds,
    statesByPoleId: currentStates.statesByPoleId,
    silencedDeviceIds,
    now,
    rng,
  });
  const ingestion = await ingestTelemetryPlan(database, telemetryPlan);
  const detection = await maybeRunDetection(database, now, options);

  return {
    type: 'dead_sensor',
    poleId,
    deviceId: target.deviceId,
    silenced: true,
    generatedEventCount: 0,
    neighborLiveEventCount: telemetryPlan.events.length,
    message:
      'Target device was silenced without sending power_lost; live neighbor heartbeats were injected for contrast.',
    telemetry: summarizeTelemetryPlan(telemetryPlan, ingestion),
    detection,
  };
}

export async function unsilenceDevice(input, options = {}) {
  const database = requireDatabase(options.db);
  const { poleId = null, deviceId = null } = input ?? {};

  if (!poleId && !deviceId) {
    throwHttpError(400, 'poleId or deviceId is required.');
  }

  const target = deviceId
    ? await fetchDeviceStateByDeviceId(database, deviceId)
    : await fetchDeviceStateByPoleId(database, poleId);

  if (!target?.deviceId) {
    throwHttpError(
      404,
      deviceId
        ? `Device not found: ${deviceId}`
        : `Pole ${poleId} does not have a device to un-silence.`,
    );
  }

  const unsilencedDeviceCount = await unsilenceDeviceIds(database, [
    target.deviceId,
  ]);

  return {
    type: 'unsilence',
    poleId: target.poleId,
    deviceId: target.deviceId,
    unsilenced: unsilencedDeviceCount > 0,
    unsilencedDeviceCount,
  };
}

export async function injectScheduledOutage(input = {}, options = {}) {
  const database = requireDatabase(options.db);
  const rng = options.rng ?? Math.random;
  const now = normalizeDate(options.now ?? new Date());
  const truth = await loadGroundTruth(database, options);
  const tree = buildTruthTree(truth.poles);
  const dtId = input.dtId ?? pickRandomDtId(tree, rng);

  if (!dtId) {
    throwHttpError(404, 'No DTs are available in ground-truth topology.');
  }

  const affectedPoleIds = getPoleIdsForDt(tree, dtId);

  if (affectedPoleIds.length === 0) {
    throwHttpError(404, `DT not found in ground-truth topology: ${dtId}`);
  }

  const startsAt = addMinutes(now, -5);
  const endsAt = addMinutes(
    now,
    Number(input.durationMinutes) > 0
      ? Number(input.durationMinutes)
      : DEFAULT_SCHEDULED_OUTAGE_DURATION_MINUTES,
  );
  const outage = {
    id: `SIM-SO-${randomUUID()}`,
    scope: 'dt',
    targetId: dtId,
    startsAt,
    endsAt,
    reason: input.reason ?? 'simulator planned outage',
    isCancelled: false,
  };

  await database.insert(scheduledOutages).values(outage);

  const currentStates = await fetchPoleDeviceStates(database, affectedPoleIds);
  const silencedDeviceIds = await fetchSilencedDeviceIdsForStates(
    database,
    currentStates.statesByPoleId,
  );
  const telemetryPlan = createFaultTelemetryPlan({
    affectedPoleIds,
    baselineLivePoleIds: [],
    statesByPoleId: currentStates.statesByPoleId,
    silencedDeviceIds,
    now,
    rng,
    powerLostProbability: 1,
  });
  const ingestion = await ingestTelemetryPlan(database, telemetryPlan);
  const detection = await maybeRunDetection(database, now, options);

  return {
    type: 'scheduled_outage',
    outage,
    dtId,
    affectedPoleCount: affectedPoleIds.length,
    affectedPoleIds,
    telemetry: summarizeTelemetryPlan(telemetryPlan, ingestion),
    detection,
  };
}

export async function repairFault(incidentId, options = {}) {
  const database = requireDatabase(options.db);
  const rng = options.rng ?? Math.random;
  const now = normalizeDate(options.now ?? new Date());

  if (!incidentId) {
    throwHttpError(400, 'incidentId is required.');
  }

  const [incident] = await database
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);

  if (!incident) {
    throwHttpError(404, 'Incident not found.');
  }

  const affectedPoles = await fetchIncidentAffectedPoles(database, incidentId);

  if (affectedPoles.length === 0) {
    throwHttpError(409, 'Incident has no affected poles to repair.');
  }

  const statesByPoleId = new Map(
    affectedPoles.map((pole) => [pole.poleId, pole]),
  );
  const telemetryPlan = createRepairTelemetryPlan({
    poleIds: affectedPoles.map((pole) => pole.poleId),
    statesByPoleId,
    now,
    rng,
  });
  const ingestion = await ingestTelemetryPlan(database, telemetryPlan);
  const unsilencedDeviceCount = await unsilenceDeviceIds(
    database,
    telemetryPlan.events.map((event) => event.deviceId),
  );
  const detection = await maybeRunDetection(database, now, options);

  return {
    type: 'repair',
    incidentId,
    statusBeforeRepair: incident.status,
    affectedPoleCount: affectedPoles.length,
    affectedPoleIds: affectedPoles.map((pole) => pole.poleId).sort(compareIds),
    unsilencedDeviceCount,
    telemetry: summarizeTelemetryPlan(telemetryPlan, ingestion),
    detection,
  };
}

export async function getSimulatorNetwork(options = {}) {
  const database = requireDatabase(options.db);
  const truth = await loadGroundTruth(database, options);
  const tree = buildTruthTree(truth.poles);
  const [feederRows, dtRows, poleRows, silencedRows] = await Promise.all([
    database.select().from(feeders),
    database.select().from(dts),
    fetchAllPoleDeviceStates(database),
    fetchSilencedDevices(database),
  ]);
  const statesByPoleId = new Map(poleRows.map((pole) => [pole.poleId, pole]));
  const silencedByDeviceId = new Map(
    silencedRows.map((row) => [row.deviceId, row]),
  );
  const simulatorPoles = truth.poles
    .map((truthPole) => {
      const state = statesByPoleId.get(truthPole.poleId);

      return {
        ...truthPole,
        children: tree.childrenByParent.get(truthPole.poleId) ?? [],
        current: state
          ? {
              publicParentPoleId: state.parentPoleId,
              inferredParentId: state.inferredParentId,
              publicSeqOnLine: state.seqOnLine,
              inferredSeq: state.inferredSeq,
              deviceId: state.deviceId,
              fwVersion: state.fwVersion,
              batteryMv: state.batteryMv,
              rssi: state.rssi,
              lastState: state.lastState,
              lastSeenTs: normalizeNullableIso(state.lastSeenTs),
              lastSeq: state.lastSeq,
              deviceLastSeq: state.deviceLastSeq,
              simulatorSilenced: state.deviceId
                ? silencedByDeviceId.has(state.deviceId)
                : false,
            }
          : null,
      };
    })
    .sort((left, right) => compareIds(left.poleId, right.poleId));

  return {
    seed: truth.seed,
    referenceNow: truth.referenceNow,
    counts: truth.counts,
    strippedDtIds: truth.strippedDtIds,
    silencedDevices: silencedRows.map((row) => ({
      ...row,
      silencedAt: normalizeNullableIso(row.silencedAt),
    })),
    feeders: feederRows
      .map((feeder) => ({
        ...feeder,
        dtIds: dtRows
          .filter((dt) => dt.feederId === feeder.feederId)
          .map((dt) => dt.dtId)
          .sort(compareIds),
      }))
      .sort((left, right) => compareIds(left.feederId, right.feederId)),
    dts: dtRows
      .map((dt) => ({
        ...dt,
        rootPoleIds: tree.rootChildrenByDt.get(dt.dtId) ?? [],
        poleCount: getPoleIdsForDt(tree, dt.dtId).length,
      }))
      .sort((left, right) => compareIds(left.dtId, right.dtId)),
    poles: simulatorPoles,
  };
}

export function buildTruthTree(truthPoles) {
  const polesById = new Map();
  const childrenByParent = new Map();
  const poleIdsByDt = new Map();
  const poleIdsByFeeder = new Map();
  const rootChildrenByDt = new Map();

  for (const pole of truthPoles) {
    polesById.set(pole.poleId, pole);
    pushMapValue(poleIdsByDt, pole.dtId, pole.poleId);
    pushMapValue(poleIdsByFeeder, pole.feederId, pole.poleId);

    if (pole.trueParentPoleId) {
      pushMapValue(childrenByParent, pole.trueParentPoleId, pole.poleId);
    } else {
      pushMapValue(rootChildrenByDt, pole.dtId, pole.poleId);
    }
  }

  sortMapArrays(childrenByParent);
  sortMapArrays(poleIdsByDt);
  sortMapArrays(poleIdsByFeeder);
  sortMapArrays(rootChildrenByDt);

  return {
    polesById,
    childrenByParent,
    poleIdsByDt,
    poleIdsByFeeder,
    rootChildrenByDt,
  };
}

export function collectDownstreamPoleIds(tree, atPoleId) {
  if (!tree.polesById.has(atPoleId)) {
    throwHttpError(404, `Pole not found in ground-truth topology: ${atPoleId}`);
  }

  const result = [];
  const stack = [atPoleId];

  while (stack.length > 0) {
    const poleId = stack.pop();

    result.push(poleId);
    stack.push(...(tree.childrenByParent.get(poleId) ?? []));
  }

  return result.sort(compareIds);
}

export function createFaultTelemetryPlan({
  affectedPoleIds,
  baselineLivePoleIds,
  statesByPoleId,
  silencedDeviceIds = [],
  now,
  rng = Math.random,
  powerLostProbability = DEFAULT_POWER_LOST_PROBABILITY,
}) {
  const silenced = normalizeSilencedDeviceIds(silencedDeviceIds);
  const livePlan = createLiveHeartbeatPlan({
    poleIds: baselineLivePoleIds,
    statesByPoleId,
    silencedDeviceIds: silenced,
    now: addSeconds(now, -30),
    rng,
  });
  const darkGroups = [];
  const skipped = {
    droppedPowerLostPoleIds: [],
    legacySilentPoleIds: [],
    noDevicePoleIds: [],
    silencedPoleIds: [],
    silencedDeviceIds: [],
  };

  for (const poleId of affectedPoleIds) {
    const state = statesByPoleId.get(poleId);

    if (!state?.deviceId) {
      skipped.noDevicePoleIds.push(poleId);
      continue;
    }

    if (silenced.has(state.deviceId)) {
      skipped.silencedPoleIds.push(poleId);
      skipped.silencedDeviceIds.push(state.deviceId);
      continue;
    }

    if (isLegacySilentFirmware(state.fwVersion)) {
      skipped.legacySilentPoleIds.push(poleId);
      continue;
    }

    if (rng() > powerLostProbability) {
      skipped.droppedPowerLostPoleIds.push(poleId);
      continue;
    }

    darkGroups.push([
      createTelemetryEvent({
        state,
        event: 'power_lost',
        energized: false,
        seq: nextSeq(state),
        deviceTs: staggeredDeviceTs(now, darkGroups.length, rng),
      }),
    ]);
  }

  return {
    source: SIMULATOR_EVENT_BATCH_SOURCE,
    events: orderEventGroups([...livePlan.eventGroups, ...darkGroups], rng),
    eventGroups: [...livePlan.eventGroups, ...darkGroups],
    skipped: {
      droppedPowerLostPoleIds: skipped.droppedPowerLostPoleIds.sort(compareIds),
      legacySilentPoleIds: skipped.legacySilentPoleIds.sort(compareIds),
      noDevicePoleIds: skipped.noDevicePoleIds.sort(compareIds),
      silencedPoleIds: skipped.silencedPoleIds.sort(compareIds),
      silencedDeviceIds: uniqueSorted(skipped.silencedDeviceIds),
      noDeviceBaselinePoleIds: livePlan.skipped.noDeviceBaselinePoleIds,
      silencedBaselinePoleIds: livePlan.skipped.silencedPoleIds,
      silencedBaselineDeviceIds: livePlan.skipped.silencedDeviceIds,
    },
    counts: {
      liveHeartbeatEvents: livePlan.counts.liveHeartbeatEvents,
      powerLostEvents: darkGroups.length,
    },
  };
}

export function createLiveHeartbeatPlan({
  poleIds,
  statesByPoleId,
  silencedDeviceIds = [],
  now,
  rng = Math.random,
}) {
  const silenced = normalizeSilencedDeviceIds(silencedDeviceIds);
  const eventGroups = [];
  const noDeviceBaselinePoleIds = [];
  const silencedPoleIds = [];
  const skippedSilencedDeviceIds = [];

  for (const poleId of poleIds) {
    const state = statesByPoleId.get(poleId);

    if (!state?.deviceId) {
      noDeviceBaselinePoleIds.push(poleId);
      continue;
    }

    if (silenced.has(state.deviceId)) {
      silencedPoleIds.push(poleId);
      skippedSilencedDeviceIds.push(state.deviceId);
      continue;
    }

    eventGroups.push([
      createTelemetryEvent({
        state,
        event: 'heartbeat',
        energized: true,
        seq: nextSeq(state),
        deviceTs: staggeredDeviceTs(now, eventGroups.length, rng),
      }),
    ]);
  }

  return {
    source: SIMULATOR_EVENT_BATCH_SOURCE,
    events: orderEventGroups(eventGroups, rng),
    eventGroups,
    skipped: {
      noDeviceBaselinePoleIds: noDeviceBaselinePoleIds.sort(compareIds),
      silencedPoleIds: silencedPoleIds.sort(compareIds),
      silencedDeviceIds: uniqueSorted(skippedSilencedDeviceIds),
    },
    counts: {
      liveHeartbeatEvents: eventGroups.length,
      powerLostEvents: 0,
    },
  };
}

export function createRepairTelemetryPlan({
  poleIds,
  statesByPoleId,
  now,
  rng = Math.random,
}) {
  const eventGroups = [];
  const noDevicePoleIds = [];

  for (const poleId of poleIds) {
    const state = statesByPoleId.get(poleId);

    if (!state?.deviceId) {
      noDevicePoleIds.push(poleId);
      continue;
    }

    const bootTs = staggeredDeviceTs(now, eventGroups.length, rng);
    const restoredTs = addSeconds(bootTs, 2 + Math.round(rng() * 6));

    eventGroups.push([
      createTelemetryEvent({
        state,
        event: 'boot',
        energized: true,
        seq: 0,
        deviceTs: bootTs,
      }),
      createTelemetryEvent({
        state,
        event: 'power_restored',
        energized: true,
        seq: 1,
        deviceTs: restoredTs,
      }),
    ]);
  }

  return {
    source: SIMULATOR_EVENT_BATCH_SOURCE,
    events: orderEventGroups(eventGroups, rng),
    eventGroups,
    skipped: {
      noDevicePoleIds: noDevicePoleIds.sort(compareIds),
    },
    counts: {
      bootEvents: eventGroups.length,
      powerRestoredEvents: eventGroups.length,
    },
  };
}

async function loadGroundTruth(database, options = {}) {
  if (options.groundTruth) {
    await validateGroundTruthSeed(database, options.groundTruth, 'provided', options);
    return options.groundTruth;
  }

  const groundTruthPath =
    options.groundTruthPath ??
    process.env.GROUND_TRUTH_PATH ??
    DEFAULT_GROUND_TRUTH_PATH;

  try {
    const raw = await readFile(groundTruthPath, 'utf8');
    const parsed = JSON.parse(raw);

    await validateGroundTruthSeed(database, parsed, groundTruthPath, options);
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    throwHttpError(
      409,
      [
        `Ground-truth topology file is missing at ${groundTruthPath}.`,
        'The simulator refuses to regenerate a fallback because it could mismatch the live database topology.',
        'Reseed the database so app_metadata.network_seed and groundTruth.json are created together.',
      ].join(' '),
    );
  }
}

async function validateGroundTruthSeed(
  database,
  groundTruth,
  groundTruthPath,
  options,
) {
  if (options.skipGroundTruthSeedValidation) {
    return;
  }

  const recordedSeed =
    options.recordedNetworkSeed ?? (await fetchRecordedNetworkSeed(database));

  assertGroundTruthSeedMatches(groundTruth, recordedSeed, groundTruthPath);
}

export function assertGroundTruthSeedMatches(
  groundTruth,
  recordedSeed,
  groundTruthPath = 'groundTruth.json',
) {
  if (recordedSeed === null || recordedSeed === undefined || recordedSeed === '') {
    throwHttpError(
      409,
      [
        'Database network seed metadata is missing.',
        `Cannot trust ${groundTruthPath} without app_metadata.network_seed.`,
        'Reseed the database before using simulator fault injection.',
      ].join(' '),
    );
  }

  if (groundTruth?.seed === null || groundTruth?.seed === undefined) {
    throwHttpError(
      409,
      `Ground-truth topology at ${groundTruthPath} does not include a seed; reseed before using simulator fault injection.`,
    );
  }

  const truthSeed = normalizeSeedForCompare(groundTruth.seed);
  const dbSeed = normalizeSeedForCompare(recordedSeed);

  if (truthSeed !== dbSeed) {
    throwHttpError(
      409,
      [
        `Ground-truth seed mismatch for ${groundTruthPath}: file seed ${groundTruth.seed}, database seed ${recordedSeed}.`,
        'Simulator fault injection is disabled to avoid using the wrong physical topology.',
        'Reseed the database and regenerate groundTruth.json from the same seed.',
      ].join(' '),
    );
  }
}

async function fetchRecordedNetworkSeed(database) {
  const [row] = await database
    .select({ value: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, NETWORK_SEED_METADATA_KEY))
    .limit(1);

  return row?.value ?? null;
}

async function fetchPoleDeviceStates(database, poleIds) {
  if (poleIds.length === 0) {
    return { rows: [], statesByPoleId: new Map() };
  }

  const rows = await database
    .select({
      poleId: poles.poleId,
      lat: poles.lat,
      lon: poles.lon,
      feederId: poles.feederId,
      dtId: poles.dtId,
      seqOnLine: poles.seqOnLine,
      parentPoleId: poles.parentPoleId,
      inferredParentId: poles.inferredParentId,
      inferredSeq: poles.inferredSeq,
      pincode: poles.pincode,
      deviceId: poles.deviceId,
      lastState: poles.lastState,
      lastSeenTs: poles.lastSeenTs,
      lastSeq: poles.lastSeq,
      fwVersion: devices.fwVersion,
      batteryMv: devices.batteryMv,
      rssi: devices.rssi,
      deviceLastSeq: devices.lastSeq,
    })
    .from(poles)
    .leftJoin(devices, eq(poles.deviceId, devices.deviceId))
    .where(inArray(poles.poleId, poleIds));

  return {
    rows,
    statesByPoleId: new Map(rows.map((row) => [row.poleId, row])),
  };
}

async function fetchDeviceStateByPoleId(database, poleId) {
  const { rows } = await fetchPoleDeviceStates(database, [poleId]);

  return rows[0];
}

async function fetchDeviceStateByDeviceId(database, deviceId) {
  const [row] = await database
    .select({
      poleId: devices.poleId,
      deviceId: devices.deviceId,
    })
    .from(devices)
    .where(eq(devices.deviceId, deviceId))
    .limit(1);

  return row;
}

async function fetchAllPoleDeviceStates(database) {
  return database
    .select({
      poleId: poles.poleId,
      lat: poles.lat,
      lon: poles.lon,
      feederId: poles.feederId,
      dtId: poles.dtId,
      seqOnLine: poles.seqOnLine,
      parentPoleId: poles.parentPoleId,
      inferredParentId: poles.inferredParentId,
      inferredSeq: poles.inferredSeq,
      pincode: poles.pincode,
      deviceId: poles.deviceId,
      lastState: poles.lastState,
      lastSeenTs: poles.lastSeenTs,
      lastSeq: poles.lastSeq,
      fwVersion: devices.fwVersion,
      batteryMv: devices.batteryMv,
      rssi: devices.rssi,
      deviceLastSeq: devices.lastSeq,
    })
    .from(poles)
    .leftJoin(devices, eq(poles.deviceId, devices.deviceId));
}

async function fetchSilencedDevices(database) {
  return database
    .select({
      deviceId: silencedDevices.deviceId,
      poleId: silencedDevices.poleId,
      reason: silencedDevices.reason,
      silencedAt: silencedDevices.silencedAt,
    })
    .from(silencedDevices);
}

async function fetchSilencedDeviceIdsForStates(database, statesByPoleId) {
  const deviceIds = Array.from(statesByPoleId.values())
    .map((state) => state.deviceId)
    .filter(Boolean);

  return fetchSilencedDeviceIds(database, deviceIds);
}

async function fetchSilencedDeviceIds(database, deviceIds) {
  const uniqueDeviceIds = uniqueSorted(deviceIds);

  if (uniqueDeviceIds.length === 0) {
    return new Set();
  }

  const rows = await database
    .select({ deviceId: silencedDevices.deviceId })
    .from(silencedDevices)
    .where(inArray(silencedDevices.deviceId, uniqueDeviceIds));

  return new Set(rows.map((row) => row.deviceId));
}

async function silenceDevice(database, target, now, reason) {
  await database
    .insert(silencedDevices)
    .values({
      deviceId: target.deviceId,
      poleId: target.poleId,
      reason: reason ?? 'simulator dead sensor',
      silencedAt: now,
    })
    .onConflictDoUpdate({
      target: silencedDevices.deviceId,
      set: {
        poleId: target.poleId,
        reason: reason ?? 'simulator dead sensor',
        silencedAt: now,
      },
    });
}

async function unsilenceDeviceIds(database, deviceIds) {
  const uniqueDeviceIds = uniqueSorted(deviceIds);

  if (uniqueDeviceIds.length === 0) {
    return 0;
  }

  const rows = await database
    .delete(silencedDevices)
    .where(inArray(silencedDevices.deviceId, uniqueDeviceIds))
    .returning({ deviceId: silencedDevices.deviceId });

  return rows.length;
}

async function fetchIncidentAffectedPoles(database, incidentId) {
  return database
    .select({
      poleId: incidentPoles.poleId,
      deviceId: poles.deviceId,
      lastState: poles.lastState,
      lastSeenTs: poles.lastSeenTs,
      lastSeq: poles.lastSeq,
      fwVersion: devices.fwVersion,
      batteryMv: devices.batteryMv,
      rssi: devices.rssi,
      deviceLastSeq: devices.lastSeq,
    })
    .from(incidentPoles)
    .leftJoin(poles, eq(incidentPoles.poleId, poles.poleId))
    .leftJoin(devices, eq(poles.deviceId, devices.deviceId))
    .where(eq(incidentPoles.incidentId, incidentId));
}

async function ingestTelemetryPlan(database, plan) {
  if (plan.events.length === 0) {
    return {
      stored: 0,
      accepted: 0,
      ignored: 0,
    };
  }

  return ingestTelemetryEvents(database, plan.events);
}

async function maybeRunDetection(database, now, options) {
  if (options.runDetection === false) {
    return null;
  }

  return runDetectionOnce({ db: database, now });
}

function createTelemetryEvent({ state, event, energized, seq, deviceTs }) {
  return {
    deviceId: state.deviceId,
    poleId: state.poleId,
    event,
    energized,
    deviceTs,
    seq,
    batteryMv: state.batteryMv ?? DEFAULT_BATTERY_MV,
    rssi: state.rssi ?? DEFAULT_RSSI,
    fwVersion: state.fwVersion ?? DEFAULT_FIRMWARE,
  };
}

function summarizeTelemetryPlan(plan, ingestion) {
  return {
    generatedEventCount: plan.events.length,
    ...plan.counts,
    skipped: plan.skipped,
    ingestion,
  };
}

function pickRandomFaultablePole({
  poleIds,
  tree,
  statesByPoleId,
  silencedDeviceIds = [],
  rng,
}) {
  const silenced = normalizeSilencedDeviceIds(silencedDeviceIds);
  const candidates = poleIds.filter((poleId) =>
    collectDownstreamPoleIds(tree, poleId).some((downstreamPoleId) => {
      const state = statesByPoleId.get(downstreamPoleId);

      return (
        state?.deviceId &&
        !silenced.has(state.deviceId) &&
        !isLegacySilentFirmware(state.fwVersion)
      );
    }),
  );
  const pool = candidates.length > 0 ? candidates : poleIds;

  return pool[Math.floor(rng() * pool.length)];
}

function pickRandomDtId(tree, rng) {
  const dtIds = Array.from(tree.poleIdsByDt.keys()).sort(compareIds);

  return dtIds[Math.floor(rng() * dtIds.length)];
}

function getPoleIdsForDt(tree, dtId) {
  return tree.poleIdsByDt.get(dtId) ?? [];
}

function getPoleIdsForFeeder(tree, feederId) {
  return tree.poleIdsByFeeder.get(feederId) ?? [];
}

function getNeighborPoleIds(tree, poleId) {
  const pole = tree.polesById.get(poleId);
  const neighbors = new Set(tree.childrenByParent.get(poleId) ?? []);

  if (pole?.trueParentPoleId) {
    neighbors.add(pole.trueParentPoleId);
  }

  return Array.from(neighbors).sort(compareIds);
}

function assertPoleBelongsToDt(tree, poleId, dtId) {
  const pole = tree.polesById.get(poleId);

  if (!pole) {
    throwHttpError(404, `Pole not found in ground-truth topology: ${poleId}`);
  }

  if (pole.dtId !== dtId) {
    throwHttpError(400, `Pole ${poleId} does not belong to DT ${dtId}.`);
  }
}

function orderEventGroups(eventGroups, rng) {
  const ordered = [];
  const windowSize = 5;

  for (let index = 0; index < eventGroups.length; index += windowSize) {
    const window = eventGroups.slice(index, index + windowSize);

    ordered.push(...shuffle(window, rng).flat());
  }

  return ordered;
}

function staggeredDeviceTs(now, index, rng) {
  const naturalOffsetMs = index * (250 + Math.round(rng() * 1750));

  return new Date(now.getTime() + naturalOffsetMs + randomClockSkewMs(rng));
}

function randomClockSkewMs(rng) {
  const maxSkewMs = rng() < 0.85 ? 8_000 : 90_000;

  return Math.round((rng() * 2 - 1) * maxSkewMs);
}

function nextSeq(state) {
  return Number(state.deviceLastSeq ?? state.lastSeq ?? 0) + 1;
}

function normalizeSilencedDeviceIds(deviceIds) {
  if (deviceIds instanceof Set) {
    return deviceIds;
  }

  return new Set(deviceIds ?? []);
}

function isLegacySilentFirmware(fwVersion) {
  return typeof fwVersion === 'string' && fwVersion.startsWith('1.2');
}

function pushMapValue(map, key, value) {
  const values = map.get(key) ?? [];

  values.push(value);
  map.set(key, values);
}

function sortMapArrays(map) {
  for (const values of map.values()) {
    values.sort(compareIds);
  }
}

function shuffle(values, rng) {
  const shuffled = [...values];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

function normalizeNullableIso(value) {
  const date = parseNullableDate(value);

  return date ? date.toISOString() : null;
}

function normalizeDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function normalizeSeedForCompare(seed) {
  const numericSeed = Number(seed);

  return Number.isFinite(numericSeed) ? String(numericSeed) : String(seed);
}

function parseNullableDate(value) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function requireDatabase(database) {
  const resolved = database ?? defaultDb;

  if (!resolved) {
    throwHttpError(503, 'DATABASE_URL is not configured.');
  }

  return resolved;
}

function throwHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function compareIds(left, right) {
  return left.localeCompare(right);
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort(compareIds);
}
