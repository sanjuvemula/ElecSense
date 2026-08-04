import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTransitionPlan,
  TransitionValidationError,
} from './incidentLifecycle.js';

const now = new Date('2026-08-04T10:00:00.000Z');

test('valid transition succeeds with timestamp and status_changed event', () => {
  const plan = createTransitionPlan({
    incident: incident('detected'),
    toStatus: 'acknowledged',
    now,
  });

  assert.equal(plan.statusPatch.status, 'acknowledged');
  assert.equal(plan.statusPatch.acknowledgedAt, now);
  assert.equal(plan.event.eventType, 'status_changed');
  assert.deepEqual(plan.event.payload, {
    fromStatus: 'detected',
    toStatus: 'acknowledged',
    changedAt: now.toISOString(),
  });
});

test('invalid transition is rejected with a 409 validation error', () => {
  assert.throws(
    () =>
      createTransitionPlan({
        incident: incident('acknowledged'),
        toStatus: 'resolved',
        now,
      }),
    (error) => {
      assert.equal(error instanceof TransitionValidationError, true);
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Cannot change incident status from acknowledged to resolved/,
      );
      assert.match(error.message, /Valid next status: crew_assigned/);
      return true;
    },
  );
});

test('mark-resolved reports dark-pole telemetry mismatch without blocking', () => {
  const plan = createTransitionPlan({
    incident: incident('crew_assigned'),
    toStatus: 'resolved',
    now,
    note: 'Crew replaced fuse and restored downstream span.',
    affectedPoles: [
      { poleId: 'P-1', lastState: 'live' },
      { poleId: 'P-2', lastState: 'dark' },
      { poleId: 'P-3', lastState: 'dark' },
    ],
  });

  assert.equal(plan.statusPatch.status, 'resolved');
  assert.equal(plan.statusPatch.resolvedAt, now);
  assert.deepEqual(plan.telemetryWarning, {
    telemetryMismatch: true,
    mismatchCount: 2,
    message: '2 of 3 affected poles are still reporting dark',
  });
  assert.equal(
    plan.event.payload.note,
    'Crew replaced fuse and restored downstream span.',
  );
});

test('close is rejected until telemetry has verified the incident', () => {
  assert.throws(
    () =>
      createTransitionPlan({
        incident: incident('resolved'),
        toStatus: 'closed',
        now,
      }),
    (error) => {
      assert.equal(error instanceof TransitionValidationError, true);
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Cannot close incident while current status is resolved/,
      );
      assert.match(error.message, /must be verified by telemetry/);
      return true;
    },
  );
});

function incident(status) {
  return {
    id: 'INC-1',
    status,
  };
}
