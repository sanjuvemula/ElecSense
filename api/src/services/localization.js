import { eq } from 'drizzle-orm';

import { db as defaultDb } from '../db/index.js';
import { devices, dts, poles, scheduledOutages } from '../db/schema.js';
import { inferTopology } from './topology.js';

const DEFAULT_RECENT_TELEMETRY_MS = 25 * 60 * 1000;
const DEFAULT_UNKNOWN_AFTER_MS = 30 * 60 * 1000;
const DT_ROOT_PARENT_ID = null;

export async function localizeFaultsForDt(dtId, options = {}) {
  const database = options.db ?? defaultDb;

  if (!database) {
    const error = new Error('DATABASE_URL is not configured.');
    error.status = 503;
    throw error;
  }

  const [dt, tree, poleStates, outageRows] = await Promise.all([
    fetchDt(database, dtId),
    inferTopology(dtId, { db: database }),
    fetchPoleStatesForDt(database, dtId),
    fetchScheduledOutages(database),
  ]);

  return localizeFaultsForDtSnapshot({
    dt,
    tree,
    poles: poleStates,
    scheduledOutages: outageRows,
    now: options.now ?? new Date(),
    feederUpstreamLive: options.feederUpstreamLive ?? true,
  });
}

export async function localizeFaultsForFeeder(feederId, options = {}) {
  const database = options.db ?? defaultDb;

  if (!database) {
    const error = new Error('DATABASE_URL is not configured.');
    error.status = 503;
    throw error;
  }

  const [dtRows, outageRows] = await Promise.all([
    database
      .select({
        dtId: dts.dtId,
        feederId: dts.feederId,
        lat: dts.lat,
        lon: dts.lon,
      })
      .from(dts)
      .where(eq(dts.feederId, feederId)),
    fetchScheduledOutages(database),
  ]);
  const dtSnapshots = await Promise.all(
    dtRows.map(async (dt) => ({
      dt,
      tree: await inferTopology(dt.dtId, { db: database }),
      poles: await fetchPoleStatesForDt(database, dt.dtId),
    })),
  );

  return localizeFaultsForFeederSnapshot({
    feederId,
    dtSnapshots,
    scheduledOutages: outageRows,
    now: options.now ?? new Date(),
  });
}

export function localizeFaultsForFeederSnapshot({
  feederId,
  dtSnapshots,
  scheduledOutages: outageRows = [],
  now,
  options = {},
}) {
  const clock = normalizeNow(now);
  const activeFeederOutage = findActiveOutage(outageRows, clock, [
    { scope: 'feeder', targetId: feederId },
  ]);

  if (activeFeederOutage) {
    return {
      feederId,
      incidents: [],
      healthFlags: [],
      suppressedByOutage: true,
      suppressedBy: activeFeederOutage,
    };
  }

  const contextsByDt = dtSnapshots.map((snapshot) => ({
    snapshot,
    context: buildDtContext(snapshot, clock, options),
  }));
  const allDtsDark =
    contextsByDt.length > 0 &&
    contextsByDt.every(({ context }) => isDtFullyDark(context));

  if (allDtsDark) {
    const affectedPoleIds = contextsByDt.flatMap(({ context }) =>
      Object.keys(context.nodes),
    );

    return {
      feederId,
      incidents: [
        createFeederIncident({
          feederId,
          contextsByDt,
          affectedPoleIds,
        }),
      ],
      healthFlags: [],
      suppressedByOutage: false,
      suppressedBy: null,
    };
  }

  const dtResults = dtSnapshots.map((snapshot) =>
    localizeFaultsForDtSnapshot({
      ...snapshot,
      scheduledOutages: outageRows,
      now: clock,
      feederUpstreamLive: true,
      options,
    }),
  );

  return {
    feederId,
    incidents: dtResults.flatMap((result) => result.incidents),
    healthFlags: dtResults.flatMap((result) => result.healthFlags),
    suppressedByOutage: false,
    suppressedBy: null,
  };
}

