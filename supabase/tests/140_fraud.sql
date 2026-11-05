-- =====================================================================
-- Phase 13 tests: fraud flags. Each pattern is staged once "bad" and once "normal",
-- then the hourly scan must flag the bad one only. Also: reviewing, alerts, who may see what.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone, email) values
  ('00000000-0000-0000-0000-000000001401', '+233200001401', null),   -- customers 1-3 share phone DEV-A
  ('00000000-0000-0000-0000-000000001402', '+233200001402', null),
  ('00000000-0000-0000-0000-000000001403', '+233200001403', null),
  ('00000000-0000-0000-0000-000000001404', '+233200001404', null),   -- vendor owner (shop phone DEV-B with 2 staff)
  ('00000000-0000-0000-0000-000000001405', '+233200001405', null),
  ('00000000-0000-0000-0000-000000001406', '+233200001406', null),
  ('00000000-0000-0000-0000-000000001407', '+233200001407', null),   -- customer who cancels a lot
  ('00000000-0000-0000-0000-000000001408', '+233200001408', null),   -- normal customer
  ('00000000-0000-0000-0000-000000001410', '+233200001410', 'super@qcsghana.com'),
  ('00000000-0000-0000-0000-000000001411', '+233200001411', 'accra-admin@qcsghana.com'),
  ('00000000-0000-0000-0000-000000001412', '+233200001412', 'disp14@qcsghana.com'),
  ('00000000-0000-0000-0000-000000001420', '+233200001420', null),   -- rider who "fails" a lot and spoofs GPS
  ('00000000-0000-0000-0000-000000001421', '+233200001421', null),   -- good rider (but delivers away from the pin)
  ('00000000-0000-0000-0000-000000001422', '+233200001422', null);   -- rider with impossible jumps
update profiles set email = u.email from auth.users u where u.id = profiles.id and u.email is not null;
update profiles set full_name = 'Rider Kofi' where id = '00000000-0000-0000-0000-000000001420';
create temp table k as select (select id from cities where code = 'ACC') acc;
grant select on k to anon, authenticated, service_role;
insert into user_roles (user_id, role) values ('00000000-0000-0000-0000-000000001410', 'super_admin');
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001411', 'city_admin', acc from k;
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001412', 'dispatcher', acc from k;
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000001401', '00000000-0000-0000-0000-000000001404', 'Bad Returns Ltd', acc from k;
insert into vendor_staff (vendor_id, user_id, permissions) values ('10000000-0000-0000-0000-000000001401', '00000000-0000-0000-0000-000000001405', '{book}'),
                                                               ('10000000-0000-0000-0000-000000001401', '00000000-0000-0000-0000-000000001406', '{book}');
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000001420', 'bike', 'GR-1420'), ('50000000-0000-0000-0000-000000001421', 'bike', 'GR-1421'),
                                                     ('50000000-0000-0000-0000-000000001422', 'bike', 'GR-1422');
insert into riders (id, rider_type, status, city_id, vehicle_id) select ('00000000-0000-0000-0000-00000000' || n)::uuid, 'fleet', 'active', acc, ('50000000-0000-0000-0000-00000000' || n)::uuid
  from k, unnest(array['1420', '1421', '1422']) n;

-- an order: who booked it, which rider, which recipient phone; inserted already finished (history added below)
create function tests.o14(p_n int, p_customer text, p_vendor uuid, p_rider text, p_phone text, p_final text) returns uuid language plpgsql as $$
declare oid uuid := ('30000000-0000-0000-0000-0000000' || lpad(p_n::text, 5, '0'))::uuid;
begin
  insert into orders (id, service_type, city_id, vendor_id, customer_id, rider_id, pickup_location, dropoff_location, recipient_name, recipient_phone,
                      weight_g, quoted_fee, payer, payment_method, status, created_at)
  select oid, case when p_vendor is null then 'express' else 'ecommerce' end::service_type, acc, p_vendor,
         ('00000000-0000-0000-0000-00000000' || p_customer)::uuid, ('00000000-0000-0000-0000-00000000' || p_rider)::uuid,
         st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography, st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography, 'Esi', p_phone,
         1000, 2500, case when p_vendor is null then 'sender' else 'vendor_wallet' end::payer_type, case when p_vendor is null then 'cash' else 'wallet' end::payment_method,
         p_final::order_status, now() - interval '2 days'
  from k;
  return oid;
end $$;
-- one history step: who did it, how long ago, where
create function tests.ev14(p_order uuid, p_from text, p_to text, p_actor text, p_hours_ago int, p_reason text default null, p_lng float8 default null, p_lat float8 default null)
returns void language sql as $$
  insert into order_events (order_id, from_status, to_status, actor_id, reason, location, created_at)
  values (p_order, p_from::order_status, p_to::order_status, case when p_actor is not null then ('00000000-0000-0000-0000-00000000' || p_actor)::uuid end,
          p_reason, case when p_lng is not null then st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography end, now() - make_interval(hours => p_hours_ago)) $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;
