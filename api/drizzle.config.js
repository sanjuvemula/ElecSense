import 'dotenv/config';

const url =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/elecsense';

// Managed Postgres (Render, Neon, Supabase) refuses plaintext connections and
// drops the socket, which drizzle-kit reports as a silent no-op rather than an
// error. Local Postgres usually has no TLS, so only remote hosts get ssl.
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

export default {
  schema: './src/db/schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url,
    ssl: isLocalDb ? false : 'require',
  },
};