export function localizeFaultsForDtSnapshot({
  dt,
  tree,
  poles: poleRows,
  scheduledOutages: outageRows = [],
  now,
  feederUpstreamLive = true,
  options = {},
}) {
  const clock = normalizeNow(now);
  const context = buildDtContext({ dt, tree, poles: poleRows }, clock, options);
  const activeOutage = findActiveOutage(outageRows, clock, [
    { scope: 'dt', targetId: dt.dtId },
    { scope: 'feeder', targetId: dt.feederId },
  ]);

  // Scheduled outage suppression belongs here so localization callers and tests
  // see the same deterministic incident/no-incident decision.
  if (activeOutage) {
    return {
      dtId: dt.dtId,
      feederId: dt.feederId,
      topologySource: tree.topologySource,
      incidents: [],
      healthFlags: [],
      suppressedByOutage: true,
      suppressedBy: activeOutage,
    };
  }

  if (feederUpstreamLive && isDtFullyDark(context)) {
    return {
      dtId: dt.dtId,
      feederId: dt.feederId,
      topologySource: tree.topologySource,
      incidents: [createDtIncident(context)],
      healthFlags: [],
      suppressedByOutage: false,
      suppressedBy: null,
    };
  }

  const incidents = [];
  const healthFlags = [];

  for (const poleId of context.root.children) {
    walkForFaults({
      context,
      poleId,
      lastKnownLivePoleId: DT_ROOT_PARENT_ID,
      incidents,
      healthFlags,
    });
  }

  return {
    dtId: dt.dtId,
    feederId: dt.feederId,
    topologySource: tree.topologySource,
    incidents,
    healthFlags,
    suppressedByOutage: false,
    suppressedBy: null,
  };
}

function walkForFaults({
  context,
  poleId,
  lastKnownLivePoleId,
  incidents,
  healthFlags,
}) {
  const node = context.nodes[poleId];
  const summary = context.summaries[poleId];

  if (!node) {
    return;
  }

  if (node.effectiveState === 'live') {
    for (const childPoleId of node.children) {
      walkForFaults({
        context,
        poleId: childPoleId,
        lastKnownLivePoleId: poleId,
        incidents,
        healthFlags,
      });
    }

    return;
  }

  if (
    isTelemetryProblemCandidate(node) &&
    summary.reportingDescendantCount > 0 &&
    summary.reportingDescendantCount === summary.liveReportingDescendantCount
  ) {
    healthFlags.push(createSensorHealthFlag(context, node, 'downstream_live'));

    for (const childPoleId of node.children) {
      walkForFaults({
        context,
        poleId: childPoleId,
        lastKnownLivePoleId,
        incidents,
        healthFlags,
      });
    }

    return;
  }

  if (isBoundaryCandidate(node) && summary.liveDescendantCount === 0) {
    incidents.push(createSpanIncident(context, node, lastKnownLivePoleId));
    return;
  }

  if (isBoundaryCandidate(node) && summary.liveDescendantCount > 0) {
    healthFlags.push(createSensorHealthFlag(context, node, 'impossible_state'));
  }

  for (const childPoleId of node.children) {
    walkForFaults({
      context,
      poleId: childPoleId,
      lastKnownLivePoleId,
      incidents,
      healthFlags,
    });
  }
}

