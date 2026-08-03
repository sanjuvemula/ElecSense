import 'dotenv/config';

import express from 'express';

import healthRoutes from './routes/health.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use('/health', healthRoutes);

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
