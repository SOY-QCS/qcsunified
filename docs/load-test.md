# Load test: can QCS handle 10,000 deliveries a day?

**Answer: yes, with plenty of room.**

- **At 5× the expected busiest hour:** every call succeeded and 95% were answered in under 35 ms.
- **Dispatch kept up:** no job was ever handed to a dispatcher, and a dispatch round took 0.13 s typically, against a 5-second budget.
- **Found and fixed along the way:**
  - a bug that froze bookings once 100 parcels were booked on one route in the same minute;
  - a booking slowdown that grew every day;
  - analytics pages taking 7 s and 73 s;
  - dispatch rounds that could overrun after a flash sale.

Run it yourself (about 20 minutes, needs Postgres + PostGIS; nothing paid):

```bash
sudo -u postgres PLAIN_PG=1 DB_URL=postgresql:///postgres bash supabase/load-test/run.sh
# LOAD_DB=qcs_load_main builds the test database once and reuses it on later runs
```

## What was simulated

A throw-away database filled like a busy QCS after one month (`supabase/load-test/seed.sql`):

| | |
|---|---|
| History | 300,000 orders and 230,000 trips over 30 days (10,000 deliveries a day), 1.47 million status events, report rows for every order, 2 million location pings — 1.5 GB |
| People | 1,500 riders (1,200 online; 60% Accra, 20% Kumasi, 10% Takoradi, 10% Tamale), 3,000 customers, 300 vendors |

Then [pgbench](https://www.postgresql.org/docs/16/pgbench.html) (comes with Postgres) plays real people at the rate of the busiest hour. Each call runs the same database functions the apps use:

| What happens | Calls per second at peak | Where the number comes from |
|---|---|---|
| Rider phone sends its position | 70 | 1,200 online riders: ~700 on a job every 12 s, ~500 idle every 60 s |
| Someone books (¾ Express, ¼ e-commerce) | 0.42 | busiest hour = 15% of 10,000 a day = 1,500 bookings |
| Rider answers a job offer | 0.6 | about 1.4 offers per Express job |
| Rider moves a job one step (incl. delivery code + signature) | 2.1 | ~5 steps per delivery |
| Public tracking page view | 2 | ~5 views per parcel |
| Dispatch round | every 5 s | as scheduled in production |

All of it ran on one small cloud machine with shared processors, which ran both the database and the load generator. Supabase's paid compute is faster, so treat these numbers as a floor.

## Results (after the fixes)

### Busiest hour (1×, 75 calls/s, 2 minutes)

| Call | Calls | Typical (p50) | 95% under | 99% under |
|---|---|---|---|---|
| Location ping | 8,200 | 2.3 ms | 4.2 ms | 12.0 ms |
| Booking | 53 | 17.8 ms | 46.7 ms | 185 ms |
| Answer offer | 70 | 8.5 ms | 25.4 ms | 38.0 ms |
| Job step | 252 | 6.9 ms | 28.6 ms | 33.5 ms |
| Tracking page | 235 | 1.3 ms | 4.9 ms | 6.5 ms |
| Dispatch round | 24 | 19 ms | | max 273 ms |

0 failed calls. 155 orders booked, 109 delivered in the 2 minutes, 0 waiting for a rider at the end.

### Five times the busiest hour (5×, 375 calls/s, 2 minutes)

| Call | Calls | Typical (p50) | 95% under | 99% under |
|---|---|---|---|---|
| Location ping | 42,200 | 2.2 ms | 5.6 ms | 10.4 ms |
| Booking | 253 | 14.2 ms | 34.3 ms | 239 ms |
| Answer offer | 345 | 6.6 ms | 25.5 ms | 41.3 ms |
| Job step | 1,220 | 7.3 ms | 32.0 ms | 53.6 ms |
| Tracking page | 1,151 | 0.9 ms | 2.9 ms | 8.8 ms |
| Dispatch round | 19 | 129 ms | | max 1.0 s |

0 failed calls. 394 booked, 250 delivered, 26 being offered to riders at the moment the test stopped, 0 sent to a dispatcher.

### Flash sale: 300 Express bookings in the same moment

The first dispatch round took **2.6 s**: it started the oldest 150 jobs and sent 176 offers. The rest were picked up in the next round 5 seconds later.

### Heavy pages and jobs (30 days, 300,000 orders)

| Page / job | Time |
|---|---|
| Analytics overview, all cities, 30 days | 0.74 s (was ~7 s) |
| Analytics riders, all 1,500 riders, 30 days | 2.8 s (was 73 s) |
| Analytics vendors | 0.08 s |
| Demand map, Accra, 30 days | 0.50 s |
| Live map, Accra | 0.05 s |
| Exceptions board, all cities | 0.03 s |
| Public tracking, one parcel | 0.006 s |
| Fraud scan (hourly) | 1.7 s |
| Idle-ping clean-up (daily) | 0.001 s |

A single city or a shorter period is proportionally faster.

## What the test found, and what was fixed

| Problem | Effect | Fix (migration) |
|---|---|---|
| **Tracking numbers looped forever** from the 100th parcel on one route in the same minute ("-100" was cut to "-10") | A vendor bulk-uploading 100+ orders to one city would freeze, and block every booking on that route | Suffixes now run -02 … -99, -100 … (`…400_performance.sql`, test `170_load_fixes.sql`) |
| A booking looked up its own orders without an index | 0.2 s per booking at 300,000 orders, getting slower every day | Index on `orders.quote_id`, plus 7 other look-ups the apps use (`…400_performance.sql`) |
| Rider reports looked up trips rider by rider without an index | Riders analytics took 73 s | Index on `trips.rider_id` (`…400_performance.sql`) |
| The analytics overview joined the full orders table and repeated the same summary 9 times | 7 s for the 30-day overview | Fee and COD kept on the report row, one pass for totals, cities and services (`…700_analytics_speed.sql`) |
| One dispatch round handled every waiting job at once | 4.6 s after a 300-job flash sale, close to the 5 s schedule | At most 150 jobs per round, oldest first (`…400_performance.sql`) |

## What to watch as QCS grows

- **Location history.** Job-time pings are kept as trip history: about 150 per delivery, so ~45 million rows a month at 10,000 a day (about 5 GB a month). This is fine for months. Decide a retention rule (for example, keep 90 days and then summarise each trip) before the database plan gets expensive. Idle pings are already deleted after 7 days.
- **Supabase plan.** Use at least a *Small* compute instance at launch, then watch the database CPU and connections graph after the first busy weeks.
- **Riders report for all cities.** At 2.8 s for 30 days and all cities it is fine today. If QCS reaches several thousand riders, give it the same treatment as the overview.
