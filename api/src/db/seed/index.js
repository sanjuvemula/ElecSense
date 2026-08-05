import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { count } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from 'dotenv';
import postgres from 'postgres';

import * as schema from '../schema.js';
import { poles } from '../schema.js';
import { generateNetwork } from './generateNetwork.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, '../../..');
const rootDir = path.resolve(apiRoot, '..');

config({ path: path.join(rootDir, '.env') });
config({ path: path.join(apiRoot, '.env'), override: true });

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/elecsense';
const seed = process.env.NETWORK_SEED ?? process.env.SEED ?? 240731;
const groundTruthPath =
  process.env.GROUND_TRUTH_PATH ?? path.join(__dirname, 'groundTruth.json');

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });

try {
  if (process.env.SEED_SKIP_MIGRATE !== 'true') {
    await migrate(db, { migrationsFolder: path.join(apiRoot, 'drizzle') });
  }

  const [{ value: poleCount }] = await db
    .select({ value: count() })
    .from(poles);

  // Always regenerate the groundTruth.json file on every deployment.
// If the DB is empty, it will also seed the database.

const result = await generateNetwork(db, {
  seed,
  groundTruthPath,
});

console.log(
  [
    poleCount > 0
      ? 'Ground truth regenerated.'
      : 'Synthetic network seeded.',
    `seed=${result.seed}`,
    `feeders=${result.counts.feeders}`,
    `dts=${result.counts.dts}`,
    `poles=${result.counts.poles}`,
    `devices=${result.counts.devices}`,
    `scheduled_outages=${result.counts.scheduledOutages}`,
    `stripped_dts=${result.strippedDtIds.length}`,
    `ground_truth=${result.groundTruthPath}`,
  ].join(' '),
);
} finally {
  await client.end();
}
