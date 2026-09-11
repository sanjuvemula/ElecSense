import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Router } from 'express';

import { db } from '../db/index.js';
import {
  mutationLimiter,
  requireOperatorToken,
} from '../middleware/security.js';
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
import {
  createTransitionPlan,
  INCIDENT_STATUSES,
  TransitionValidationError,
} from '../services/incidentLifecycle.js';
import { generateDispatchNote } from '../services/dispatchNote.js';

const allowedStatuses = new Set(INCIDENT_STATUSES);

export const DEFAULT_INCIDENT_LIMIT = 200;
export const MAX_INCIDENT_LIMIT = 1000;

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

    const limit = parseLimit(req.query.limit);

    if (limit === null) {
      res.status(400).json({
        error: 'Invalid limit',
        message: `limit must be an integer between 1 and ${MAX_INCIDENT_LIMIT}`,
      });
      return;
    }

    const incidentRows = await listIncidents(database, statuses, limit);
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
    const incident = await fetchIncidentById(database, req.params.id);

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

router.post('/:id/acknowledge', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  await handleTransitionRequest(req, res, next, {
    toStatus: 'acknowledged',
  });
});

router.post('/:id/assign-crew', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  await handleTransitionRequest(req, res, next, {
    toStatus: 'crew_assigned',
    bodyField: 'crewNote',
  });
});

router.post('/:id/mark-resolved', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  await handleTransitionRequest(req, res, next, {
    toStatus: 'resolved',
    bodyField: 'note',
    includeTelemetryWarning: true,
  });
});

router.post('/:id/close', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  await handleTransitionRequest(req, res, next, {
    toStatus: 'closed',
  });
});

router.post('/:id/dispatch-note', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    const database = requireDatabase();
    const regenerate = parseRegenerateFlag(req.body);
    const incident = await fetchIncidentById(database, req.params.id);

    if (!incident) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }

    const dispatchNote = await generateDispatchNote(incident, {
      regenerate,
    });
    const updatedIncident = await storeDispatchNote(
      database,
      incident.id,
      dispatchNote,
    );

    res.json({
      incident: updatedIncident,
      dispatchNote: dispatchNote.note,
      source: dispatchNote.source,
      reused: dispatchNote.reused,
      ...(dispatchNote.errorCode
        ? { fallbackReason: dispatchNote.errorCode }
        : {}),
    });
  } catch (error) {
    next(error);
  }
});

async function handleTransitionRequest(req, res, next, config) {
  try {
    const database = requireDatabase();
    const noteFields = parseOptionalBodyField(req.body, config.bodyField);
    const incident = await fetchIncidentById(database, req.params.id);

    if (!incident) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }

    const affectedPoles = config.includeTelemetryWarning
      ? await fetchIncidentPoles(database, incident.id)
      : [];
    const plan = createTransitionPlan({
      incident,
      toStatus: config.toStatus,
      now: new Date(),
      affectedPoles,
      ...noteFields,
    });
    const updatedIncident = await applyIncidentTransition(
      database,
      incident.id,
      plan,
      incident.status,
    );

    res.json({
      incident: updatedIncident,
      ...(plan.telemetryWarning ?? {}),
    });
  } catch (error) {
    next(error);
  }
}

async function listIncidents(database, statuses, limit) {
  const query = database.select().from(incidents);

  if (statuses.length > 0) {
    query.where(inArray(incidents.status, statuses));
  }

  return query.orderBy(desc(incidents.detectedAt)).limit(limit);
}

function parseLimit(value) {
  if (value === undefined) {
    return DEFAULT_INCIDENT_LIMIT;
  }

  const parsed = Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_INCIDENT_LIMIT
  ) {
    return null;
  }

  return parsed;
}

async function fetchIncidentById(database, incidentId) {
  const [incident] = await database
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);

  return incident ?? null;
}

async function applyIncidentTransition(
  database,
  incidentId,
  plan,
  expectedStatus,
) {
  const run = async (transaction) => {
    // Compare-and-swap on the status we validated against. Two concurrent
    // requests both read the same starting status, but only the first update
    // matches it, so the loser changes no rows and is rejected instead of
    // applying a second transition and logging a duplicate event.
    const updated = await transaction
      .update(incidents)
      .set(plan.statusPatch)
      .where(
        and(
          eq(incidents.id, incidentId),
          eq(incidents.status, expectedStatus),
        ),
      )
      .returning({ id: incidents.id });

    if (updated.length === 0) {
      throw new TransitionValidationError(
        'Incident status changed while this request was in flight. Reload the incident and try again.',
      );
    }

    await transaction.insert(incidentEvents).values({
      incidentId,
      eventType: plan.event.eventType,
      payload: plan.event.payload,
    });

    return fetchIncidentById(transaction, incidentId);
  };

  if (typeof database.transaction === 'function') {
    return database.transaction(run);
  }

  return run(database);
}

async function storeDispatchNote(database, incidentId, dispatchNote) {
  if (dispatchNote.reused) {
    return fetchIncidentById(database, incidentId);
  }

  const run = async (transaction) => {
    const [updatedIncident] = await transaction
      .update(incidents)
      .set({
        dispatchNote: dispatchNote.note,
        dispatchNoteSource: dispatchNote.source,
        dispatchNoteFingerprint: dispatchNote.fingerprint,
      })
      .where(eq(incidents.id, incidentId))
      .returning();

    await transaction.insert(incidentEvents).values({
      incidentId,
      eventType: 'dispatch_note_generated',
      payload: {
        source: dispatchNote.source,
        fallbackReason: dispatchNote.errorCode ?? null,
      },
    });

    return updatedIncident;
  };

  if (typeof database.transaction === 'function') {
    return database.transaction(run);
  }

  return run(database);
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

function parseOptionalBodyField(body, fieldName) {
  if (!fieldName || body?.[fieldName] === undefined) {
    return {};
  }

  if (typeof body[fieldName] !== 'string') {
    const error = new Error(`${fieldName} must be a string when provided.`);
    error.status = 400;
    throw error;
  }

  return { [fieldName]: body[fieldName] };
}

function parseRegenerateFlag(body) {
  if (body?.regenerate === undefined) {
    return false;
  }

  if (typeof body.regenerate !== 'boolean') {
    const error = new Error('regenerate must be a boolean when provided.');
    error.status = 400;
    throw error;
  }

  return body.regenerate;
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
