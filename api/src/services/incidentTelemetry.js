// A resolved incident is only auto-verified when every affected pole has sent a
// live event recently. Ten minutes is an operational assumption: it is short
// enough for the UI to flag disagreement quickly, while allowing normal
// heartbeat jitter in the synthetic network.
export const DEFAULT_AUTO_VERIFY_LIVE_WINDOW_MS = 10 * 60 * 1000;

export function areAllAffectedPolesLiveRecently(
  poleRows,
  now,
  liveWindowMs = DEFAULT_AUTO_VERIFY_LIVE_WINDOW_MS,
) {
  if (poleRows.length === 0) {
    return false;
  }

  const cutoff = normalizeDate(now).getTime() - liveWindowMs;

  return poleRows.every((row) => {
    const lastSeen = parseNullableDate(row.lastSeenTs);

    return (
      row.lastState === 'live' &&
      lastSeen !== null &&
      lastSeen.getTime() >= cutoff
    );
  });
}

export function hasTelemetryDisagreement(
  incident,
  poleRows,
  now,
  liveWindowMs = DEFAULT_AUTO_VERIFY_LIVE_WINDOW_MS,
) {
  return (
    incident.status === 'resolved' &&
    !areAllAffectedPolesLiveRecently(poleRows, now, liveWindowMs)
  );
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
