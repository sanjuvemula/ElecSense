export const telemetryEventTypes = [
  'heartbeat',
  'power_lost',
  'power_restored',
  'boot',
];

/**
 * Decides how one normalized telemetry event affects mutable current state.
 *
 * This function is intentionally pure: it does not read from or write to the DB.
 * Callers provide the current device ordering cursor, then persist the returned
 * append row and optional state updates in a separate data-access layer.
 */
export function processTelemetryEvent(event, deviceState = null) {
  const telemetryRow = {
    deviceId: event.deviceId,
    poleId: event.poleId,
    event: event.event,
    energized: event.energized,
    deviceTs: event.deviceTs,
    seq: event.seq,
    batteryMv: event.batteryMv,
    rssi: event.rssi,
  };
  const isBoot = event.event === 'boot';
  const lastSeq =
    typeof deviceState?.lastSeq === 'number' ? deviceState.lastSeq : null;
  const isDuplicateOrStale =
    !isBoot && lastSeq !== null && event.seq <= lastSeq;

  if (isDuplicateOrStale) {
    return {
      accepted: false,
      reason: 'duplicate_or_stale_seq',
      telemetryRow,
      deviceUpdate: null,
      poleUpdate: null,
    };
  }

  return {
    accepted: true,
    reason: isBoot ? 'boot_seq_reset' : 'accepted',
    telemetryRow,
    deviceUpdate: {
      deviceId: event.deviceId,
      poleId: event.poleId,
      fwVersion: event.fwVersion,
      batteryMv: event.batteryMv,
      rssi: event.rssi,
      lastBootAt: isBoot ? event.deviceTs : null,
      lastSeq: event.seq,
      isBoot,
    },
    poleUpdate: {
      poleId: event.poleId,
      deviceId: event.deviceId,
      lastState: event.energized ? 'live' : 'dark',
      lastSeenTs: event.deviceTs,
      lastSeq: event.seq,
      isBoot,
    },
  };
}
