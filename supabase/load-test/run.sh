#!/usr/bin/env bash
# Load test: can the database handle 10,000 deliveries a day? (results and how to read them: docs/load-test.md)
#   PLAIN_PG=1 DB_URL=postgresql:///postgres bash supabase/load-test/run.sh      (run as the postgres user)
# Creates a throw-away database, fills it with 30 days of history, replays a peak hour at 1x and 5x the
# expected load with pgbench (comes with Postgres, free), then times the heavy pages. Takes about 15 minutes.
#   SECONDS_PER_RUN=120 (default) · KEEP_DB=1 keeps the database afterwards · LOAD_DB=name builds once, then reuses it.
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN="${DB_URL:?set DB_URL to an admin connection, e.g. postgresql:///postgres}"
DB="${LOAD_DB:-qcs_load_$$}"; URL="${ADMIN%/*}/$DB"; T="${SECONDS_PER_RUN:-120}"
OUT="$(mktemp -d)"; SUP="$(pwd)"
[[ -z "${KEEP_DB:-}${LOAD_DB:-}" ]] && trap 'psql "$ADMIN" -qc "drop database if exists $DB" >/dev/null' EXIT

if [[ -n "${LOAD_DB:-}" ]] && psql "$URL" -qAtc "select 1 from loadtest.id('b', 1) limit 0" >/dev/null 2>&1; then
  echo "▶ reusing seeded database $DB"
else
echo "▶ building $DB (migrations + 30 days of history, ~3 min)"
psql "$ADMIN" -qc "create database $DB"
psql "$ADMIN" -qc "alter database $DB set search_path = \"\$user\", public, extensions"
psql "$URL" -q -v ON_ERROR_STOP=1 -f tests/00_supabase_shim.sql >/dev/null
for f in migrations/*.sql seed.sql; do psql "$URL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
psql "$URL" -q -v ON_ERROR_STOP=1 -f load-test/seed.sql
fi

# Peak hour at 10,000 deliveries/day (see docs/load-test.md for where these numbers come from), per second:
#   location pings 70 · bookings 0.42 · offer answers 0.6 · job steps 2.1 · tracking views 2  → ~75 calls/s
# pgbench weights are those rates x100.
MIX="-f load-test/scripts/ping.sql@7000 -f load-test/scripts/book.sql@42 -f load-test/scripts/answer.sql@60 -f load-test/scripts/advance.sql@210 -f load-test/scripts/track.sql@200"
NAMES=(ping book answer advance track)

pct() {  # p50 / p95 / p99 / max latency (ms) per script from pgbench's per-call log (column 4 = which script)
  for i in "${!NAMES[@]}"; do
    cat "$1"/pgbench_log* | awk -v s="$i" '$4 == s { print $3 / 1000 }' | sort -n > "$1/lat.$i"
    awk -v name="${NAMES[$i]}" '{ a[NR] = $1 } END { if (NR) printf "   %-8s calls %6d   p50 %7.1f ms   p95 %7.1f ms   p99 %7.1f ms   max %7.1f ms\n", name, NR, a[int(NR*.5)+1], a[int(NR*.95)+1], a[int(NR*.99)+1], a[NR] }' "$1/lat.$i"
  done
}
run() {  # $1 = label, $2 = calls per second
  local d="$OUT/$1"; mkdir -p "$d/tick"
  psql "$URL" -qc "update riders set last_location_at = now() where is_online" >/dev/null
  echo "▶ $1: $2 calls/s for ${T}s (+ dispatch every 5 s)"
  (cd "$d/tick" && pgbench -n -c 1 -T "$T" -R 0.2 -l -f "$SUP/load-test/scripts/tick.sql" "$URL" > "$d/tick.txt" 2>&1) &
  (cd "$d" && pgbench -n -c 24 -j 4 -T "$T" -R "$2" -l $(echo $MIX | sed "s#load-test/#$SUP/load-test/#g") "$URL" > "$d/mix.txt" 2>&1)
  wait
  grep -E "^(tps|number of failed|number of transactions skipped|latency average)" "$d/mix.txt" | sed 's/^/   /' || true
  pct "$d"
  cat "$d"/tick/pgbench_log* | awk '{print $3/1000}' | sort -n | awk '{a[NR]=$1} END{printf "   dispatch tick: %d runs, p50 %.0f ms, max %.0f ms (must stay well under 5,000 ms)\n", NR, a[int(NR*.5)+1], a[NR]}'
  psql "$URL" -qAt -c "select '   orders booked ' || count(*) || ' · delivered ' || count(*) filter (where status = 'DELIVERED') || ' · still searching ' || count(*) filter (where status = 'SEARCHING_RIDER') || ' · waiting for dispatcher ' || (select count(*) from trips where dispatch_state = 'escalated') from orders where created_at > now() - interval '30 minutes'"
}
run "peak-1x" 75
run "peak-5x" 375

echo "▶ flash sale: 300 Express bookings at once, 1,200 riders online"
psql "$URL" -q -c "update riders set last_location_at = now() where is_online" -c "select count(*) from (select loadtest.book(2000000 + g) from generate_series(1, 300) g) b" >/dev/null
psql "$URL" -qAt -c "\\timing on" -c "select loadtest.tick()" | grep Time | sed 's/^/   first dispatch tick for 300 new jobs: /'
psql "$URL" -qAt -c "select '   offers out after one tick: ' || count(*) from job_offers where status = 'offered'"

echo "▶ heavy pages and jobs (30 days, 300,000 orders)"
psql "$URL" -qAt <<'SQL' | grep -E "^(   |Time)" | paste - - | awk -F'\t' '{printf "%-48s %s\n", $1, $2}'
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', false) \g /dev/null
\timing on
select '   analytics overview, all cities, 30 days' || left(coalesce((public.analytics_overview(null, current_date - 29, current_date, null))::text, ''), 0);
select '   analytics riders, 30 days' || left(coalesce((public.analytics_riders(null, current_date - 29, current_date))::text, ''), 0);
select '   analytics vendors, 30 days' || left(coalesce((public.analytics_vendors(null, current_date - 29, current_date, 50))::text, ''), 0);
select '   demand heatmap, Accra, 30 days' || left(coalesce((public.analytics_heatmap((select id from cities where code = 'ACC'), current_date - 29, current_date, null))::text, ''), 0);
select '   live map, Accra' || left(coalesce((public.ops_live_map((select id from cities where code = 'ACC')))::text, ''), 0);
select '   exceptions board, all cities' || left(count(*)::text, 0) from public.ops_exceptions(null) x;
select '   public tracking (one parcel)' || left(coalesce((public.track_order((select tracking_number from orders limit 1), null))::text, ''), 0);
select '   fraud scan (hourly job)' || left(coalesce((public.fraud_scan())::text, ''), 0);
select '   clean-up of idle pings (daily job)' || left(coalesce((public.purge_idle_location_pings())::text, ''), 0);
SQL
psql "$URL" -qAt -c "select '   database size after the test: ' || pg_size_pretty(pg_database_size(current_database()))"
echo "✅ load test finished (raw pgbench output: $OUT)"