alter table orders disable trigger orders_created_event;

-- =====================================================================
-- 1. Phones: register, and who may call it
-- =====================================================================
select tests.login(null);
select tests.expect_error($$select public.register_device('DEV-A-0001', 'client', 'android', 'Tecno')$$, 'permission denied', 'visitors cannot register a phone');
select tests.login('00000000-0000-0000-0000-000000001401');
select public.register_device('DEV-A-0001', 'client', 'android', 'Tecno Spark 10');
select public.register_device('DEV-A-0001', 'client', 'android', 'Tecno Spark 10');      -- again: just updates last_seen
select tests.expect_error($$select public.register_device('x', 'client')$$, 'unknown device', 'nonsense device id refused');
select tests.ok((select count(*) from device_logins) = 1, 'a customer sees only their own phone record');
select tests.login('00000000-0000-0000-0000-000000001402'); select public.register_device('DEV-A-0001', 'client', 'android', 'Tecno Spark 10');
select tests.login('00000000-0000-0000-0000-000000001403'); select public.register_device('DEV-A-0001', 'client', 'android', 'Tecno Spark 10');
select tests.ok((select count(*) from device_logins) = 1, 'other accounts on the same phone stay invisible to a customer');
-- the vendor's shop phone: owner + 2 staff = fine
select tests.login('00000000-0000-0000-0000-000000001404'); select public.register_device('DEV-B-SHOP', 'client', 'android');
select tests.login('00000000-0000-0000-0000-000000001405'); select public.register_device('DEV-B-SHOP', 'client', 'android');
select tests.login('00000000-0000-0000-0000-000000001406'); select public.register_device('DEV-B-SHOP', 'client', 'android');
-- a dispatcher's test phone with two customer accounts: staff don't count, so only 2
select tests.login('00000000-0000-0000-0000-000000001412'); select public.register_device('DEV-C-TEST', 'client', 'android');
select tests.login('00000000-0000-0000-0000-000000001407'); select public.register_device('DEV-C-TEST', 'client', 'android');
select tests.login('00000000-0000-0000-0000-000000001408'); select public.register_device('DEV-C-TEST', 'client', 'android');

-- =====================================================================
-- 2. GPS: fake-location app (rider 1420) and impossible jumps (rider 1422)
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001420');
select public.rider_ping(-0.17, 5.60, 10, true) from generate_series(1, 3);
select public.rider_ping(-0.17, 5.60, 10);                                     -- old app versions (no mocked value) still work
select tests.logout();
select tests.ok((select count(*) filter (where suspect) = 3 and count(*) filter (where mocked) = 3 from rider_location_pings where rider_id = '00000000-0000-0000-0000-000000001420'),
                'fake-location readings are kept as suspicious even while idle');
-- jumps: 5 km between readings 10 seconds apart = 1,800 km/h
do $$ declare i int; begin
  for i in 1..3 loop
    update riders set last_location = st_setsrid(st_makepoint(-0.25, 5.60), 4326)::geography, last_location_at = now() - interval '10 seconds' where id = '00000000-0000-0000-0000-000000001422';
    perform tests.login('00000000-0000-0000-0000-000000001422');
    perform public.rider_ping(-0.205, 5.60, 15);
    perform tests.logout();
  end loop;
end $$;
-- a normal ride: 2 km in 6 minutes (20 km/h) is not suspicious
update riders set last_location = st_setsrid(st_makepoint(-0.20, 5.60), 4326)::geography, last_location_at = now() - interval '6 minutes' where id = '00000000-0000-0000-0000-000000001421';
select tests.login('00000000-0000-0000-0000-000000001421'); select public.rider_ping(-0.182, 5.60, 15); select tests.logout();
select tests.ok((select count(*) from rider_location_pings where rider_id = '00000000-0000-0000-0000-000000001422' and suspect and speed_kmh > 1000) = 3, 'impossible jumps recorded with their speed');
select tests.ok(not exists (select 1 from rider_location_pings where rider_id = '00000000-0000-0000-0000-000000001421' and suspect), 'normal riding is not suspicious');
-- a jump with a poor GPS fix (accuracy 300 m) is ignored
update riders set last_location = st_setsrid(st_makepoint(-0.25, 5.60), 4326)::geography, last_location_at = now() - interval '10 seconds' where id = '00000000-0000-0000-0000-000000001421';
select tests.login('00000000-0000-0000-0000-000000001421'); select public.rider_ping(-0.205, 5.60, 300); select tests.logout();
select tests.ok(not exists (select 1 from rider_location_pings where rider_id = '00000000-0000-0000-0000-000000001421' and suspect), 'jumps with a poor GPS fix are ignored');

