-- =====================================================================
-- Phase 7 tests: live map, exception queue, reassign/unassign/split/merge, rider + vendor management,
-- zone/city/hub editors, settings overrides, and "City Admins see only their city".
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000000701', '+233200000701'),  -- R1 Accra, near pickup
  ('00000000-0000-0000-0000-000000000702', '+233200000702'),  -- R2 Accra
  ('00000000-0000-0000-0000-000000000703', '+233200000703'),  -- R3 Kumasi
  ('00000000-0000-0000-0000-000000000710', '+233200000710'),  -- vendor owner
  ('00000000-0000-0000-0000-000000000711', '+233200000711'),  -- second vendor (other pickup)
  ('00000000-0000-0000-0000-000000000720', '+233200000720'),  -- dispatcher Accra
  ('00000000-0000-0000-0000-000000000721', '+233200000721'),  -- city admin Accra
  ('00000000-0000-0000-0000-000000000722', '+233200000722'),  -- city admin Kumasi
  ('00000000-0000-0000-0000-000000000723', '+233200000723'),  -- finance
  ('00000000-0000-0000-0000-000000000724', '+233200000724'),  -- support Accra
  ('00000000-0000-0000-0000-000000000725', '+233200000725');  -- super admin
update profiles set full_name = 'Kwame Asante' where id = '00000000-0000-0000-0000-000000000701';
update profiles set full_name = 'Ama Owusu' where id = '00000000-0000-0000-0000-000000000702';
insert into user_roles (user_id, role, city_id)
select u, r::app_role, (select id from cities where code = c) from (values
  ('00000000-0000-0000-0000-000000000720'::uuid, 'dispatcher', 'ACC'), ('00000000-0000-0000-0000-000000000721', 'city_admin', 'ACC'),
  ('00000000-0000-0000-0000-000000000722', 'city_admin', 'KSI'), ('00000000-0000-0000-0000-000000000724', 'support', 'ACC')) v(u, r, c);
insert into user_roles (user_id, role) values ('00000000-0000-0000-0000-000000000723', 'finance'), ('00000000-0000-0000-0000-000000000725', 'super_admin');
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000710', 'Kente Hub', id from cities where code = 'ACC';
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000711', 'Makola Shoes', id from cities where code = 'ACC';
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000000701', 'bike', 'GR-701'), ('50000000-0000-0000-0000-000000000702', 'bike', 'GR-702'), ('50000000-0000-0000-0000-000000000703', 'bike', 'AS-703');
insert into riders (id, rider_type, status, city_id, vehicle_id, is_online, last_location, last_location_at)
select v.id, v.t::rider_type, 'active', c.id, v.veh, true, st_setsrid(st_makepoint(v.lng, v.lat), 4326)::geography, now()
from (values ('00000000-0000-0000-0000-000000000701'::uuid, 'fleet', '50000000-0000-0000-0000-000000000701'::uuid, -0.1775, 5.556, 'ACC'),
             ('00000000-0000-0000-0000-000000000702', 'commission', '50000000-0000-0000-0000-000000000702', -0.170, 5.560, 'ACC'),
             ('00000000-0000-0000-0000-000000000703', 'fleet', '50000000-0000-0000-0000-000000000703', -1.62, 6.69, 'KSI')) v(id, t, veh, lng, lat, c)
join cities c on c.code = v.c;

create temp table k as select (select id from cities where code = 'ACC') acc, (select id from cities where code = 'KSI') ksi, (select id from zones where code = 'ACC-ELG') legon;
grant select on k to anon, authenticated, service_role;
-- p_lng moves the pickup (for the "too far apart to merge" case)
create function tests.book7(p_user uuid, p_vendor uuid, p_drops int, p_pick_lng float8 default -0.178, p_cod int default 0) returns uuid language plpgsql as $$
declare qid uuid; req jsonb;
begin
  req := jsonb_build_object('service', case when p_vendor is null then 'express' else 'ecommerce' end,
    'payer', case when p_vendor is null then 'sender' else 'vendor_wallet' end, 'payment_method', case when p_vendor is null then 'cash' else 'wallet' end,
    'pickup', jsonb_build_object('formatted_address', 'Oxford St, Osu', 'lat', 5.556, 'lng', p_pick_lng, 'contact_name', 'Ama', 'contact_phone', '+233241111111'),
    'dropoffs', (select jsonb_agg(jsonb_build_object('formatted_address', 'Lagos Ave ' || g, 'lat', 5.6355, 'lng', -0.161, 'contact_name', 'Esi ' || g,
       'contact_phone', '+233242000000', 'weight_g', 1000, 'size', 'small', 'fragile', false, 'item_value', 0, 'cod_amount', p_cod)) from generate_series(1, p_drops) g));
  insert into quotes (user_id, vendor_id, service_type, city_id, request, price, zones, total)
  select p_user, p_vendor, (req ->> 'service')::service_type, acc, req,
         jsonb_build_object('stops', (select jsonb_agg(jsonb_build_object('netPesewas', 3000, 'insurancePesewas', 0, 'lines', '[]'::jsonb)) from generate_series(1, p_drops))),
         (select jsonb_agg(z) from (select k2.legon z from k k2, generate_series(1, p_drops)) s), 3000 * p_drops from k returning id into qid;
  return (create_booking(p_user, qid) ->> 'trip_id')::uuid;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- give the vendors money for wallet bookings
