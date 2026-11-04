-- =====================================================================
-- Phase 5 tests: dispatch engine, rider job flow, proof of delivery, COD, offline replays, WhatsApp backup.
-- Scene: a pickup in Osu; riders at different distances around Accra.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000000401', '+233200000401'),  -- R1 bike, 500 m away
  ('00000000-0000-0000-0000-000000000402', '+233200000402'),  -- R2 bike, 2 km
  ('00000000-0000-0000-0000-000000000403', '+233200000403'),  -- R3 bike, 4 km
  ('00000000-0000-0000-0000-000000000404', '+233200000404'),  -- R4 offline
  ('00000000-0000-0000-0000-000000000405', '+233200000405'),  -- R5 Kumasi
  ('00000000-0000-0000-0000-000000000406', '+233200000406'),  -- R6 COD-blocked, 300 m
  ('00000000-0000-0000-0000-000000000407', '+233200000407'),  -- R7 car, 100 m
  ('00000000-0000-0000-0000-000000000410', '+233200000410'),  -- customer
  ('00000000-0000-0000-0000-000000000411', '+233200000411'),  -- vendor owner
  ('00000000-0000-0000-0000-000000000412', '+233200000412');  -- dispatcher
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000412', 'dispatcher', id from cities where code = 'ACC';
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000411', 'Kente Hub', id from cities where code = 'ACC';

insert into vehicles (id, type, plate_number, max_weight_g) values
  ('50000000-0000-0000-0000-000000000001', 'bike', 'GR-1', 15000), ('50000000-0000-0000-0000-000000000002', 'bike', 'GR-2', 15000),
  ('50000000-0000-0000-0000-000000000003', 'bike', 'GR-3', 15000), ('50000000-0000-0000-0000-000000000004', 'bike', 'GR-4', 15000),
  ('50000000-0000-0000-0000-000000000005', 'bike', 'AS-5', 15000), ('50000000-0000-0000-0000-000000000006', 'bike', 'GR-6', 15000),
  ('50000000-0000-0000-0000-000000000007', 'car', 'GR-7', 100000);
insert into riders (id, rider_type, status, city_id, vehicle_id, is_online, last_location, last_location_at, cod_blocked)
select v.id, 'fleet', 'active', c.id, v.veh, v.online, st_setsrid(st_makepoint(v.lng, v.lat), 4326)::geography, now(), v.blocked
from (values
  ('00000000-0000-0000-0000-000000000401'::uuid, '50000000-0000-0000-0000-000000000001'::uuid, true,  -0.1735, 5.556, false, 'ACC'),
  ('00000000-0000-0000-0000-000000000402', '50000000-0000-0000-0000-000000000002', true,  -0.1600, 5.556, false, 'ACC'),
  ('00000000-0000-0000-0000-000000000403', '50000000-0000-0000-0000-000000000003', true,  -0.1420, 5.556, false, 'ACC'),
  ('00000000-0000-0000-0000-000000000404', '50000000-0000-0000-0000-000000000004', false, -0.1770, 5.556, false, 'ACC'),
  ('00000000-0000-0000-0000-000000000405', '50000000-0000-0000-0000-000000000005', true,  -1.6200, 6.690, false, 'KSI'),
  ('00000000-0000-0000-0000-000000000406', '50000000-0000-0000-0000-000000000006', true,  -0.1755, 5.556, true,  'ACC'),
  ('00000000-0000-0000-0000-000000000407', '50000000-0000-0000-0000-000000000007', true,  -0.1775, 5.556, false, 'ACC')
) v(id, veh, online, lng, lat, blocked, city) join cities c on c.code = v.city;

create temp table k as select (select id from cities where code = 'ACC') acc, (select id from zones where code = 'ACC-ELG') legon;
grant select on k to anon, authenticated, service_role;

