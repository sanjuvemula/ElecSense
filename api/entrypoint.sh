#!/bin/sh
set -eu

echo "Postgres dependency is healthy; running database migrations..."
npm run db:migrate -w api

echo "Running idempotent seed check..."
SEED_SKIP_MIGRATE=true npm run db:seed -w api

echo "Starting ElecSense API..."
exec "$@"