-- =====================================================================
-- 3. Deliveries
-- =====================================================================
-- rider 1420: 10 attempts, 4 failed (40% ≥ 30%) → flagged
select tests.ev14(tests.o14(n, '1408', null, '1420', '+2332400' || lpad(n::text, 5, '0'), case when n <= 4 then 'FAILED_ATTEMPT' else 'DELIVERED' end),
                  'ARRIVED_AT_DROPOFF', case when n <= 4 then 'FAILED_ATTEMPT' else 'DELIVERED' end, '1420', 30, case when n <= 4 then 'recipient_unreachable' end)
  from generate_series(1, 10) n;
-- rider 1421: 10 attempts, 1 failed → fine, but 3 deliveries marked done 1.1 km from the pin → flagged for that
select tests.ev14(tests.o14(100 + n, '1408', null, '1421', '+2332410' || lpad(n::text, 5, '0'), case when n = 1 then 'FAILED_ATTEMPT' else 'DELIVERED' end),
                  'ARRIVED_AT_DROPOFF', case when n = 1 then 'FAILED_ATTEMPT' else 'DELIVERED' end, '1421', 30, null,
                  case when n between 2 and 4 then -0.151 else -0.161 end, 5.6355)
  from generate_series(1, 10) n;
-- recipient +233249999999: 3 failed/returned deliveries from 2 different senders → flagged (high)
select tests.ev14(tests.o14(200 + n, case when n = 1 then '1401' else '1408' end, null, '1421', '+233249999999', 'RETURNED'), 'RETURNING_TO_SENDER', 'RETURNED', '1421', 20)
  from generate_series(1, 3) n;
-- recipient with just 2 failures → fine
select tests.ev14(tests.o14(210 + n, '1408', null, '1421', '+233248888888', 'FAILED_ATTEMPT'), 'ARRIVED_AT_DROPOFF', 'FAILED_ATTEMPT', '1421', 20, 'refused')
  from generate_series(1, 2) n;
-- vendor: 20 orders, 9 came back (45% ≥ 40%) → flagged
select tests.ev14(tests.o14(300 + n, '1404', '10000000-0000-0000-0000-000000001401', '1422', '+2332430' || lpad(n::text, 5, '0'), case when n <= 9 then 'RETURNED' else 'DELIVERED' end),
                  'IN_TRANSIT', case when n <= 9 then 'RETURNED' else 'DELIVERED' end, '1422', 40)
  from generate_series(1, 20) n;

-- =====================================================================
-- 4. Cancellations
-- =====================================================================
-- customer 1407: 6 bookings cancelled by themselves today, 5 after a rider was assigned → flagged (high)
select tests.ev14(tests.o14(400 + n, '1407', null, '1421', '+233244000000', 'CANCELLED'), case when n <= 5 then 'ASSIGNED' else 'CONFIRMED' end, 'CANCELLED', '1407', 2)
  from generate_series(1, 6) n;
-- customer 1408's orders cancelled by DISPATCH: not the customer's doing
select tests.ev14(tests.o14(500 + n, '1408', null, '1421', '+233244000001', 'CANCELLED'), 'CONFIRMED', 'CANCELLED', '1412', 2) from generate_series(1, 6) n;

-- =====================================================================
-- 5. The scan
-- =====================================================================
select tests.ok((select public.fraud_scan() ->> 'new')::int = 8, 'scan raised 8 new flags');
select tests.ok((select array_agg(kind || ':' || subject_key order by kind, subject_key) from fraud_flags) = array[
  'cancellations:00000000-0000-0000-0000-000000001407',
  'far_deliveries:00000000-0000-0000-0000-000000001421',
  'gps_spoofing:00000000-0000-0000-0000-000000001420',
  'gps_spoofing:00000000-0000-0000-0000-000000001422',
  'recipient_failures:+233249999999',
  'rider_failures:00000000-0000-0000-0000-000000001420',
  'shared_device:DEV-A-0001',
  'vendor_failures:10000000-0000-0000-0000-000000001401'], 'exactly the bad patterns are flagged (shop phone, staff test phone, good rider, 2-failure recipient, dispatch cancels are not)');