create function tests.book(p_user uuid, p_payer text, p_method text, p_drops int, p_vendor uuid default null, p_cod int default 0, p_ref text default 'D')
returns jsonb language plpgsql as $$
declare qid uuid; req jsonb;
begin
  req := jsonb_build_object('service', case when p_vendor is null then 'express' else 'ecommerce' end, 'payer', p_payer, 'payment_method', p_method,
    'pickup', jsonb_build_object('formatted_address', 'Oxford St, Osu', 'lat', 5.556, 'lng', -0.178, 'contact_name', 'Ama', 'contact_phone', '+233241111111'),
    'dropoffs', (select jsonb_agg(jsonb_build_object('formatted_address', 'Lagos Ave ' || g, 'lat', 5.6355, 'lng', -0.161, 'contact_name', 'Esi ' || g,
       'contact_phone', '+233242000000', 'weight_g', 1000, 'size', 'small', 'fragile', false, 'item_value', 0, 'cod_amount', p_cod,
       'external_ref', case when p_vendor is null then null else p_ref || g end)) from generate_series(1, p_drops) g));
  insert into quotes (user_id, vendor_id, service_type, city_id, request, price, zones, total)
  select p_user, p_vendor, (req ->> 'service')::service_type, acc, req,
         jsonb_build_object('stops', (select jsonb_agg(jsonb_build_object('netPesewas', 3000, 'insurancePesewas', 0, 'lines', '[]'::jsonb)) from generate_series(1, p_drops))),
         (select jsonb_agg(z) from (select k2.legon z from k k2, generate_series(1, p_drops)) s), 3000 * p_drops from k
  returning id into qid;
  return create_booking(p_user, qid);
end $$;
create function tests.offer_for(p_trip uuid) returns uuid language sql as $$ select rider_id from job_offers where trip_id = p_trip and status = 'offered' $$;
create function tests.code_for(p_order uuid) returns text language sql as $$
  select payload ->> 'code' from notifications where order_id = p_order and template = 'delivery_code' order by created_at desc, id desc limit 1 $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- =====================================================================
-- 1. An Express booking becomes a job and is offered to the nearest eligible rider
-- =====================================================================
select tests.service();
create temp table j1 as select (tests.book('00000000-0000-0000-0000-000000000410', 'sender', 'cash', 1) -> 'orders' -> 0 ->> 'id')::uuid oid;
grant select on j1 to anon, authenticated, service_role;
select tests.logout();
create temp table t1 as select trip_id id from orders where id = (select oid from j1);
grant select on t1 to anon, authenticated, service_role;
select tests.ok((select trip_type = 'express' and dispatch_state = 'queued' from trips where id = (select id from t1)), 'confirmed Express order gets its own trip, queued for dispatch');
select tests.ok((select count(*) from order_stops where trip_id = (select id from t1)) = 2, 'trip has a pickup and a drop-off stop');

select dispatch_tick();
select tests.ok((select status = 'SEARCHING_RIDER' from orders where id = (select oid from j1)), 'order is now SEARCHING_RIDER');
select tests.ok(tests.offer_for((select id from t1)) = '00000000-0000-0000-0000-000000000407' is false, 'the car rider (100 m) is not offered an Express job');
select tests.ok(tests.offer_for((select id from t1)) = '00000000-0000-0000-0000-000000000406', 'nearest bike rider (300 m) gets the offer — COD block only matters for COD jobs');
select tests.ok((select expires_at between now() + interval '19 seconds' and now() + interval '21 seconds' from job_offers where trip_id = (select id from t1) and status = 'offered'), 'offer lasts 20 seconds');

select tests.login('00000000-0000-0000-0000-000000000406');
select tests.ok((my_offer() ->> 'pickup') = 'Oxford St, Osu' and (my_offer() ->> 'fee')::int = 3000, 'rider sees the offer: pickup and fee');
select tests.login('00000000-0000-0000-0000-000000000401');
select tests.ok(my_offer() is null and (select count(*) from job_offers) = 0, 'other riders see nothing');

-- R6 rejects → straight to the next nearest (R1, 500 m)
select tests.login('00000000-0000-0000-0000-000000000406');
select tests.ok(respond_offer((select id from job_offers where rider_id = auth.uid() and status = 'offered'), false) = 'rejected', 'R6 rejects');
select tests.logout();
select tests.ok(tests.offer_for((select id from t1)) = '00000000-0000-0000-0000-000000000401', 'offer moves at once to the next nearest rider (R1)');
select tests.ok((select score from riders where id = '00000000-0000-0000-0000-000000000406') = 98, 'rejection costs R6 2 score points');

