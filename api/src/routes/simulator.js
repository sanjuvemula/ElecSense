import { Router } from 'express';

import { db } from '../db/index.js';
import {
  mutationLimiter,
  requireOperatorToken,
} from '../middleware/security.js';
import {
  getSimulatorNetwork,
  getSimulatorNetworkStates,
  injectDeadSensor,
  injectDuplicateTelemetry,
  injectDtFault,
  injectFeederFault,
  injectOutOfOrderTelemetry,
  injectScheduledOutage,
  injectSpanFault,
  repairFault,
  unsilenceDevice,
} from '../simulator/simulator.js';

const router = Router();

router.get('/network', async (_req, res, next) => {
  try {
    res.json(await getSimulatorNetwork({ db: requireDatabase() }));
  } catch (error) {
    next(error);
  }
});

router.get('/network/states', async (_req, res, next) => {
  try {
    res.json(await getSimulatorNetworkStates({ db: requireDatabase() }));
  } catch (error) {
    next(error);
  }
});

router.post('/span-fault', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await injectSpanFault(req.body, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/dt-fault', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await injectDtFault(req.body, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/feeder-fault', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await injectFeederFault(req.body, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/dead-sensor', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await injectDeadSensor(req.body, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/unsilence', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await unsilenceDevice(req.body, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/scheduled-outage', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await injectScheduledOutage(req.body, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/duplicate-telemetry', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await injectDuplicateTelemetry(req.body, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/out-of-order-telemetry', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await injectOutOfOrderTelemetry(req.body, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/repair/:incidentId', mutationLimiter, requireOperatorToken(), async (req, res, next) => {
  try {
    res.status(202).json(
      await repairFault(req.params.incidentId, {
        db: requireDatabase(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

function requireDatabase() {
  if (!db) {
    const error = new Error('DATABASE_URL is not configured.');
    error.status = 503;
    throw error;
  }

  return db;
}

export default router;
