export const VALID_TRANSITIONS = Object.freeze({
  detected: ['acknowledged'],
  acknowledged: ['crew_assigned'],
  crew_assigned: ['resolved', 'verified'],
  resolved: ['verified'],
  verified: ['closed'],
  closed: [],
});

export const INCIDENT_STATUSES = Object.freeze(Object.keys(VALID_TRANSITIONS));

const STATUS_TIMESTAMP_FIELDS = Object.freeze({
  acknowledged: 'acknowledgedAt',
  crew_assigned: 'crewAssignedAt',
  resolved: 'resolvedAt',
  verified: 'verifiedAt',
  closed: 'closedAt',
});

export class TransitionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransitionValidationError';
    this.status = 409;
  }
}

export function createTransitionPlan({
  incident,
  toStatus,
  now,
  note,
  crewNote,
  affectedPoles = [],
}) {
  validateTransition(incident.status, toStatus);

  const changedAt = normalizeDate(now);
  const timestampField = STATUS_TIMESTAMP_FIELDS[toStatus];
  const statusPatch = {
    status: toStatus,
  };

  if (timestampField) {
    statusPatch[timestampField] = changedAt;
  }

  return {
    statusPatch,
    event: {
      eventType: 'status_changed',
      payload: buildStatusChangePayload({
        fromStatus: incident.status,
        toStatus,
        changedAt,
        note,
        crewNote,
      }),
    },
    telemetryWarning:
      toStatus === 'resolved'
        ? buildResolvedTelemetryWarning(affectedPoles)
        : null,
  };
}

export function validateTransition(fromStatus, toStatus) {
  const allowedNextStatuses = VALID_TRANSITIONS[fromStatus];

  if (!allowedNextStatuses) {
    throw new TransitionValidationError(
      `Cannot change incident status from unknown status ${fromStatus} to ${toStatus}.`,
    );
  }

  if (allowedNextStatuses.includes(toStatus)) {
    return true;
  }

  if (toStatus === 'closed') {
    throw new TransitionValidationError(
      `Cannot close incident while current status is ${fromStatus}; it must be verified by telemetry before it can be closed.`,
    );
  }

  throw new TransitionValidationError(
    `Cannot change incident status from ${fromStatus} to ${toStatus}. Valid next status: ${formatAllowedStatuses(
      allowedNextStatuses,
    )}.`,
  );
}

export function buildResolvedTelemetryWarning(affectedPoles) {
  const mismatchCount = affectedPoles.filter(
    (pole) => pole.lastState === 'dark',
  ).length;
  const totalCount = affectedPoles.length;

  if (mismatchCount === 0) {
    return {
      telemetryMismatch: false,
      mismatchCount: 0,
      message: null,
    };
  }

  return {
    telemetryMismatch: true,
    mismatchCount,
    message: `${mismatchCount} of ${totalCount} affected poles are still reporting dark`,
  };
}

function buildStatusChangePayload({
  fromStatus,
  toStatus,
  changedAt,
  note,
  crewNote,
}) {
  return {
    fromStatus,
    toStatus,
    changedAt: changedAt.toISOString(),
    ...(note !== undefined ? { note } : {}),
    ...(crewNote !== undefined ? { crewNote } : {}),
  };
}

function formatAllowedStatuses(statuses) {
  return statuses.length > 0 ? statuses.join(', ') : 'none';
}

function normalizeDate(value) {
  return value instanceof Date ? value : new Date(value);
}