-- R1 doesn't answer → timeout → R2
update job_offers set expires_at = now() - interval '1 second' where rider_id = '00000000-0000-0000-0000-000000000401' and status = 'offered';
select dispatch_tick();
select tests.ok((select status = 'expired' from job_offers where rider_id = '00000000-0000-0000-0000-000000000401') and tests.offer_for((select id from t1)) = '00000000-0000-0000-0000-000000000402',
  'unanswered offer expires and goes to R2');
select tests.ok((select score from riders where id = '00000000-0000-0000-0000-000000000401') = 98, 'a missed offer also counts against the score');

-- R2 accepts
select tests.login('00000000-0000-0000-0000-000000000402');
select tests.ok(respond_offer((select id from job_offers where rider_id = auth.uid() and status = 'offered'), true) = 'accepted', 'R2 accepts');
select tests.ok((select status = 'ASSIGNED' and rider_id = auth.uid() from orders where id = (select oid from j1)), 'order ASSIGNED to R2');
select tests.ok((my_job() -> 'trip' ->> 'status') = 'ASSIGNED' and jsonb_array_length(my_job() -> 'orders') = 1, 'R2''s app shows the job');
select tests.ok((select offers_received = 1 and offers_accepted = 1 from riders where id = auth.uid()), 'acceptance rate counted');

-- =====================================================================
-- 2. One job at a time; escalation; dispatcher assigns by hand
-- =====================================================================
select tests.logout();
update app_settings set value = '2' where key = 'dispatch_max_rejections' and city_id is null;
select tests.service();
create temp table j2 as select (tests.book('00000000-0000-0000-0000-000000000410', 'sender', 'cash', 1) -> 'orders' -> 0 ->> 'id')::uuid oid;
grant select on j2 to anon, authenticated, service_role;
select tests.logout();
create temp table t2 as select trip_id id from orders where id = (select oid from j2);
grant select on t2 to anon, authenticated, service_role;
select dispatch_tick();
select tests.ok(tests.offer_for((select id from t2)) = '00000000-0000-0000-0000-000000000406', 'second job offered to R6 again (a new job)');
select tests.ok(not exists (select 1 from candidate_riders((select id from t2)) where rider_id = '00000000-0000-0000-0000-000000000402'), 'R2 is busy — not a candidate');
select tests.ok(not exists (select 1 from candidate_riders((select id from t2)) where rider_id in ('00000000-0000-0000-0000-000000000404', '00000000-0000-0000-0000-000000000405')),
  'offline rider and Kumasi rider are never candidates');