select tests.ok((select bool_and(severity = 'high') from fraud_flags where kind in ('cancellations', 'recipient_failures') or (kind = 'gps_spoofing' and subject_key like '%1420')), 'deliberate-looking patterns are high priority');
select tests.ok((select severity from fraud_flags where kind = 'gps_spoofing' and subject_key like '%1422') = 'medium', 'jumps alone are medium (could be a bad phone)');
select tests.ok((select summary from fraud_flags where kind = 'rider_failures') = '4 of 10 delivery attempts marked failed in 7 days (40%)', 'rider summary is plain English');
select tests.ok((select evidence -> 'reasons' ->> 'recipient_unreachable' from fraud_flags where kind = 'rider_failures') = '4', 'evidence lists the failure reasons');
select tests.ok((select jsonb_array_length(evidence -> 'accounts') from fraud_flags where kind = 'shared_device') = 3, 'evidence lists the accounts on the phone');
select tests.ok((select summary from fraud_flags where kind = 'vendor_failures') = '9 of 20 orders failed or came back in 7 days (45%)', 'vendor flagged at 45% returns');
-- the vendor's returns were carried by rider 1422, but a return is not a failed delivery attempt
select tests.ok(not exists (select 1 from fraud_flags where kind = 'rider_failures' and subject_key like '%1422'), 'returns are not counted as the rider''s failed attempts');

-- running again finds the same things: nothing new, no duplicate flags, no second email
select tests.ok((select count(*) from notifications where template = 'fraud_alert') = 2, 'one alert email each to the Super Admin and the Accra City Admin');
select tests.ok((select payload ->> 'count' from notifications where template = 'fraud_alert' and user_id = '00000000-0000-0000-0000-000000001410') = '3',
                'the alert covers the 3 new high-priority flags');
select tests.ok((select public.fraud_scan() ->> 'new')::int = 0, 'second scan: nothing new');
select tests.ok((select count(*) from fraud_flags) = 8 and (select min(times_seen) from fraud_flags) = 2, 'same flags, seen twice');
select tests.ok((select count(*) from notifications where template = 'fraud_alert') = 2, 'no repeat emails');

-- =====================================================================
-- 6. Who sees and reviews
-- =====================================================================
create temp table f14 as select id, kind from fraud_flags;
grant select on f14 to anon, authenticated, service_role;
select tests.login('00000000-0000-0000-0000-000000001408');
select tests.ok((select count(*) from fraud_flags) = 0 and public.fraud_list() = '[]'::jsonb, 'customers see no flags');
select tests.expect_error($$select public.fraud_scan()$$, 'permission denied', 'apps cannot run the scan');
select tests.login('00000000-0000-0000-0000-000000001412');
select tests.ok(jsonb_array_length(public.fraud_list()) = 8, 'dispatcher sees the Accra flags');
select tests.ok((select bool_and(not (x ->> 'can_review')::boolean) from jsonb_array_elements(public.fraud_list()) x), '… but cannot review them');
select tests.ok((select x ->> 'subject_name' from jsonb_array_elements(public.fraud_list('open', 'rider_failures')) x) = 'Rider Kofi', 'list shows names, filtered by kind');
select tests.ok((public.fraud_list() -> 0 ->> 'severity') = 'high', 'high priority first');
select tests.expect_error(format($q$select public.review_fraud_flag(%L, 'dismissed', 'looks fine')$q$, (select id from f14 where kind = 'shared_device')), 'only a super admin', 'dispatcher cannot review');
select tests.login('00000000-0000-0000-0000-000000001411');
select tests.expect_error(format($q$select public.review_fraud_flag(%L, 'dismissed', '')$q$, (select id from f14 where kind = 'shared_device')), 'short note', 'a note is required');
select public.review_fraud_flag((select id from f14 where kind = 'shared_device'), 'dismissed', 'Family phone: three sisters, called them.');
select public.review_fraud_flag((select id from f14 where kind = 'gps_spoofing' limit 1), 'confirmed', 'Mock-location app found on the phone; rider suspended.');
select tests.expect_error(format($q$select public.review_fraud_flag(%L, 'confirmed', 'again')$q$, (select id from f14 where kind = 'shared_device')), 'already reviewed', 'cannot review twice');
select tests.ok(jsonb_array_length(public.fraud_list('dismissed')) = 1 and (public.fraud_list('dismissed') -> 0 ->> 'reviewed_by') is not null, 'dismissed list shows who decided');
select tests.logout();
select tests.ok((select count(*) from audit_log where table_name = 'fraud_flags' and reason in ('Family phone: three sisters, called them.', 'Mock-location app found on the phone; rider suspended.')) = 2,
                'every review is in the audit log with its note');
-- a dismissed flag is not raised again for 30 days
select public.fraud_scan();
select tests.ok((select count(*) from fraud_flags where kind = 'shared_device') = 1, 'dismissed phone not flagged again');

-- a new pattern later DOES make a new flag and a new alert
insert into rider_location_pings (rider_id, location, mocked, suspect)
select '00000000-0000-0000-0000-000000001421', st_setsrid(st_makepoint(-0.17, 5.6), 4326)::geography, true, true from generate_series(1, 3);
select tests.ok((select public.fraud_scan() ->> 'new')::int = 1, 'new fake-location rider flagged');
select tests.ok((select count(*) from notifications where template = 'fraud_alert') = 4, '… and admins alerted again');

rollback;