function buildDtContext({ dt, tree, poles: poleRows }, now, options) {
  const poleStateById = new Map(poleRows.map((pole) => [pole.poleId, pole]));
  const nodes = {};

  for (const [poleId, treeNode] of Object.entries(tree.nodes)) {
    const pole = poleStateById.get(poleId) ?? {};
    const effective = getEffectivePoleState(pole, now, options);

    nodes[poleId] = {
      poleId,
      dtId: dt.dtId,
      feederId: dt.feederId,
      parentPoleId: treeNode.parentPoleId ?? null,
      children: [...(treeNode.children ?? [])],
      depth: treeNode.depth,
      lat: Number(treeNode.lat ?? pole.lat),
      lon: Number(treeNode.lon ?? pole.lon),
      pincode: pole.pincode ?? null,
      deviceId: pole.deviceId ?? null,
      fwVersion: pole.fwVersion ?? null,
      lastState: pole.lastState ?? 'unknown',
      lastSeenTs: pole.lastSeenTs ?? null,
      topologyConfidence:
        parseNullableNumber(treeNode.topologyConfidence) ??
        parseNullableNumber(pole.topologyConfidence) ??
        1,
      effectiveState: effective.state,
      stateReason: effective.reason,
      telemetryAgeMs: effective.telemetryAgeMs,
    };
  }

  const context = {
    dt,
    tree,
    topologySource: tree.topologySource,
    root: tree.root,
    nodes,
    summaries: {},
    options: {
      recentTelemetryMs:
        options.recentTelemetryMs ?? DEFAULT_RECENT_TELEMETRY_MS,
      unknownAfterMs: options.unknownAfterMs ?? DEFAULT_UNKNOWN_AFTER_MS,
    },
  };

  for (const poleId of Object.keys(nodes)) {
    summarizeSubtree(context, poleId);
  }

  return context;
}

function summarizeSubtree(context, poleId) {
  if (context.summaries[poleId]) {
    return context.summaries[poleId];
  }

  const node = context.nodes[poleId];
  const childSummaries = node.children.map((childPoleId) =>
    summarizeSubtree(context, childPoleId),
  );
  const selfReporting = node.effectiveState !== 'no_device';
  const summary = {
    totalDescendantCount: childSummaries.reduce(
      (total, child) => total + child.totalCount,
      0,
    ),
    totalCount:
      1 + childSummaries.reduce((total, child) => total + child.totalCount, 0),
    liveDescendantCount: childSummaries.reduce(
      (total, child) => total + child.liveCount,
      0,
    ),
    liveCount:
      (node.effectiveState === 'live' ? 1 : 0) +
      childSummaries.reduce((total, child) => total + child.liveCount, 0),
    reportingDescendantCount: childSummaries.reduce(
      (total, child) => total + child.reportingCount,
      0,
    ),
    reportingCount:
      (selfReporting ? 1 : 0) +
      childSummaries.reduce((total, child) => total + child.reportingCount, 0),
    liveReportingDescendantCount: childSummaries.reduce(
      (total, child) => total + child.liveReportingCount,
      0,
    ),
    liveReportingCount:
      (selfReporting && node.effectiveState === 'live' ? 1 : 0) +
      childSummaries.reduce(
        (total, child) => total + child.liveReportingCount,
        0,
      ),
  };

  context.summaries[poleId] = summary;

  return summary;
}

function getEffectivePoleState(pole, now, options) {
  if (!pole.deviceId) {
    return {
      state: 'no_device',
      reason: 'no_device',
      telemetryAgeMs: null,
    };
  }

  const lastSeen = parseNullableDate(pole.lastSeenTs);

  if (!lastSeen) {
    return {
      state: 'unknown',
      reason: 'never_seen',
      telemetryAgeMs: null,
    };
  }

  const telemetryAgeMs = now.getTime() - lastSeen.getTime();
  const recentTelemetryMs =
    options.recentTelemetryMs ?? DEFAULT_RECENT_TELEMETRY_MS;
  const unknownAfterMs = options.unknownAfterMs ?? DEFAULT_UNKNOWN_AFTER_MS;

  if (telemetryAgeMs <= recentTelemetryMs && pole.lastState === 'live') {
    return {
      state: 'live',
      reason: 'recent_live',
      telemetryAgeMs,
    };
  }

  if (telemetryAgeMs <= unknownAfterMs && pole.lastState === 'dark') {
    return {
      state: 'dark',
      reason: 'recent_power_lost',
      telemetryAgeMs,
    };
  }

  if (
    isLegacySilentFirmware(pole.fwVersion) &&
    telemetryAgeMs > unknownAfterMs
  ) {
    return {
      state: 'dark',
      reason: 'legacy_firmware_silent',
      telemetryAgeMs,
    };
  }

  return {
    state: 'unknown',
    reason: 'stale_or_ambiguous',
    telemetryAgeMs,
  };
}

