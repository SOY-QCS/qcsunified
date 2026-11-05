-- =====================================================================
-- Phase 13 tests: problems found by the load test stay fixed.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql
-- a test that hangs is a failing test: give up after 20 seconds
set local statement_timeout = '20s';

-- 1. 150 parcels on the same route in the same minute (a vendor's bulk upload) all get a number, and -100 is not cut to -10
insert into orders (service_type, city_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method)
select 'ecommerce', c.id, st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography, st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography,
       'R' || g, '+233240000000', 1000, 2500, 'sender', 'cash'
from cities c, generate_series(1, 150) g where c.code = 'ACC';
select tests.ok((select count(distinct tracking_number) from orders where created_at = now()) = 150, '150 parcels in one minute, 150 different tracking numbers');
select tests.ok((select count(*) from orders where created_at = now() and tracking_number ~ '-(02|99|100|150)$') = 4, 'numbers run -02 … -99, -100 … -150');

-- 2. a booking finds its own orders through an index (it used to read the whole orders table)
select tests.ok(exists (select 1 from pg_indexes where tablename = 'orders' and indexdef like '%(quote_id)%'), 'orders are indexed by quote');

rollback;
