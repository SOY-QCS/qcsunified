#!/usr/bin/env bash
# Checks that every query and database-function call in the apps works against the real Supabase API layer (PostgREST):
# catches misspelled columns, ambiguous joins and wrong argument names before they reach users.
#   PLAIN_PG=1 DB_URL=postgresql:///postgres bash supabase/tests/api-check.sh     (run as the postgres user)
# Downloads PostgREST (free, open source, ~20 MB) into /tmp the first time (run the script once as your normal user if the postgres user has no internet).
set -euo pipefail
cd "$(dirname "$0")/.."
VER=v12.2.3; BIN=/tmp/postgrest-$VER/postgrest
if [[ ! -x $BIN ]]; then
  mkdir -p /tmp/postgrest-$VER
  curl -sSL "https://github.com/PostgREST/postgrest/releases/download/$VER/postgrest-$VER-linux-static-x64.tar.xz" | tar xJ -C /tmp/postgrest-$VER
fi
ADMIN="${DB_URL:?set DB_URL}"; DB="qcs_api_$$"; URL="${ADMIN%/*}/$DB"
psql "$ADMIN" -qc "create database $DB"
trap 'kill $PID 2>/dev/null || true; psql "$ADMIN" -qc "drop database if exists $DB" >/dev/null' EXIT
psql "$ADMIN" -qc "alter database $DB set search_path = \"\$user\", public, extensions"
psql "$URL" -q -v ON_ERROR_STOP=1 -f tests/00_supabase_shim.sql
for f in migrations/*.sql seed.sql; do psql "$URL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
psql "$URL" -qc "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'qcs_authenticator') then create role qcs_authenticator login password 'pw' noinherit; end if; end \$\$;
                 grant anon, authenticated, service_role to qcs_authenticator;"
SECRET=api-check-secret-at-least-32-characters-long
printf 'db-uri = "postgres://qcs_authenticator:pw@127.0.0.1:5432/%s"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "%s"\nserver-port = 3901\n' "$DB" "$SECRET" > /tmp/qcs-pgrst.conf
$BIN /tmp/qcs-pgrst.conf > /tmp/qcs-pgrst.log 2>&1 & PID=$!
sleep 2
DB_URL="$URL" JWT_SECRET=$SECRET node tests/api-check.mjs
