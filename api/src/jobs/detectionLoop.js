import { and, eq, gte, inArray } from 'drizzle-orm';

import { db as defaultDb } from '../db/index.js';
import {
  incidentEvents,
  incidentPoles,
  incidents,
  poles,
  scheduledOutages,
  telemetryEvents,
} from '../db/schema.js';
import {
  areAllAffectedPolesLiveRecently,
  DEFAULT_AUTO_VERIFY_LIVE_WINDOW_MS,
} from '../services/incidentTelemetry.js';
import {
  localizeFaultsForDt,
  localizeFaultsForFeeder,
} from '../services/localization.js';

export const DEFAULT_DETECTION_INTERVAL_MS = 10 * 1000;
export const OUTAGE_GRACE_BEFORE_MS = 15 * 60 * 1000;
export const OUTAGE_GRACE_AFTER_MS = 45 * 60 * 1000;
export const DARK_DEBOUNCE_MS = 45 * 1000;
export const DARK_HISTORY_LOOKBACK_MS = 10 * 60 * 1000;

const OPEN_INCIDENT_STATUSES = [
  'detected',
  'acknowledged',
  'crew_assigned',
  'resolved',
];
const AUTO_VERIFY_STATUSES = ['crew_assigned', 'resolved'];

export function startDetectionLoop(options = {}) {
  const database = options.db ?? defaultDb;
  const logger = options.logger ?? console;

  if (!database) {
    logger.warn('Detection loop disabled: DATABASE_URL is not configured.');
    return () => {};
  }

  const configuredIntervalMs =
    options.intervalMs ?? Number(process.env.DETECTION_LOOP_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(configuredIntervalMs) && configuredIntervalMs > 0
      ? configuredIntervalMs
      : DEFAULT_DETECTION_INTERVAL_MS;
  let isRunning = false;

  // A fixed interval is simpler than wiring an ingestion event emitter, and a
  // 10s cadence leaves a very wide margin against the <120s detection target.
  const run = async () => {
    if (isRunning) {
      return;
    }

    isRunning = true;

    try {
      await runDetectionOnce({ ...options, db: database, now: new Date() });
    } catch (error) {
      logger.error('Detection loop failed.', error);
    } finally {
      isRunning = false;
    }
  };

  const timer = globalThis.setInterval(run, intervalMs);
  timer.unref?.();
  void run();

  return () => globalThis.clearInterval(timer);
}

export async function runDetectionOnce(options = {}) {
  const database = options.db ?? defaultDb;

  if (!database) {
    const error = new Error('DATABASE_URL is not configured.');
    error.status = 503;
    throw error;
  }

  const fetchScheduledOutagesFn =
    options.fetchScheduledOutages ?? fetchScheduledOutages;
  const fetchConfirmedDarkPolesFn =
    options.fetchConfirmedDarkPoles ?? fetchConfirmedDarkPoles;
  const localizeFaultsForFeederFn =
    options.localizeFaultsForFeeder ?? localizeFaultsForFeeder;
  const localizeFaultsForDtFn =
    options.localizeFaultsForDt ?? localizeFaultsForDt;
  const persistLocalizedIncidentsFn =
    options.persistLocalizedIncidents ?? persistLocalizedIncidents;
  const autoVerifyIncidentsFn =
    options.autoVerifyIncidents ?? autoVerifyIncidents;
  const markOpenFeederIncidentsDowngradedFn =
    options.markOpenFeederIncidentsDowngraded ??
    markOpenFeederIncidentsDowngraded;
  const logger = options.logger ?? console;
  const now = normalizeDate(options.now ?? new Date());
  const outageRows = await fetchScheduledOutagesFn(database);
  const activeOutages = buildActiveOutageSet(outageRows, now);
  const confirmedDarkPoles = await fetchConfirmedDarkPolesFn(database, {
    now,
    debounceMs: options.darkDebounceMs ?? DARK_DEBOUNCE_MS,
  });
  const candidatesByDt = groupConfirmedPolesByDt(
    confirmedDarkPoles,
    activeOutages.keys,
  );
  const candidatesByFeeder = groupConfirmedPolesByFeeder(candidatesByDt);
  const skippedDtIds = new Set();
  const downgradedFeederIds = [];
  const summaries = [];

  for (const [feederId, candidate] of candidatesByFeeder.entries()) {
    const result = await localizeFaultsForFeederFn(feederId, {
      db: database,
      now,
      confirmedDarkPoleIds: candidate.poleIds,
    });
    const feederIncidents = result.incidents.filter(
      (incident) => incident.type === 'feeder',
    );

    if (result.suppressedByOutage) {
      for (const dtId of candidate.dtIds) {
        skippedDtIds.add(dtId);
      }
      continue;
    }

    if (feederIncidents.length > 0) {
      const persistence = await persistLocalizedIncidentsFn(
        database,
        feederIncidents,
        now,
      );

      for (const dtId of candidate.dtIds) {
        skippedDtIds.add(dtId);
      }

      summaries.push({
        feederId,
        incidentCandidates: feederIncidents.length,
        ...persistence,
      });
      logger.info?.('Feeder fault detection persisted.', {
        feederId,
        incidentCandidates: feederIncidents.length,
        createdIncidentCount: persistence.createdIncidentCount,
        updatedIncidentCount: persistence.updatedIncidentCount,
      });
    } else {
      downgradedFeederIds.push(feederId);
    }
  }

  // Assumption: if a previously feeder-wide outage no longer localizes as
  // feeder-wide while some DTs remain dark, telemetry has disproven the feeder
  // scope. We mark that feeder incident verified/superseded and allow this
  // cycle to create narrower DT incidents; manual closure remains a separate
  // lifecycle step.
  const downgrade = await markOpenFeederIncidentsDowngradedFn(
    database,
    downgradedFeederIds,
    now,
  );

  for (const [dtId, candidate] of candidatesByDt.entries()) {
    if (skippedDtIds.has(dtId)) {
      continue;
    }

    const result = await localizeFaultsForDtFn(dtId, {
      db: database,
      now,
      confirmedDarkPoleIds: candidate.poleIds,
    });
    const persistence = await persistLocalizedIncidentsFn(
      database,
      result.incidents,
      now,
    );

    summaries.push({
      dtId,
      incidentCandidates: result.incidents.length,
      ...persistence,
    });
  }

  const verification = await autoVerifyIncidentsFn(database, { now });

  return {
    checkedDtCount: candidatesByDt.size,
    checkedFeederCount: candidatesByFeeder.size,
    confirmedDarkPoleCount: confirmedDarkPoles.length,
    skippedOutageDtCount: countSuppressedDts(confirmedDarkPoles, activeOutages),
    createdIncidentCount: summaries.reduce(
      (total, summary) => total + summary.createdIncidentCount,
      0,
    ),
    updatedIncidentCount: summaries.reduce(
      (total, summary) => total + summary.updatedIncidentCount,
      0,
    ),
    downgradedFeederIncidentCount:
      downgrade.downgradedFeederIncidentCount ?? 0,
    verifiedIncidentCount: verification.verifiedIncidentCount,
  };
}

export function buildActiveOutageSet(outageRows, now, options = {}) {
  const clock = normalizeDate(now).getTime();
  const beforeMs = options.beforeMs ?? OUTAGE_GRACE_BEFORE_MS;
  const afterMs = options.afterMs ?? OUTAGE_GRACE_AFTER_MS;
  const active = [];
  const keys = new Set();

  for (const outage of outageRows) {
    if (outage.isCancelled) {
      continue;
    }

    // Planned shutdowns are treated as active from 15 minutes before starts_at
    // until 45 minutes after ends_at. That grace window is an explicit
    // assumption for demos because field work often starts late and overruns.
    const startsAtDate = parseNullableDate(outage.startsAt);
    const endsAtDate = parseNullableDate(outage.endsAt);

    if (!startsAtDate || !endsAtDate) {
      continue;
    }

    const startsAt = startsAtDate.getTime() - beforeMs;
    const endsAt = endsAtDate.getTime() + afterMs;

    if (startsAt <= clock && clock <= endsAt) {
      active.push(outage);
      keys.add(outageKey(outage.scope, outage.targetId));
    }
  }

  return { active, keys };
}

export function selectConfirmedDarkPoles({
  darkPoles,
  recentEvents,
  now,
  debounceMs = DARK_DEBOUNCE_MS,
}) {
  const eventsByPole = groupBy(recentEvents, (event) => event.poleId);
  const clock = normalizeDate(now).getTime();

  return darkPoles.filter((pole) => {
    const darkRun = summarizeCurrentDarkRun(
      pole,
      eventsByPole.get(pole.poleId) ?? [],
    );

    if (darkRun.hasExplicitPowerLost) {
      return true;
    }

    return (
      darkRun.startedAt !== null &&
      clock - darkRun.startedAt.getTime() >= debounceMs
    );
  });
}

export function summarizeCurrentDarkRun(pole, events) {
  const currentSeq = Number(pole.lastSeq ?? 0);
  const orderedEvents = [...events]
    .filter((event) => Number(event.seq ?? 0) <= currentSeq)
    .sort((left, right) => Number(right.seq ?? 0) - Number(left.seq ?? 0));
  let startedAt = parseNullableDate(pole.lastSeenTs);
  let hasExplicitPowerLost = false;
  let hasSeenDarkEvent = false;

  for (const event of orderedEvents) {
    if (event.event === 'boot' && hasSeenDarkEvent) {
      break;
    }

    if (isLiveTelemetry(event)) {
      break;
    }

    if (isDarkTelemetry(event)) {
      hasSeenDarkEvent = true;
      hasExplicitPowerLost ||= event.event === 'power_lost';
      startedAt = eventTime(event) ?? startedAt;
    }
  }

  return {
    startedAt,
    hasExplicitPowerLost,
  };
}

async function fetchConfirmedDarkPoles(database, { now, debounceMs }) {
  const darkPoles = await database
    .select({
      poleId: poles.poleId,
      dtId: poles.dtId,
      feederId: poles.feederId,
      lastSeenTs: poles.lastSeenTs,
      lastSeq: poles.lastSeq,
    })
    .from(poles)
    .where(eq(poles.lastState, 'dark'));

  if (darkPoles.length === 0) {
    return [];
  }

  const since = new Date(now.getTime() - DARK_HISTORY_LOOKBACK_MS);
  const events = await database
    .select({
      poleId: telemetryEvents.poleId,
      event: telemetryEvents.event,
      energized: telemetryEvents.energized,
      seq: telemetryEvents.seq,
      deviceTs: telemetryEvents.deviceTs,
      receivedAt: telemetryEvents.receivedAt,
    })
    .from(telemetryEvents)
    .where(
      and(
        inArray(
          telemetryEvents.poleId,
          darkPoles.map((pole) => pole.poleId),
        ),
        gte(telemetryEvents.receivedAt, since),
      ),
    );

  return selectConfirmedDarkPoles({
    darkPoles,
    recentEvents: events,
    now,
    debounceMs,
  });
}

function groupConfirmedPolesByDt(confirmedDarkPoles, activeOutageKeys) {
  const groups = new Map();

  for (const pole of confirmedDarkPoles) {
    if (isSuppressedByOutage(pole, activeOutageKeys)) {
      continue;
    }

    const current = groups.get(pole.dtId) ?? {
      feederId: pole.feederId,
      poleIds: [],
    };
    current.poleIds.push(pole.poleId);
    groups.set(pole.dtId, current);
  }

  return groups;
}

function groupConfirmedPolesByFeeder(candidatesByDt) {
  const groups = new Map();

  for (const [dtId, candidate] of candidatesByDt.entries()) {
    const current = groups.get(candidate.feederId) ?? {
      dtIds: [],
      poleIds: [],
    };
    current.dtIds.push(dtId);
    current.poleIds.push(...candidate.poleIds);
    groups.set(candidate.feederId, current);
  }

  return groups;
}

function isSuppressedByOutage(pole, activeOutageKeys) {
  return (
    activeOutageKeys.has(outageKey('dt', pole.dtId)) ||
    activeOutageKeys.has(outageKey('feeder', pole.feederId))
  );
}

async function persistLocalizedIncidents(database, incidentCandidates, now) {
  let createdIncidentCount = 0;
  let updatedIncidentCount = 0;

  for (const candidate of incidentCandidates) {
    const existing = await findMatchingOpenIncident(database, candidate);

    if (existing) {
      await updateExistingIncident(database, existing.id, candidate, now);
      updatedIncidentCount += 1;
    } else {
      await createIncident(database, candidate, now);
      createdIncidentCount += 1;
    }
  }

  return {
    createdIncidentCount,
    updatedIncidentCount,
  };
}

export async function findMatchingOpenIncident(database, candidate) {
  const scopeClause = candidate.dtId
    ? eq(incidents.dtId, candidate.dtId)
    : eq(incidents.feederId, candidate.feederId);
  const openIncidents = await database
    .select({
      id: incidents.id,
      type: incidents.type,
      boundaryPoleId: incidents.boundaryPoleId,
    })
    .from(incidents)
    .where(and(scopeClause, inArray(incidents.status, OPEN_INCIDENT_STATUSES)));

  const compatibleOpenIncidents = openIncidents.filter((incident) =>
    isIncidentCompatibleWithCandidate(candidate, incident),
  );

  if (compatibleOpenIncidents.length === 0) {
    return null;
  }

  if (candidate.boundaryPoleId) {
    const sameBoundary = compatibleOpenIncidents.find(
      (incident) => incident.boundaryPoleId === candidate.boundaryPoleId,
    );

    if (sameBoundary) {
      return sameBoundary;
    }
  }

  const poleRows = await database
    .select({
      incidentId: incidentPoles.incidentId,
      poleId: incidentPoles.poleId,
    })
    .from(incidentPoles)
    .where(
      inArray(
        incidentPoles.incidentId,
        compatibleOpenIncidents.map((incident) => incident.id),
      ),
    );
  const candidatePoleIds = new Set(candidate.affectedPoleIds);

  return (
    compatibleOpenIncidents.find((incident) =>
      poleRows.some(
        (row) =>
          row.incidentId === incident.id && candidatePoleIds.has(row.poleId),
      ),
    ) ?? null
  );
}

function isIncidentCompatibleWithCandidate(candidate, incident) {
  return incident.type === candidate.type;
}

async function createIncident(database, candidate, now) {
  const [created] = await database
    .insert(incidents)
    .values(toIncidentInsert(candidate, now))
    .returning({ id: incidents.id });

  await replaceIncidentPoles(database, created.id, candidate.affectedPoleIds);
  await logIncidentEvent(database, created.id, 'detected', {
    incident: toIncidentPayload(candidate),
  });

  return created.id;
}

async function updateExistingIncident(database, incidentId, candidate, now) {
  await database
    .update(incidents)
    .set({
      boundaryPoleId: candidate.boundaryPoleId,
      boundaryParentId: candidate.boundaryParentId,
      lat: toNumeric(candidate.lat),
      lon: toNumeric(candidate.lon),
      pincode: candidate.pincode,
      affectedPoleCount: candidate.affectedPoleCount,
      confidence: toNumeric(candidate.confidence),
      confidenceReason: candidate.confidenceReason,
      topologySource: candidate.topologySource,
    })
    .where(eq(incidents.id, incidentId));

  await replaceIncidentPoles(database, incidentId, candidate.affectedPoleIds);
  await logIncidentEvent(database, incidentId, 'localization_updated', {
    updatedAt: now.toISOString(),
    incident: toIncidentPayload(candidate),
  });
}

async function replaceIncidentPoles(database, incidentId, poleIds) {
  await database
    .delete(incidentPoles)
    .where(eq(incidentPoles.incidentId, incidentId));

  if (poleIds.length === 0) {
    return;
  }

  await database.insert(incidentPoles).values(
    poleIds.map((poleId) => ({
      incidentId,
      poleId,
    })),
  );
}

async function logIncidentEvent(database, incidentId, eventType, payload) {
  await database.insert(incidentEvents).values({
    incidentId,
    eventType,
    payload,
  });
}

async function markOpenFeederIncidentsDowngraded(database, feederIds, now) {
  const uniqueFeederIds = [...new Set(feederIds)].filter(Boolean);

  if (uniqueFeederIds.length === 0) {
    return { downgradedFeederIncidentCount: 0 };
  }

  const openFeederIncidents = await database
    .select({
      id: incidents.id,
      feederId: incidents.feederId,
      status: incidents.status,
    })
    .from(incidents)
    .where(
      and(
        eq(incidents.type, 'feeder'),
        inArray(incidents.feederId, uniqueFeederIds),
        inArray(incidents.status, OPEN_INCIDENT_STATUSES),
      ),
    );

  for (const incident of openFeederIncidents) {
    await database
      .update(incidents)
      .set({
        status: 'verified',
        verifiedAt: now,
      })
      .where(eq(incidents.id, incident.id));
    await logIncidentEvent(database, incident.id, 'scope_downgraded', {
      fromStatus: incident.status,
      toStatus: 'verified',
      feederId: incident.feederId,
      downgradedAt: now.toISOString(),
      reason:
        'feeder no longer fully dark; remaining symptoms will be localized per DT',
    });
  }

  return {
    downgradedFeederIncidentCount: openFeederIncidents.length,
  };
}

async function autoVerifyIncidents(database, options = {}) {
  const now = normalizeDate(options.now ?? new Date());
  const liveWindowMs =
    options.liveWindowMs ?? DEFAULT_AUTO_VERIFY_LIVE_WINDOW_MS;
  const incidentRows = await database
    .select({
      id: incidents.id,
      status: incidents.status,
    })
    .from(incidents)
    .where(inArray(incidents.status, AUTO_VERIFY_STATUSES));

  if (incidentRows.length === 0) {
    return { verifiedIncidentCount: 0 };
  }

  const poleRows = await fetchIncidentPoleStates(
    database,
    incidentRows.map((incident) => incident.id),
  );
  const polesByIncident = groupBy(poleRows, (row) => row.incidentId);
  let verifiedIncidentCount = 0;

  for (const incident of incidentRows) {
    const affectedPoles = polesByIncident.get(incident.id) ?? [];

    if (!areAllAffectedPolesLiveRecently(affectedPoles, now, liveWindowMs)) {
      continue;
    }

    await database
      .update(incidents)
      .set({
        status: 'verified',
        verifiedAt: now,
      })
      .where(eq(incidents.id, incident.id));
    await logIncidentEvent(database, incident.id, 'auto_verified', {
      verifiedAt: now.toISOString(),
      reason: 'all affected poles reported live recently',
    });
    verifiedIncidentCount += 1;
  }

  return { verifiedIncidentCount };
}

async function fetchIncidentPoleStates(database, incidentIds) {
  return database
    .select({
      incidentId: incidentPoles.incidentId,
      poleId: incidentPoles.poleId,
      lastState: poles.lastState,
      lastSeenTs: poles.lastSeenTs,
    })
    .from(incidentPoles)
    .leftJoin(poles, eq(incidentPoles.poleId, poles.poleId))
    .where(inArray(incidentPoles.incidentId, incidentIds));
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
    .from(scheduledOutages)
    .where(eq(scheduledOutages.isCancelled, false));
}

function countSuppressedDts(confirmedDarkPoles, activeOutages) {
  const suppressedDtIds = new Set();

  for (const pole of confirmedDarkPoles) {
    if (isSuppressedByOutage(pole, activeOutages.keys)) {
      suppressedDtIds.add(pole.dtId);
    }
  }

  return suppressedDtIds.size;
}

function toIncidentInsert(candidate, now) {
  return {
    type: candidate.type,
    dtId: candidate.dtId,
    feederId: candidate.feederId,
    boundaryPoleId: candidate.boundaryPoleId,
    boundaryParentId: candidate.boundaryParentId,
    lat: toNumeric(candidate.lat),
    lon: toNumeric(candidate.lon),
    pincode: candidate.pincode,
    affectedPoleCount: candidate.affectedPoleCount,
    confidence: toNumeric(candidate.confidence),
    confidenceReason: candidate.confidenceReason,
    topologySource: candidate.topologySource,
    status: 'detected',
    detectedAt: now,
  };
}

function toIncidentPayload(candidate) {
  return {
    type: candidate.type,
    dtId: candidate.dtId,
    feederId: candidate.feederId,
    boundaryPoleId: candidate.boundaryPoleId,
    boundaryParentId: candidate.boundaryParentId,
    boundaryRange: candidate.boundaryRange,
    affectedPoleCount: candidate.affectedPoleCount,
    affectedPoleIds: candidate.affectedPoleIds,
    confidence: candidate.confidence,
    confidenceReason: candidate.confidenceReason,
    topologySource: candidate.topologySource,
  };
}

function isDarkTelemetry(event) {
  return event.event === 'power_lost' || event.energized === false;
}

function isLiveTelemetry(event) {
  return event.event === 'power_restored' || event.energized === true;
}

function eventTime(event) {
  return (
    parseNullableDate(event.receivedAt) ?? parseNullableDate(event.deviceTs)
  );
}

function outageKey(scope, targetId) {
  return `${scope}:${targetId}`;
}

function groupBy(values, keyFn) {
  const groups = new Map();

  for (const value of values) {
    const key = keyFn(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }

  return groups;
}

function normalizeDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function parseNullableDate(value) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function toNumeric(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}