select tests.service();
create temp table t1 as select tests.book7('00000000-0000-0000-0000-000000000710', '10000000-0000-0000-0000-000000000701', 3) id;   -- bulk, 3 drops
create temp table t2 as select tests.book7('00000000-0000-0000-0000-000000000710', '10000000-0000-0000-0000-000000000701', 2) id;   -- bulk, same pickup
select tests.book7('00000000-0000-0000-0000-000000000711', '10000000-0000-0000-0000-000000000702', 1, -0.20);   -- single drop: no trip yet, 2.4 km away
select tests.book7('00000000-0000-0000-0000-000000000711', '10000000-0000-0000-0000-000000000702', 1, -0.20);
grant select on t1, t2 to anon, authenticated, service_role;
select tests.logout();
select tests.ok((select count(*) from orders where trip_id = (select id from t1)) = 3, 'setup: bulk trip with 3 drop-offs');

select tests.ok((select count(*) from orders where vendor_id = '10000000-0000-0000-0000-000000000702' and trip_id is null) = 2, 'setup: single-drop bookings have no trip yet');
select tests.login('00000000-0000-0000-0000-000000000724');
select tests.expect_error($$select plan_trip(array(select id from orders where vendor_id = '10000000-0000-0000-0000-000000000702'))$$, 'only dispatchers', 'support cannot plan trips');
select tests.login('00000000-0000-0000-0000-000000000720');
select tests.expect_error($$select plan_trip(array(select id from orders where trip_id = (select id from t2)))$$, 'without a trip', 'parcels already on a trip cannot be planned again');
create temp table t3 as select plan_trip(array(select id from orders where vendor_id = '10000000-0000-0000-0000-000000000702')) id;
grant select on t3 to anon, authenticated, service_role;
select tests.ok((select count(*) from orders where trip_id = (select id from t3)) = 2 and (select dispatch_state in ('queued', 'offering') from trips where id = (select id from t3)),
  'dispatcher turns loose parcels into one trip and sends it to riders');
select tests.logout();

-- =====================================================================
-- 1. Live map: city scoping
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000720');
create temp table m as select ops_live_map() j;
select tests.ok((select jsonb_array_length(j -> 'riders') = 2 from m), 'Accra dispatcher sees the 2 Accra riders, not Kumasi');
select tests.ok((select bool_and(r ->> 'state' = 'idle') from m, jsonb_array_elements(j -> 'riders') r), 'online riders with no job are "idle"');
select tests.ok((select jsonb_array_length(j -> 'orders') = 7 from m), 'active orders appear on the map');
select tests.login('00000000-0000-0000-0000-000000000722');
select tests.ok((select jsonb_array_length(ops_live_map() -> 'riders') = 1 and jsonb_array_length(ops_live_map() -> 'orders') = 0), 'Kumasi admin sees only Kumasi');
select tests.login('00000000-0000-0000-0000-000000000710');
select tests.expect_error($$select ops_live_map()$$, 'staff only', 'vendors cannot see the live map');

-- =====================================================================
-- 2. Trip tools
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000720');
select assign_trip((select id from t1), '00000000-0000-0000-0000-000000000701');
select tests.ok((select (ops_live_map() -> 'riders') @> '[{"name":"Kwame Asante","state":"on_job"}]'), 'rider with a job shows as "on job"');
select tests.expect_error($$select reassign_trip((select id from t1), '00000000-0000-0000-0000-000000000702', 'ok')$$, 'short reason', 'reassign needs a reason');
select tests.expect_error($$select reassign_trip((select id from t1), '00000000-0000-0000-0000-000000000703', 'Rider closer')$$, 'another city', 'cannot give a trip to a rider in another city');
select reassign_trip((select id from t1), '00000000-0000-0000-0000-000000000702', 'Kwame''s bike has a flat tyre');
select tests.ok((select rider_id = '00000000-0000-0000-0000-000000000702' from trips where id = (select id from t1))
            and (select bool_and(rider_id = '00000000-0000-0000-0000-000000000702' and status = 'ASSIGNED') from orders where trip_id = (select id from t1)), 'reassigned before pickup');
