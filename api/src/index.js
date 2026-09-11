import 'dotenv/config';

import express from 'express';

import { db } from './db/index.js';
import { startDetectionLoop } from './jobs/detectionLoop.js';
import {
  readLimiter,
  warnIfWritesAreUnprotected,
} from './middleware/security.js';
import healthRoutes from './routes/health.js';
import incidentRoutes from './routes/incidents.js';
import simulatorRoutes from './routes/simulator.js';
import telemetryRoutes from './routes/telemetry.js';
import cors from 'cors';
const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const allowedOriginPatterns = [
  /^https:\/\/elec-sense-web(-[a-z0-9-]+)?\.vercel\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/,
];

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin and non-browser clients (curl, health checks) send no Origin.
      if (!origin) {
        callback(null, true);
        return;
      }

      const allowed =
        allowedOrigins.includes(origin) ||
        allowedOriginPatterns.some((pattern) => pattern.test(origin));

      // Report a disallowed origin by omitting the CORS headers, not by
      // raising. Passing an Error here turns a routine cross-origin rejection
      // into a 500 from the error handler, which hides the real cause.
      callback(null, allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  })
);

// Render (and any reverse proxy) terminates TLS upstream, so the rate limiter
// must read the client address from X-Forwarded-For rather than the socket.
app.set('trust proxy', 1);
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(readLimiter);
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
  warnIfWritesAreUnprotected();

  if (process.env.DETECTION_LOOP_DISABLED !== 'true') {
    startDetectionLoop({ db });
  }
});
