#!/usr/bin/env bash
# Runs the database tests.
#   • With Supabase running locally (`pnpm db:start`): DB_URL defaults to the local Supabase database.
#   • On plain Postgres + PostGIS: set PLAIN_PG=1 and DB_URL; a throw-away database is created.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${PLAIN_PG:-}" == "1" ]]; then
  ADMIN_URL="${DB_URL:?set DB_URL to an admin connection, e.g. postgresql://postgres@localhost/postgres}"
  TEST_DB="qcs_test_$$"
  psql "$ADMIN_URL" -qc "create database $TEST_DB"
  psql "$ADMIN_URL" -qc "alter database $TEST_DB set search_path = \"\$user\", public, extensions"
  trap 'psql "$ADMIN_URL" -qc "drop database if exists $TEST_DB" >/dev/null' EXIT
  URL="${ADMIN_URL%/*}/$TEST_DB"
  psql "$URL" -q -v ON_ERROR_STOP=1 -f tests/00_supabase_shim.sql
  for f in migrations/*.sql; do echo "→ $f"; psql "$URL" -q -v ON_ERROR_STOP=1 -f "$f"; done
  echo "→ seed.sql"; psql "$URL" -q -v ON_ERROR_STOP=1 -f seed.sql
else
  URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
fi

for f in tests/[1-9]*.sql; do
  echo "→ $f"
  psql "$URL" -q -v ON_ERROR_STOP=1 -o /dev/null -f "$f"
done
echo "✅ All database tests passed"
