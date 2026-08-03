import { Router } from 'express';

import { db } from '../db/index.js';
import {
  getTelemetryStats,
  ingestTelemetryEvents,
  parseTelemetryPayload,
} from '../services/telemetryIngestion.js';

const router = Router();

router.get('/stats', async (_req, res, next) => {
  try {
    const database = requireDatabase();
    const stats = await getTelemetryStats(database);

    res.json(stats);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  const parsed = parseTelemetryPayload(req.body);

  if (!parsed.ok) {
    res.status(400).json({
      error: 'Invalid telemetry payload',
      message: parsed.message,
    });
    return;
  }

  try {
    const database = requireDatabase();
    const result = await ingestTelemetryEvents(database, parsed.events);

    res.status(202).json(result);
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
