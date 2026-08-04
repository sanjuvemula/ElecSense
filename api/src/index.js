import 'dotenv/config';

import express from 'express';

import { db } from './db/index.js';
import { startDetectionLoop } from './jobs/detectionLoop.js';
import healthRoutes from './routes/health.js';
import incidentRoutes from './routes/incidents.js';
import telemetryRoutes from './routes/telemetry.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '5mb' }));
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/health', healthRoutes);

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;

  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
});

app.listen(port, () => {
  console.log(`API listening on port ${port}`);

  if (process.env.DETECTION_LOOP_DISABLED !== 'true') {
    startDetectionLoop({ db });
  }
});
