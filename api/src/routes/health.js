import { Router } from 'express';
import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';

const router = Router();

router.get('/', async (_req, res) => {
  if (!db) {
    res.status(503).json({ status: 'unhealthy', database: 'not configured' });
    return;
  }

  try {
    await db.execute(sql`select 1`);
    res.json({ status: 'ok', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'unhealthy', database: 'unreachable' });
  }
});

export default router;
