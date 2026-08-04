import { Router } from 'express';

import { db } from '../db/index.js';
import {
  getSimulatorNetwork,
  injectDeadSensor,
  injectDtFault,
  injectFeederFault,
  injectScheduledOutage,
  injectSpanFault,
  repairFault,
} from '../simulator/simulator.js';

const router = Router();

router.get('/network', async (_req, res, next) => {
  try {
    res.json(await getSimulatorNetwork({ db: requireDatabase() }));
  } catch (error) {
    next(error);
  }
});

router.post('/span-fault', async (req, res, next) => {
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

router.post('/dt-fault', async (req, res, next) => {
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

router.post('/feeder-fault', async (req, res, next) => {
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

router.post('/dead-sensor', async (req, res, next) => {
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

router.post('/scheduled-outage', async (req, res, next) => {
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

router.post('/repair/:incidentId', async (req, res, next) => {
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
