import { asc, desc, eq, inArray } from 'drizzle-orm';
import { Router } from 'express';

import { db } from '../db/index.js';
import {
  incidentEvents,
  incidentPoles,
  incidents,
  poles,
} from '../db/schema.js';
import {
  hasTelemetryDisagreement,
  DEFAULT_AUTO_VERIFY_LIVE_WINDOW_MS,
} from '../services/incidentTelemetry.js';

const allowedStatuses = new Set([
  'detected',
  'acknowledged',
  'crew_assigned',
  'resolved',
  'verified',
  'closed',
]);

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const database = requireDatabase();
    const statuses = parseStatusFilter(req.query.status);

    if (statuses === null) {
      res.status(400).json({
        error: 'Invalid status filter',
        message:
          'status must be one or more of detected, acknowledged, crew_assigned, resolved, verified, closed',
      });
      return;
    }

    const incidentRows = await listIncidents(database, statuses);
    const disagreementMap = await buildTelemetryDisagreementMap(
      database,
      incidentRows,
      new Date(),
    );

    res.json({
      incidents: incidentRows.map((incident) => ({
        ...incident,
        telemetryDisagrees: disagreementMap.get(incident.id) ?? false,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const database = requireDatabase();
    const [incident] = await database
      .select()
      .from(incidents)
      .where(eq(incidents.id, req.params.id))
      .limit(1);

    if (!incident) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }

    const [affectedPoles, timeline] = await Promise.all([
      fetchIncidentPoles(database, incident.id),
      fetchIncidentEvents(database, incident.id),
    ]);

    res.json({
      incident: {
        ...incident,
        telemetryDisagrees: hasTelemetryDisagreement(
          incident,
          affectedPoles,
          new Date(),
          DEFAULT_AUTO_VERIFY_LIVE_WINDOW_MS,
        ),
      },
      incidentPoles: affectedPoles,
      incidentEvents: timeline,
    });
  } catch (error) {
    next(error);
  }
});

async function listIncidents(database, statuses) {
  let query = database
    .select()
    .from(incidents)
    .orderBy(desc(incidents.detectedAt));

  if (statuses.length > 0) {
    query = database
      .select()
      .from(incidents)
      .where(inArray(incidents.status, statuses))
      .orderBy(desc(incidents.detectedAt));
  }

  return query;
}

async function buildTelemetryDisagreementMap(database, incidentRows, now) {
  const resolvedIncidents = incidentRows.filter(
    (incident) => incident.status === 'resolved',
  );
  const result = new Map();

  if (resolvedIncidents.length === 0) {
    return result;
  }

  const poleRows = await fetchIncidentPoles(
    database,
    resolvedIncidents.map((incident) => incident.id),
  );
  const polesByIncident = groupBy(poleRows, (row) => row.incidentId);

  for (const incident of resolvedIncidents) {
    result.set(
      incident.id,
      hasTelemetryDisagreement(
        incident,
        polesByIncident.get(incident.id) ?? [],
        now,
      ),
    );
  }

  return result;
}

async function fetchIncidentPoles(database, incidentIdOrIds) {
  const incidentIds = Array.isArray(incidentIdOrIds)
    ? incidentIdOrIds
    : [incidentIdOrIds];

  if (incidentIds.length === 0) {
    return [];
  }

  return database
    .select({
      incidentId: incidentPoles.incidentId,
      poleId: incidentPoles.poleId,
      lat: poles.lat,
      lon: poles.lon,
      feederId: poles.feederId,
      dtId: poles.dtId,
      deviceId: poles.deviceId,
      lastState: poles.lastState,
      lastSeenTs: poles.lastSeenTs,
    })
    .from(incidentPoles)
    .leftJoin(poles, eq(incidentPoles.poleId, poles.poleId))
    .where(inArray(incidentPoles.incidentId, incidentIds));
}

async function fetchIncidentEvents(database, incidentId) {
  return database
    .select()
    .from(incidentEvents)
    .where(eq(incidentEvents.incidentId, incidentId))
    .orderBy(asc(incidentEvents.createdAt));
}

function parseStatusFilter(value) {
  if (value === undefined) {
    return [];
  }

  const rawValues = Array.isArray(value) ? value : String(value).split(',');
  const statuses = rawValues.map((status) => status.trim()).filter(Boolean);

  if (statuses.some((status) => !allowedStatuses.has(status))) {
    return null;
  }

  return statuses;
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

function requireDatabase() {
  if (!db) {
    const error = new Error('DATABASE_URL is not configured.');
    error.status = 503;
    throw error;
  }

  return db;
}

export default router;
