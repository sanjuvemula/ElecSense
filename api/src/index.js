import 'dotenv/config';

import express from 'express';

import { db } from './db/index.js';
import { startDetectionLoop } from './jobs/detectionLoop.js';
import healthRoutes from './routes/health.js';
import incidentRoutes from './routes/incidents.js';
import simulatorRoutes from './routes/simulator.js';
import telemetryRoutes from './routes/telemetry.js';
import cors from 'cors';
const app = express();

app.use(
  cors({
    origin: [
      'https://elec-sense-web.vercel.app',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  })
);
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '5mb' }));
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/simulator', simulatorRoutes);
app.use('/health', healthRoutes);

app.use((err, req, res, _next) => {
  const status = err.status ?? 500;

  console.error('Unhandled request error.', {
    method: req.method,
    path: req.originalUrl,
    status,
    message: err.message,
    stack: err.stack,
  });

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