select tests.logout();
select tests.ok(exists (select 1 from notifications where template = 'job_reassigned' and user_id = '00000000-0000-0000-0000-000000000701'), 'old rider is told');
select tests.ok(exists (select 1 from audit_log where reason like 'reassigned: Kwame%'), 'reassignment is in the audit log with the reason');

-- split: move 2 drop-offs to a new trip
select tests.login('00000000-0000-0000-0000-000000000720');
create temp table sp as select split_trip((select id from t1), (select array_agg(id order by id) from (select id from orders where trip_id = (select id from t1) order by id limit 2) x)) id;
select tests.ok((select count(*) from orders where trip_id = (select id from sp)) = 2 and (select count(*) from orders where trip_id = (select id from t1)) = 1, 'split: 2 parcels on a new trip, 1 left');
select tests.ok((select bool_and(rider_id is null and status = 'SEARCHING_RIDER') from orders where trip_id = (select id from sp)), 'split-off parcels go back to dispatch');
select tests.ok((select count(*) from order_stops where trip_id = (select id from sp)) = 4, 'their pickup + drop-off stops moved too');
select tests.expect_error($$select split_trip((select id from t1), array(select id from orders where trip_id = (select id from t1)))$$, 'at least one', 'cannot split off everything');

-- merge: the split-off trip back with t2 (same pickup)
select merge_trips((select id from t2), (select id from sp));
select tests.ok((select count(*) from orders where trip_id = (select id from t2)) = 4 and (select status = 'CANCELLED' from trips where id = (select id from sp)), 'merge: 4 drop-offs on one trip, the other closed');
select tests.expect_error($$select merge_trips((select id from t2), (select id from t3))$$, '300 m apart', 'cannot merge trips whose pickups are far apart');

-- after pickup: reassign needs the hand-over path
select tests.login('00000000-0000-0000-0000-000000000702');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from orders where trip_id = (select id from t1)), 'to', 'RIDER_AT_PICKUP', 'lng', -0.178, 'lat', 5.556));
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from orders where trip_id = (select id from t1)), 'to', 'PICKED_UP', 'lng', -0.178, 'lat', 5.556));
select tests.login('00000000-0000-0000-0000-000000000720');
select tests.expect_error($$select unassign_trip((select id from t1), 'Rider is not answering')$$, 'reassign instead', 'cannot unassign once parcels are collected');
select tests.expect_error($$select split_trip((select id from t1), array(select id from orders where trip_id = (select id from t1)))$$, 'not yet collected', 'cannot split collected parcels');
select reassign_trip((select id from t1), '00000000-0000-0000-0000-000000000701', 'Motorbike broke down at Shiashie');
select tests.ok((select rider_id = '00000000-0000-0000-0000-000000000701' and status = 'IN_PROGRESS' from trips where id = (select id from t1))
            and (select rider_id = '00000000-0000-0000-0000-000000000701' and status = 'PICKED_UP' from orders where trip_id = (select id from t1)),
  'mid-trip hand-over: new rider, parcel keeps its status');
select tests.login('00000000-0000-0000-0000-000000000724');
select tests.expect_error($$select reassign_trip((select id from t2), '00000000-0000-0000-0000-000000000702', 'Support tries')$$, 'only dispatchers', 'support cannot move trips');

-- unassign before pickup
select tests.login('00000000-0000-0000-0000-000000000720');
select assign_trip((select id from t2), '00000000-0000-0000-0000-000000000702');
select unassign_trip((select id from t2), 'Rider not answering calls');
select tests.ok((select rider_id is null and dispatch_state in ('queued','offering') from trips where id = (select id from t2)), 'unassigned trip goes back to dispatch');
select tests.logout();