function createSpanIncident(context, boundaryNode, lastKnownLivePoleId) {
  const boundaryRange = buildBoundaryRange(
    context,
    boundaryNode.poleId,
    lastKnownLivePoleId,
  );
  const affectedPoleIds = collectSubtreePoleIds(context, boundaryNode.poleId);
  const location = computeBoundaryLocation(context, boundaryRange);
  const confidence = scoreConfidence(context, boundaryNode, boundaryRange);

  return {
    type: 'span',
    dtId: context.dt.dtId,
    feederId: context.dt.feederId,
    boundaryPoleId: boundaryNode.poleId,
    boundaryParentId: lastKnownLivePoleId,
    boundaryRange,
    lat: location.lat,
    lon: location.lon,
    pincode: boundaryNode.pincode,
    affectedPoleCount: affectedPoleIds.length,
    affectedPoleIds,
    confidence: confidence.value,
    confidenceReason: confidence.reason,
    topologySource: context.topologySource,
  };
}

function createDtIncident(context) {
  const affectedPoleIds = Object.keys(context.nodes).sort(compareIds);
  const location = {
    lat: Number(context.dt.lat),
    lon: Number(context.dt.lon),
  };
  const confidence = scoreDtConfidence(context);

  return {
    type: 'dt',
    dtId: context.dt.dtId,
    feederId: context.dt.feederId,
    boundaryPoleId: null,
    boundaryParentId: null,
    lat: round(location.lat, 7),
    lon: round(location.lon, 7),
    pincode: mostCommon(
      affectedPoleIds.map((poleId) => context.nodes[poleId].pincode),
    ),
    affectedPoleCount: affectedPoleIds.length,
    affectedPoleIds,
    confidence: confidence.value,
    confidenceReason: confidence.reason,
    topologySource: context.topologySource,
  };
}

function createFeederIncident({ feederId, contextsByDt, affectedPoleIds }) {
  const allNodes = contextsByDt.flatMap(({ context }) =>
    Object.values(context.nodes),
  );
  const confidenceValues = contextsByDt.map(
    ({ context }) => scoreDtConfidence(context).value,
  );
  const topologySource = contextsByDt.some(
    ({ context }) => context.topologySource === 'inferred',
  )
    ? 'inferred'
    : 'surveyed';
  const centroid = centroidOf(allNodes);

  return {
    type: 'feeder',
    dtId: null,
    feederId,
    boundaryPoleId: null,
    boundaryParentId: null,
    lat: centroid.lat,
    lon: centroid.lon,
    pincode: mostCommon(allNodes.map((node) => node.pincode)),
    affectedPoleCount: affectedPoleIds.length,
    affectedPoleIds: affectedPoleIds.sort(compareIds),
    confidence: round(Math.min(...confidenceValues, 0.9), 4),
    confidenceReason:
      'all DTs under feeder have no recent live pole telemetry; feeder-level outage likely',
    topologySource,
  };
}

function createSensorHealthFlag(context, node, reason) {
  return {
    type: 'sensor_fault',
    dtId: context.dt.dtId,
    feederId: context.dt.feederId,
    poleId: node.poleId,
    deviceId: node.deviceId,
    reason,
    stateReason: node.stateReason,
    lastSeenTs: normalizeNullableIso(node.lastSeenTs),
  };
}

