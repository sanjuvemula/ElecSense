import 'dotenv/config';

import express from 'express';

import healthRoutes from './routes/health.js';
import telemetryRoutes from './routes/telemetry.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '5mb' }));
app.use('/api/telemetry', telemetryRoutes);
app.use('/health', healthRoutes);

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;

  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
});

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
