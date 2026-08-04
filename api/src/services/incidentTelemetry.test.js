import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areAllAffectedPolesLiveRecently,
  hasTelemetryDisagreement,
} from './incidentTelemetry.js';

test('all affected poles live recently permits auto verification', () => {
  const now = new Date('2026-08-04T10:00:00.000Z');

  assert.equal(
    areAllAffectedPolesLiveRecently(
      [
        {
          poleId: 'P-1',
          lastState: 'live',
          lastSeenTs: new Date('2026-08-04T09:58:00.000Z'),
        },
        {
          poleId: 'P-2',
          lastState: 'live',
          lastSeenTs: new Date('2026-08-04T09:59:00.000Z'),
        },
      ],
      now,
    ),
    true,
  );
});

test('resolved incident reports telemetry disagreement while a pole stays dark', () => {
  const now = new Date('2026-08-04T10:00:00.000Z');

  assert.equal(
    hasTelemetryDisagreement(
      { status: 'resolved' },
      [
        {
          poleId: 'P-1',
          lastState: 'live',
          lastSeenTs: new Date('2026-08-04T09:58:00.000Z'),
        },
        {
          poleId: 'P-2',
          lastState: 'dark',
          lastSeenTs: new Date('2026-08-04T09:59:00.000Z'),
        },
      ],
      now,
    ),
    true,
  );
});