function buildBoundaryRange(context, boundaryPoleId, lastKnownLivePoleId) {
  const poleIds = [];
  let cursor = boundaryPoleId;

  while (cursor) {
    poleIds.push(cursor);

    if (cursor === lastKnownLivePoleId) {
      break;
    }

    cursor = context.nodes[cursor]?.parentPoleId ?? null;
  }

  poleIds.reverse();

  return {
    fromPoleId: lastKnownLivePoleId,
    toPoleId: boundaryPoleId,
    poleIds,
  };
}

function computeBoundaryLocation(context, boundaryRange) {
  const fromNode = boundaryRange.fromPoleId
    ? context.nodes[boundaryRange.fromPoleId]
    : context.dt;
  const toNode = context.nodes[boundaryRange.toPoleId];

  return {
    lat: round((Number(fromNode.lat) + Number(toNode.lat)) / 2, 7),
    lon: round((Number(fromNode.lon) + Number(toNode.lon)) / 2, 7),
  };
}

function scoreConfidence(context, boundaryNode, boundaryRange) {
  let score = context.topologySource === 'surveyed' ? 0.92 : 0.72;
  const reasons = [
    context.topologySource === 'surveyed'
      ? 'surveyed topology'
      : 'inferred topology (MST)',
  ];

  if (context.topologySource === 'inferred') {
    score *= boundaryNode.topologyConfidence;
    reasons.push(
      `edge confidence ${boundaryNode.topologyConfidence.toFixed(2)}`,
    );

    if (boundaryNode.topologyConfidence < 0.6) {
      reasons.push('suspicious inferred edge');
    }
  }

  if (boundaryNode.stateReason === 'recent_power_lost') {
    reasons.push('direct power_lost signal from boundary pole');
  } else if (boundaryNode.stateReason === 'legacy_firmware_silent') {
    reasons.push('legacy firmware 1.2.x explains missing power_lost');
  } else {
    score *= 0.72;
    reasons.push('boundary inferred from stale or ambiguous telemetry');
  }

  if (rangeHasNoDevicePole(context, boundaryRange)) {
    score *= 0.72;
    reasons.push(
      `boundary located to a ${boundaryRange.poleIds.length}-pole range because of no-device pole(s)`,
    );
  }

  return {
    value: round(clamp(score, 0.05, 0.99), 4),
    reason: reasons.join(', '),
  };
}

function scoreDtConfidence(context) {
  const base = context.topologySource === 'surveyed' ? 0.9 : 0.72;
  const directDarkCount = Object.values(context.nodes).filter(
    (node) => node.stateReason === 'recent_power_lost',
  ).length;
  const reportingCount = Object.values(context.nodes).filter(
    (node) => node.effectiveState !== 'no_device',
  ).length;
  const directSignalRatio =
    reportingCount === 0 ? 0 : directDarkCount / reportingCount;
  const score = base * (0.78 + directSignalRatio * 0.22);

  return {
    value: round(clamp(score, 0.05, 0.95), 4),
    reason:
      context.topologySource === 'surveyed'
        ? 'surveyed topology, all reporting poles under DT are dark or ambiguous'
        : 'inferred topology (MST), all reporting poles under DT are dark or ambiguous',
  };
}

function isDtFullyDark(context) {
  const nodes = Object.values(context.nodes);

  if (nodes.length === 0) {
    return false;
  }

  return (
    nodes.every((node) => node.effectiveState !== 'live') &&
    nodes.some(
      (node) =>
        node.effectiveState === 'dark' || node.effectiveState === 'unknown',
    )
  );
}

function isBoundaryCandidate(node) {
  return node.effectiveState === 'dark' || node.effectiveState === 'unknown';
}

function isTelemetryProblemCandidate(node) {
  return (
    node.deviceId &&
    (node.effectiveState === 'dark' || node.effectiveState === 'unknown')
  );
}