update job_offers set expires_at = now() - interval '1 second' where trip_id = (select id from t2) and status = 'offered';
select dispatch_tick();
update job_offers set expires_at = now() - interval '1 second' where trip_id = (select id from t2) and status = 'offered';
select dispatch_tick();
select tests.ok((select dispatch_state = 'escalated' and escalation_reason like '2 riders%' from trips where id = (select id from t2)), 'after the limit of misses the job is escalated');
select tests.ok(exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000000412' and template = 'dispatch_escalated'), 'the Accra dispatcher is alerted');
select tests.ok(not exists (select 1 from job_offers where trip_id = (select id from t2) and status = 'offered'), 'no more automatic offers once escalated');

select tests.login('00000000-0000-0000-0000-000000000402');
select tests.expect_error($$select assign_trip((select id from t2), auth.uid())$$, 'only dispatchers', 'riders cannot assign jobs');
select tests.login('00000000-0000-0000-0000-000000000412');
select tests.expect_error($$select assign_trip((select id from t2), '00000000-0000-0000-0000-000000000402')$$, 'already has an active job', 'dispatcher cannot give a busy rider a second job');
select tests.expect_error($$select assign_trip((select id from t2), '00000000-0000-0000-0000-000000000405')$$, 'another city', 'dispatcher cannot assign a Kumasi rider in Accra');
select assign_trip((select id from t2), '00000000-0000-0000-0000-000000000403');
select tests.ok((select status = 'ASSIGNED' and rider_id = '00000000-0000-0000-0000-000000000403' from orders where id = (select oid from j2)), 'dispatcher assigns R3 by hand');

-- nobody available → escalate after 2 minutes
select tests.logout();
update app_settings set value = '5' where key = 'dispatch_max_rejections' and city_id is null;
update riders set is_online = false where city_id = (select acc from k);
select tests.service();
create temp table j3 as select (tests.book('00000000-0000-0000-0000-000000000410', 'sender', 'cash', 1) -> 'orders' -> 0 ->> 'id')::uuid oid;
grant select on j3 to anon, authenticated, service_role;
select tests.logout();
select dispatch_tick();
select tests.ok((select dispatch_state from trips where id = (select trip_id from orders where id = (select oid from j3))) = 'queued', 'no rider online: still looking');
update trips set dispatch_started_at = now() - interval '3 minutes' where id = (select trip_id from orders where id = (select oid from j3));
select dispatch_tick();
select tests.ok((select escalation_reason from trips where id = (select trip_id from orders where id = (select oid from j3))) = 'No eligible rider online nearby', 'escalated: no rider nearby');
update riders set is_online = true where city_id = (select acc from k) and id <> '00000000-0000-0000-0000-000000000404';

-- =====================================================================
-- 3. COD job skips the COD-blocked rider; bulk trip sent by a dispatcher
-- =====================================================================
select tests.service();
create temp table b1 as select tests.book('00000000-0000-0000-0000-000000000411', 'vendor_wallet', 'wallet', 2, '10000000-0000-0000-0000-000000000401', 10000) r;
grant select on b1 to anon, authenticated, service_role;
select tests.logout();
create temp table bt as select (r ->> 'trip_id')::uuid id from b1;
grant select on bt to anon, authenticated, service_role;
select tests.login('00000000-0000-0000-0000-000000000412');
select start_dispatch((select id from bt));
select tests.ok(tests.offer_for((select id from bt)) = '00000000-0000-0000-0000-000000000407', 'bulk trip (no bike-only rule) goes to the nearest rider — the car, 100 m');
select tests.logout();
select tests.ok(not exists (select 1 from candidate_riders((select id from bt)) where rider_id = '00000000-0000-0000-0000-000000000406'), 'COD-blocked rider is not offered a COD trip');
select tests.login('00000000-0000-0000-0000-000000000407');
select respond_offer((select id from job_offers where rider_id = auth.uid() and status = 'offered'), true);

-- =====================================================================
-- 4. The rider's job, through the rider_action door (works offline, replays safely)
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000402');   -- R2 has job j1
select tests.ok((rider_action('a0000000-0000-0000-0000-000000000001', jsonb_build_object('type', 'status', 'order_id', (select oid from j1), 'to', 'RIDER_AT_PICKUP', 'lng', -0.178, 'lat', 5.556), now() - interval '2 minutes') ->> 'ok')::boolean,
  'arrived at pickup');
select tests.ok((rider_action('a0000000-0000-0000-0000-000000000001', jsonb_build_object('type', 'status', 'order_id', (select oid from j1), 'to', 'RIDER_AT_PICKUP')) ->> 'replayed')::boolean,
  'the same action sent twice (offline retry) is simply replayed');
select tests.ok((select occurred_at is not null from order_events where order_id = (select oid from j1) and to_status = 'RIDER_AT_PICKUP'), 'phone time kept for offline updates');
select rider_action('a0000000-0000-0000-0000-000000000002', jsonb_build_object('type', 'status', 'order_id', (select oid from j1), 'to', 'PICKED_UP'));
select tests.ok((select status = 'IN_PROGRESS' from trips where id = (select id from t1)), 'trip IN_PROGRESS after pickup');
select tests.logout();
create temp table code1 as select tests.code_for((select oid from j1)) c;
grant select on code1 to anon, authenticated, service_role;
select tests.ok((select c ~ '^\d{4}$' from code1) and (select delivery_otp_hash <> (select c from code1) from orders where id = (select oid from j1)), 'a 4-digit code is sent to the recipient; only its hash is stored');
select tests.login('00000000-0000-0000-0000-000000000402');
select rider_action('a0000000-0000-0000-0000-000000000003', jsonb_build_object('type', 'status', 'order_id', (select oid from j1), 'to', 'IN_TRANSIT'));
select rider_action('a0000000-0000-0000-0000-000000000004', jsonb_build_object('type', 'status', 'order_id', (select oid from j1), 'to', 'ARRIVED_AT_DROPOFF', 'lng', -0.1612, 'lat', 5.6356));
select tests.ok((rider_action('a0000000-0000-0000-0000-000000000005', jsonb_build_object('type', 'code', 'order_id', (select oid from j1), 'code', '0000')) ->> 'attempts_left')::int = 4
                or (select c from code1) = '0000', 'wrong code: 4 tries left');
select tests.expect_error($$select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select oid from j1), 'to', 'DELIVERED', 'lng', -0.1612, 'lat', 5.6356))$$,
  'proof of delivery missing', 'cannot deliver without code + signature');