-- =====================================================================
-- 3. Exception queue
-- =====================================================================
update trips set ready_at = now() - interval '1 hour' where id = (select id from t3);
update riders set cod_float_limit = 10000, cod_float_balance = 25000 where id = '00000000-0000-0000-0000-000000000702';
update riders set last_location_at = now() - interval '30 minutes' where id = '00000000-0000-0000-0000-000000000701';
update orders set address_confirmation = 'unconfirmed' where trip_id = (select id from t1);
select tests.login('00000000-0000-0000-0000-000000000720');
create temp table ex as select x from ops_exceptions() x;
select tests.ok(exists (select 1 from ex where x ->> 'kind' = 'unassigned' and (x ->> 'trip_id')::uuid = (select id from t3)), 'job with no rider for an hour is an exception');
select tests.ok(exists (select 1 from ex where x ->> 'kind' = 'cod_over_limit' and x ->> 'detail' like 'Ama Owusu holds GHS 250.00 (limit GHS 100.00)'), 'rider over their cash limit is an exception');
select tests.ok(exists (select 1 from ex where x ->> 'kind' = 'no_signal' and x ->> 'detail' like 'Kwame Asante%'), 'rider on a job with no location for 30 min is an exception');
select tests.ok(exists (select 1 from ex where x ->> 'kind' = 'unconfirmed_address'), 'unconfirmed address is an exception');
select tests.login('00000000-0000-0000-0000-000000000722');
select tests.ok(not exists (select 1 from ops_exceptions()), 'Kumasi admin sees no Accra exceptions');
select tests.logout();
update app_settings set value = '-1' where key = 'late_express_minutes' and city_id is null;
update app_settings set value = '"00:00"' where key = 'late_ecommerce_time' and city_id is null;
update orders set pickup_date = current_date - 1 where trip_id = (select id from t2);
select tests.login('00000000-0000-0000-0000-000000000720');
select tests.ok(exists (select 1 from ops_exceptions() x where x ->> 'kind' = 'late'), 'parcels past their promised time are "late"');
select tests.logout();

-- =====================================================================
-- 4. Riders
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000720');
select tests.expect_error($$select set_rider_status('00000000-0000-0000-0000-000000000702', 'suspended', 'Late too often')$$, 'city or super admin', 'dispatcher cannot suspend');
select tests.expect_error($$update riders set status = 'suspended' where id = '00000000-0000-0000-0000-000000000702'$$, 'city or super admin', 'nor by editing the table directly');
select tests.expect_error($$update riders set cod_float_limit = 9999999 where id = '00000000-0000-0000-0000-000000000702'$$, 'admin or finance', 'dispatcher cannot change a cash limit');
select tests.login('00000000-0000-0000-0000-000000000721');
select tests.expect_error($$select set_rider_status('00000000-0000-0000-0000-000000000701', 'suspended', 'Late too often')$$, 'job in progress', 'cannot suspend a rider in the middle of a job');
select set_rider_status('00000000-0000-0000-0000-000000000702', 'suspended', 'Rude to customers (3 complaints)');
select tests.ok((select status = 'suspended' and not is_online from riders where id = '00000000-0000-0000-0000-000000000702'), 'suspended rider is taken offline');
select tests.login('00000000-0000-0000-0000-000000000722');
select tests.expect_error($$select set_rider_status('00000000-0000-0000-0000-000000000702', 'active', 'Kumasi tries')$$, 'city or super admin', 'admin of another city cannot touch Accra riders');
select tests.logout();
insert into rider_documents (id, rider_id, doc_type, storage_path, expires_on) values ('60000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000701', 'drivers_license', 'x/l.jpg', current_date + 10);
select tests.login('00000000-0000-0000-0000-000000000721');
select tests.expect_error($$select review_rider_document('60000000-0000-0000-0000-000000000701', false)$$, 'why', 'refusing a document needs a reason');
select review_rider_document('60000000-0000-0000-0000-000000000701', true, current_date + 400);
select tests.ok((select status = 'approved' and expires_on = current_date + 400 from rider_documents where id = '60000000-0000-0000-0000-000000000701'), 'document approved with its expiry date');
create temp table st as select rider_stats('00000000-0000-0000-0000-000000000701', current_date - 30, current_date) j;
select tests.ok((select (j ->> 'trips')::int = 1 and j ->> 'pay_basis' = 'fleet' and (j ->> 'earnings_estimate')::int = 500 from st), 'fleet earnings estimate = pickup fee per trip (+ fee per delivery)');
select tests.login('00000000-0000-0000-0000-000000000702');
select tests.ok((select rider_stats('00000000-0000-0000-0000-000000000702', current_date - 30, current_date) ->> 'pay_basis' = 'commission'), 'a rider can see their own stats');
select tests.expect_error($$select rider_stats('00000000-0000-0000-0000-000000000701', current_date - 30, current_date)$$, 'not allowed', 'but not another rider''s');