function collectSubtreePoleIds(context, poleId) {
  const result = [];
  const stack = [poleId];

  while (stack.length > 0) {
    const currentPoleId = stack.pop();
    const node = context.nodes[currentPoleId];

    if (!node) {
      continue;
    }

    result.push(currentPoleId);
    stack.push(...node.children);
  }

  return result.sort(compareIds);
}

function rangeHasNoDevicePole(context, boundaryRange) {
  return boundaryRange.poleIds.some(
    (poleId) => context.nodes[poleId]?.effectiveState === 'no_device',
  );
}

function findActiveOutage(outageRows, now, targets) {
  return outageRows.find((outage) => {
    if (outage.isCancelled) {
      return false;
    }

    const matchesTarget = targets.some(
      (target) =>
        outage.scope === target.scope && outage.targetId === target.targetId,
    );

    if (!matchesTarget) {
      return false;
    }

    return (
      parseNullableDate(outage.startsAt) <= now &&
      parseNullableDate(outage.endsAt) >= now
    );
  });
}

async function fetchDt(database, dtId) {
  const [dt] = await database
    .select({
      dtId: dts.dtId,
      feederId: dts.feederId,
      lat: dts.lat,
      lon: dts.lon,
    })
    .from(dts)
    .where(eq(dts.dtId, dtId))
    .limit(1);

  if (!dt) {
    const error = new Error(`DT not found: ${dtId}`);
    error.status = 404;
    throw error;
  }

  return dt;
}

async function fetchPoleStatesForDt(database, dtId) {
  return database
    .select({
      poleId: poles.poleId,
      lat: poles.lat,
      lon: poles.lon,
      pincode: poles.pincode,
      deviceId: poles.deviceId,
      lastState: poles.lastState,
      lastSeenTs: poles.lastSeenTs,
      topologyConfidence: poles.topologyConfidence,
      fwVersion: devices.fwVersion,
    })
    .from(poles)
    .leftJoin(devices, eq(poles.deviceId, devices.deviceId))
    .where(eq(poles.dtId, dtId));
}

async function fetchScheduledOutages(database) {
  return database
    .select({
      id: scheduledOutages.id,
      scope: scheduledOutages.scope,
      targetId: scheduledOutages.targetId,
      startsAt: scheduledOutages.startsAt,
      endsAt: scheduledOutages.endsAt,
      reason: scheduledOutages.reason,
      isCancelled: scheduledOutages.isCancelled,
    })
    .from(scheduledOutages);
}

function centroidOf(nodes) {
  if (nodes.length === 0) {
    return { lat: null, lon: null };
  }

  return {
    lat: round(
      nodes.reduce((total, node) => total + Number(node.lat), 0) / nodes.length,
      7,
    ),
    lon: round(
      nodes.reduce((total, node) => total + Number(node.lon), 0) / nodes.length,
      7,
    ),
  };
}

function mostCommon(values) {
  const counts = new Map();

  for (const value of values) {
    if (!value) {
      continue;
    }

    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return (
    Array.from(counts.entries()).sort((left, right) =>
      right[1] === left[1] ? compareIds(left[0], right[0]) : right[1] - left[1],
    )[0]?.[0] ?? null
  );
}

function isLegacySilentFirmware(fwVersion) {
  return typeof fwVersion === 'string' && fwVersion.startsWith('1.2');
}

function parseNullableDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  return new Date(value);
}

function normalizeNullableIso(value) {
  const date = parseNullableDate(value);

  return date ? date.toISOString() : null;
}

function normalizeNow(now) {
  if (!now) {
    throw new Error('localization requires a deterministic now timestamp.');
  }

  return now instanceof Date ? now : new Date(now);
}

function parseNullableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function compareIds(left, right) {
  return left.localeCompare(right);
}

function round(value, decimals) {
  if (value === null || value === undefined) {
    return value;
  }

  const scale = 10 ** decimals;

  return Math.round(value * scale) / scale;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