select tests.ok((rider_action('a0000000-0000-0000-0000-000000000006', jsonb_build_object('type', 'code', 'order_id', (select oid from j1), 'code', (select c from code1))) ->> 'ok')::boolean, 'right code accepted');
insert into storage.objects (bucket_id, name) values ('pod', (select oid from j1)::text || '/signature.svg');
select rider_action('a0000000-0000-0000-0000-000000000007', jsonb_build_object('type', 'pod', 'order_id', (select oid from j1), 'signature_path', (select oid from j1)::text || '/signature.svg'));
select tests.expect_error($$select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select oid from j1), 'to', 'DELIVERED', 'lng', -0.30, 'lat', 5.556))$$,
  'from the drop-off', 'geofence: cannot mark delivered from far away');
select rider_action('a0000000-0000-0000-0000-000000000008', jsonb_build_object('type', 'status', 'order_id', (select oid from j1), 'to', 'DELIVERED', 'lng', -0.1612, 'lat', 5.6356));
select tests.ok((select status = 'DELIVERED' and pod_method = 'app' from orders where id = (select oid from j1)), 'delivered with code + signature');
select tests.ok((select status = 'COMPLETED' from trips where id = (select id from t1)) and my_job() is null, 'job complete — R2 is free for the next offer');
select tests.expect_error($$select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select oid from j2), 'to', 'RIDER_AT_PICKUP'))$$,
  'not on your job', 'a rider cannot touch someone else''s parcel');

-- COD: cash must be recorded, exact amount
select tests.login('00000000-0000-0000-0000-000000000407');
create temp table bo as select id, row_number() over (order by created_at, id) n from orders where trip_id = (select id from bt);
grant select on bo to anon, authenticated, service_role;
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', id, 'to', s)) from bo, unnest(array['RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED_AT_DROPOFF']) s where n = 1;
select tests.logout();
create temp table code2 as select tests.code_for((select id from bo where n = 1)) c;
grant select on code2 to anon, authenticated, service_role;
select tests.login('00000000-0000-0000-0000-000000000407');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'code', 'order_id', (select id from bo where n = 1), 'code', (select c from code2)));
insert into storage.objects (bucket_id, name) values ('pod', (select id from bo where n = 1)::text || '/sig.svg');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'pod', 'order_id', (select id from bo where n = 1), 'signature_path', 'x/sig.svg'));
select tests.expect_error($$select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from bo where n = 1), 'to', 'DELIVERED', 'lng', -0.1612, 'lat', 5.6356))$$,
  'record the ghs 100.00 cash', 'COD parcel: cash must be recorded first');
select tests.expect_error($$select rider_action(gen_random_uuid(), jsonb_build_object('type', 'cod', 'order_id', (select id from bo where n = 1), 'amount', 5000))$$,
  'collect exactly ghs 100.00', 'COD: the exact amount only');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'cod', 'order_id', (select id from bo where n = 1), 'amount', 10000, 'method', 'cash'));
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from bo where n = 1), 'to', 'DELIVERED', 'lng', -0.1612, 'lat', 5.6356));
select tests.ok((select cod_float_balance = 10000 from riders where id = auth.uid()), 'rider now holds GHS 100 COD cash (float tracked)');