-- =====================================================================
-- 5. Vendors
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000724');
select tests.expect_error($$update vendors set booking_blocked = true where id = '10000000-0000-0000-0000-000000000701'$$, 'only finance', 'support cannot block bookings (even though they may edit vendors)');
select tests.login('00000000-0000-0000-0000-000000000721');
select tests.expect_error($$select set_vendor_controls('10000000-0000-0000-0000-000000000701', '{"cod_payout_on_hold": false}', 'Paid their fees')$$, 'only finance', 'city admin cannot release a COD hold');
select set_vendor_controls('10000000-0000-0000-0000-000000000701', '{"pod_require_photo": true, "cs_service_enabled": true}', 'Vendor asked for photo proof');
select tests.ok((select pod_require_photo and cs_service_enabled from vendors where id = '10000000-0000-0000-0000-000000000701'), 'city admin sets service options');
select tests.login('00000000-0000-0000-0000-000000000723');
select set_vendor_controls('10000000-0000-0000-0000-000000000701', '{"booking_blocked": true}', 'Invoice unpaid for 2 months');
select tests.ok((select booking_blocked and booking_block_reason = 'Invoice unpaid for 2 months' from vendors where id = '10000000-0000-0000-0000-000000000701'), 'finance blocks bookings with a reason');
select tests.ok((select (vendor_stats('10000000-0000-0000-0000-000000000701') ->> 'orders_7d')::int = 5), 'vendor stats count this week''s orders');
select tests.logout();
select tests.ok(exists (select 1 from audit_log where table_name = 'vendors' and reason = 'Invoice unpaid for 2 months'), 'block is in the audit log');

-- =====================================================================
-- 6. Zones, cities, hubs, settings
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000721');
create temp table z as select save_zone(null, (select acc from k), 'ACC-TST', 'Test zone',
  '{"type":"Polygon","coordinates":[[[-0.20,5.60],[-0.19,5.60],[-0.19,5.61],[-0.20,5.61],[-0.20,5.60]]]}') id;
select tests.ok((select z2 ->> 'name' = 'Test zone' and (z2 ->> 'area_km2')::numeric between 1 and 2 from jsonb_array_elements(zones_geojson((select acc from k))) z2 where (z2 ->> 'id')::uuid = (select id from z)),
  'city admin draws a zone (about 1.2 km²)');
select tests.expect_error($$select save_zone(null, (select acc from k), 'ACC-X', 'Bad', '{"type":"Polygon","coordinates":[[[3,50],[3.1,50],[3.1,50.1],[3,50]]]}')$$, 'in ghana', 'zones must be in Ghana');
select tests.expect_error($$select save_zone(null, (select acc from k), 'ACC-TST', 'Again', '{"type":"Polygon","coordinates":[[[-0.20,5.60],[-0.19,5.60],[-0.19,5.61],[-0.20,5.60]]]}')$$, 'already uses', 'zone codes are unique per city');
select tests.expect_error($$select save_zone(null, (select ksi from k), 'KSI-X', 'Kumasi', '{"type":"Polygon","coordinates":[[[-1.6,6.6],[-1.59,6.6],[-1.59,6.61],[-1.6,6.6]]]}')$$, 'city or super admin', 'Accra admin cannot edit Kumasi zones');
select tests.ok((select zone_id = (select id from z) from zone_for_point(-0.195, 5.605)), 'the new zone is used for pricing lookups straight away');
select tests.expect_error($$select save_city(null, 'CPC', 'Cape Coast', '09:00', true)$$, 'super admin', 'only a super admin adds cities');
create temp table h as select save_hub(null, jsonb_build_object('city_id', (select acc from k), 'code', 'ACC-HUB9', 'name', 'Spintex hub', 'address', 'Spintex Rd', 'lat', 5.63, 'lng', -0.12, 'capacity', 800)) id;
select tests.ok((select jsonb_array_length(hubs_overview((select acc from k))) >= 1), 'hub saved and listed');
select save_setting('exception_unassigned_minutes', (select acc from k), '5');
select tests.ok((select get_setting('exception_unassigned_minutes', (select acc from k)) = '5'::jsonb and get_setting('exception_unassigned_minutes', (select ksi from k)) = '10'::jsonb),
  'Accra override does not change other cities');
select tests.expect_error($$select save_setting('exception_unassigned_minutes', null, '5')$$, 'super admin', 'city admin cannot change the default for everyone');
select tests.expect_error($$select save_setting('exception_unassigned_minutes', (select acc from k), '"five"')$$, 'wrong type', 'settings keep their type');
select tests.login('00000000-0000-0000-0000-000000000725');
create temp table c as select save_city(null, 'CPC', 'Cape Coast', '09:30', true) id;
select tests.ok((select name = 'Cape Coast' from cities where id = (select id from c)), 'super admin adds a city');
select tests.logout();
rollback;