-- failed attempt needs a reason; override when the recipient has no phone
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', id, 'to', s)) from bo, unnest(array['RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED_AT_DROPOFF']) s where n = 2;
select tests.expect_error($$select rider_action(gen_random_uuid(), jsonb_build_object('type', 'override', 'order_id', (select id from bo where n = 2), 'reason', 'No phone'))$$, 'photo', 'override needs a photo');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'override', 'order_id', (select id from bo where n = 2), 'reason', 'Recipient has no phone', 'photo_path', 'x/door.jpg'));
select tests.login('00000000-0000-0000-0000-000000000412');
select decide_pod_override((select id from pod_overrides where order_id = (select id from bo where n = 2)), true);
select tests.ok((select pod_override_by is not null and pod_method = 'override' from orders where id = (select id from bo where n = 2)), 'dispatcher approves the override');
select tests.logout();
select tests.ok(exists (select 1 from audit_log where table_name = 'pod_overrides' and after ->> 'status' = 'approved'), 'override decision audited');

-- =====================================================================
-- 5. WhatsApp backup: "DELIVERED <tracking no> <code>"
-- =====================================================================
select tests.service();
create temp table j4 as select (tests.book('00000000-0000-0000-0000-000000000410', 'sender', 'cash', 1) -> 'orders' -> 0 ->> 'id')::uuid oid;
grant select on j4 to anon, authenticated, service_role;
select tests.logout();
select assign_trip((select trip_id from orders where id = (select oid from j4)), '00000000-0000-0000-0000-000000000401');
select tests.login('00000000-0000-0000-0000-000000000401');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select oid from j4), 'to', s)) from unnest(array['RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT']) s;
select rider_ping(-0.1612, 5.6356, 8);
select tests.ok((select count(*) from rider_location_pings where rider_id = auth.uid() and trip_id is not null) = 1, 'location ping on a job is kept as trip history');
select tests.service();
create temp table tn4 as select tracking_number tn, tests.code_for(id) c from orders where id = (select oid from j4);
grant select on tn4 to anon, authenticated, service_role;
select tests.ok(whatsapp_rider_command('233200000499', 'DELIVERED X 1') like '%not registered%', 'unknown WhatsApp number is refused');
select tests.ok(whatsapp_rider_command('233200000401', 'delivered') like 'Send: DELIVERED%', 'bad format gets the instructions');
select tests.ok(whatsapp_rider_command('233200000401', 'DELIVERED ' || (select tn from tn4) || ' ' || case when (select c from tn4) = '9999' then '9998' else '9999' end) like 'Wrong code%', 'wrong code by WhatsApp is refused');
select tests.ok(whatsapp_rider_command('233200000402', 'DELIVERED ' || (select tn from tn4) || ' ' || (select c from tn4)) like '%not on your job%', 'another rider cannot deliver it by WhatsApp');
select tests.ok(whatsapp_rider_command('233200000401', '  delivered   ' || lower((select tn from tn4)) || '  ' || (select c from tn4)) like '%delivered ✓%', 'right code by WhatsApp delivers the parcel');
select tests.ok((select status = 'DELIVERED' and pod_method = 'whatsapp' and pod_flagged like '%no signature%' from orders where id = (select oid from j4)), 'WhatsApp delivery is flagged for review (no signature)');
select tests.ok(whatsapp_rider_command('233200000401', 'DELIVERED ' || (select tn from tn4) || ' ' || (select c from tn4)) like '%already delivered%', 'sending it again is harmless');

select tests.login('00000000-0000-0000-0000-000000000401');
select tests.expect_error($q$select review_pod_flag((select oid from j4), 'looks fine')$q$, 'Only dispatch', 'a rider cannot clear their own delivery flag');
select tests.login('00000000-0000-0000-0000-000000000412');
select tests.expect_error($q$select review_pod_flag((select oid from j4), 'ok')$q$, 'short note', 'reviewing needs a note');
select review_pod_flag((select oid from j4), 'Called recipient, parcel received');
select tests.service();
select tests.ok((select pod_flagged is null and pod_reviewed_by = '00000000-0000-0000-0000-000000000412' from orders where id = (select oid from j4)), 'dispatcher review clears the flag');
select tests.ok(exists(select 1 from audit_log where reason like 'delivery reviewed:%'), 'the review is in the audit log');
select tests.logout();
select tests.ok((select count(*) from job_offers where status = 'offered' and rider_id = '00000000-0000-0000-0000-000000000402') <= 1, 'never more than one live offer per rider');
rollback;

