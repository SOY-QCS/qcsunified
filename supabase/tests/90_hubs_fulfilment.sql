-- =====================================================================
-- Phase 9 tests: inter-city journey through hubs (scan in, label, bag, manifest, bus, arrival,
-- last mile, hub collection) and fulfilment (products, receiving, stock orders, pick, pack, fees, alerts).
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000000901', '+233200000901'),  -- F: Accra rider (first mile)
  ('00000000-0000-0000-0000-000000000902', '+233200000902'),  -- K: Kumasi rider (last mile)
  ('00000000-0000-0000-0000-000000000910', '+233200000910'),  -- vendor owner
  ('00000000-0000-0000-0000-000000000911', '+233200000911'),  -- other vendor owner
  ('00000000-0000-0000-0000-000000000920', '+233200000920'),  -- hub handler Accra Hub
  ('00000000-0000-0000-0000-000000000921', '+233200000921'),  -- hub handler Kumasi Hub
  ('00000000-0000-0000-0000-000000000922', '+233200000922'),  -- hub manager Accra Hub
  ('00000000-0000-0000-0000-000000000923', '+233200000923'),  -- dispatcher Kumasi
  ('00000000-0000-0000-0000-000000000924', '+233200000924');  -- finance
update profiles set full_name = 'Kwesi Hubhand' where id = '00000000-0000-0000-0000-000000000920';
update profiles set full_name = 'Kofi Kumasi' where id = '00000000-0000-0000-0000-000000000902';
create temp table k as select (select id from cities where code = 'ACC') acc, (select id from cities where code = 'KSI') ksi,
  (select id from hubs where code = 'ACC-HUB') ah, (select id from hubs where code = 'KSI-HUB') kh, (select id from hubs where code = 'TKD-HUB') th,
  (select id from zones where code = 'ACC-ELG') legon, (select id from zones z where z.city_id = (select id from cities where code = 'KSI') limit 1) kz;
grant select on k to anon, authenticated, service_role;
insert into user_roles (user_id, role, city_id, hub_id) select '00000000-0000-0000-0000-000000000920', 'hub_handler', acc, ah from k;
insert into user_roles (user_id, role, city_id, hub_id) select '00000000-0000-0000-0000-000000000921', 'hub_handler', ksi, kh from k;
insert into user_roles (user_id, role, city_id, hub_id) select '00000000-0000-0000-0000-000000000922', 'hub_manager', acc, ah from k;
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000923', 'dispatcher', ksi from k;
insert into user_roles (user_id, role) values ('00000000-0000-0000-0000-000000000924', 'finance');
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000910', 'Kente Hub', acc from k;
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-000000000911', 'Other Shop', acc from k;
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000000901', 'bike', 'GR-901'), ('50000000-0000-0000-0000-000000000902', 'bike', 'AS-902');
insert into riders (id, rider_type, status, city_id, vehicle_id, is_online, last_location, last_location_at)
select '00000000-0000-0000-0000-000000000901'::uuid, 'fleet'::rider_type, 'active'::rider_status, acc, '50000000-0000-0000-0000-000000000901'::uuid, true, st_setsrid(st_makepoint(-0.1775, 5.556), 4326)::geography, now() from k
union all
select '00000000-0000-0000-0000-000000000902', 'fleet', 'active', ksi, '50000000-0000-0000-0000-000000000902', true, st_setsrid(st_makepoint(-1.62, 6.69), 4326)::geography, now() from k;

-- book like the portal would: the quote carries the hubs the pricing engine found
create function tests.book9(p_service text, p_option text, p_items jsonb default null, p_hub uuid default null) returns jsonb language plpgsql as $$
declare qid uuid; req jsonb; ksi_drop boolean := p_service = 'intercity';
begin
  req := jsonb_build_object('service', p_service, 'intercity_option', p_option, 'fulfilment_hub_id', p_hub, 'payer', 'vendor_wallet', 'payment_method', 'wallet',
    'pickup', jsonb_build_object('formatted_address', 'Oxford St, Osu', 'lat', 5.556, 'lng', -0.178, 'contact_name', 'Ama', 'contact_phone', '+233241111111'),
    'dropoffs', jsonb_build_array(jsonb_build_object('formatted_address', case when ksi_drop then 'Adum, Kumasi' else 'Lagos Ave' end,
       'lat', case when ksi_drop then 6.69 else 5.6355 end, 'lng', case when ksi_drop then -1.618 else -0.161 end, 'contact_name', 'Esi Mensah',
       'contact_phone', '+233243334444', 'weight_g', 1500, 'size', 'small', 'fragile', false, 'item_value', 0, 'cod_amount', 0, 'items', p_items)));
  insert into quotes (user_id, vendor_id, service_type, city_id, request, price, zones, total)
  select '00000000-0000-0000-0000-000000000910', '10000000-0000-0000-0000-000000000901', p_service::service_type, acc, req,
         jsonb_build_object('stops', jsonb_build_array(jsonb_build_object('netPesewas', 6500, 'insurancePesewas', 0, 'lines', '[]'::jsonb,
           'originHubId', case when ksi_drop then ah end, 'destHubId', case when ksi_drop then kh end))),
         jsonb_build_array(case when ksi_drop then kz else legon end), 6500 from k returning id into qid;
  return create_booking('00000000-0000-0000-0000-000000000910', qid);
end $$;
create function tests.scan(p_user uuid, a jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin perform tests.login(p_user); r := hub_scan(gen_random_uuid(), a); perform tests.logout(); return r; end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- =====================================================================
-- 1. Inter-city booking
-- =====================================================================
select tests.service();
create temp table a as select tests.book9('intercity', 'doorstep') j;            -- A: doorstep in Kumasi
create temp table b as select tests.book9('intercity', 'hub_collection') j;      -- B: collect at Kumasi Hub
grant select on a, b to anon, authenticated, service_role;
select tests.logout();
create temp table oa as select (j -> 'orders' -> 0 ->> 'id')::uuid id, (j ->> 'trip_id')::uuid trip from a;
create temp table ob as select (j -> 'orders' -> 0 ->> 'id')::uuid id, (j ->> 'trip_id')::uuid trip from b;
grant select on ob to anon, authenticated, service_role;
grant select on oa, ob to anon, authenticated, service_role;
create temp table tn as select (select tracking_number from orders where id = (select id from oa)) a, (select tracking_number from orders where id = (select id from ob)) b;
grant select on tn to anon, authenticated, service_role;
select tests.ok((select origin_hub_id = (select ah from k) and dest_hub_id = (select kh from k) and intercity_option = 'doorstep' and status = 'CONFIRMED' from orders where id = (select id from oa)),
  'inter-city booking records the Accra → Kumasi hubs and doorstep option');
select tests.ok((select trip_type = 'intercity_first_mile' from trips where id = (select trip from oa)), 'a first-mile trip takes it to the hub');
select tests.ok((select a like 'ACC-%-KUM%' from tn), 'tracking number reads Accra → Kumasi');

-- first mile: rider picks up both and brings them to the Accra Hub
select tests.service();
select merge_trips((select trip from oa), (select trip from ob));
select assign_trip((select trip from oa), '00000000-0000-0000-0000-000000000901');
select tests.logout();
select tests.login('00000000-0000-0000-0000-000000000901');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', o, 'to', s, 'lng', -0.178, 'lat', 5.556))
from (select id o from orders where trip_id = (select trip from oa)) x, unnest(array['RIDER_AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT']) s;
select tests.ok((my_job() #>> '{hub,name}') = 'Accra Hub', 'rider''s job says which hub to take them to');
select tests.logout();

-- =====================================================================
-- 2. Origin hub: scan in, label, sort to bag
-- =====================================================================
select tests.expect_error($$select tests.scan('00000000-0000-0000-0000-000000000921', jsonb_build_object('type', 'in', 'hub_id', (select ah from k), 'code', (select a from tn)))$$,
  'not staff', 'Kumasi staff cannot scan at the Accra Hub');
create temp table s1 as select tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'in', 'hub_id', (select ah from k), 'code', lower((select a from tn)))) r;
grant select on s1 to anon, authenticated, service_role;
select tests.ok((select r ->> 'status' = 'AT_HUB' and r ->> 'next' = 'print_label' and r ->> 'dest' = 'KSI-HUB' from s1), 'scan in: at hub, print the label, it goes to Kumasi');
select tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'in', 'hub_id', (select ah from k), 'code', (select b from tn)));
select tests.logout();
select tests.ok((select status = 'COMPLETED' from trips where id = (select trip from oa)), 'first-mile trip is done when the parcels are in the hub');
select tests.ok((select count(*) = 3 and sum(amount) = 500 + 800 * 2 from rider_earnings where rider_id = '00000000-0000-0000-0000-000000000901'), 'first-mile rider paid: one pickup fee + a stop fee per parcel dropped at the hub');
select tests.ok(exists (select 1 from notifications where order_id = (select id from oa) and template = 'delivery_code'), 'recipient already has their delivery code');
-- the phone re-sends the same scan (offline retry): same answer, nothing new
select tests.login('00000000-0000-0000-0000-000000000920');
select hub_scan('aaaaaaaa-0000-4000-8000-000000000001', jsonb_build_object('type', 'in', 'hub_id', (select ah from k), 'code', (select a from tn)));
select tests.ok((select (hub_scan('aaaaaaaa-0000-4000-8000-000000000001', jsonb_build_object('type', 'in', 'hub_id', (select ah from k), 'code', 'ANYTHING')) ->> 'already')::boolean), 'repeated scan is ignored safely');
create temp table bag as select * from open_bag((select ah from k), (select kh from k));
create temp table bag2 as select * from open_bag((select ah from k), (select th from k));
grant select on bag2 to anon, authenticated, service_role;
grant select on bag, bag2 to anon, authenticated, service_role;
select tests.ok((select code like 'BAG-ACC-KSI-%' from bag), 'bag tag for Accra → Kumasi');
select tests.ok((select (tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'bag', 'hub_id', (select ah from k), 'code', (select a from tn), 'bag_id', (select id from bag))) ->> 'error') like 'Print and stick the label%'),
  'no label yet: can''t be bagged');
select tests.login('00000000-0000-0000-0000-000000000920');
select mark_labels_printed(array[(select id from oa), (select id from ob)]);
select tests.ok((select (tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'bag', 'hub_id', (select ah from k), 'code', (select a from tn), 'bag_id', (select id from bag2))) ->> 'error') like 'Wrong bag%'),
  'wrong destination bag is refused');
select tests.ok((select (tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'bag', 'hub_id', (select ah from k), 'code', b, 'bag_id', (select id from bag))) ->> 'in_bag')::int = 1 from tn)
            and (select (tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'bag', 'hub_id', (select ah from k), 'code', a, 'bag_id', (select id from bag))) ->> 'in_bag')::int = 2 from tn),
  'both parcels sorted into the Kumasi bag');

-- =====================================================================
-- 3. Manifest → bus → Kumasi
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000920');
create temp table man as select * from create_manifest((select ah from k), (select kh from k));
grant select on man to anon, authenticated, service_role;
select add_bag_to_manifest((select id from man), lower((select code from bag)));
select tests.expect_error($$select dispatch_manifest((select id from man), '{"bus_company": "VIP"}')$$, 'waybill number are required', 'bus details are required');
select dispatch_manifest((select id from man), '{"bus_company": "VIP Jeoun", "bus_station": "Kaneshie", "driver_name": "Musah", "driver_phone": "0244000111", "vehicle_reg": "GR 1234-20", "waybill_no": "VIP-88231", "seal_no": "S-551"}');
select tests.logout();
select tests.ok((select bool_and(status = 'DEPARTED_HUB' and current_hub_id is null) from orders where id in ((select id from oa), (select id from ob))), 'on the bus: both parcels departed');
select tests.ok((select status = 'departed' and parcels_sent = 2 and vehicle_reg = 'GR 1234-20' from manifests where id = (select id from man)), 'manifest records the bus, waybill and parcel count');
select tests.ok(exists (select 1 from notifications where template = 'manifest_departed' and user_id = '00000000-0000-0000-0000-000000000921'), 'Kumasi Hub staff are told the bus is coming');

select tests.login('00000000-0000-0000-0000-000000000921');
select tests.expect_error($$select close_manifest((select id from man))$$, 'arrived first', 'can''t close before the bus arrives');
select arrive_manifest((select id from man));
select tests.expect_error($$select close_manifest((select id from man))$$, 'not received', 'closing with parcels missing needs an explanation');
create temp table arr as select tests.scan('00000000-0000-0000-0000-000000000921', jsonb_build_object('type', 'arrive_bag', 'hub_id', (select kh from k), 'code', (select code from bag))) r;
grant select on arr to anon, authenticated, service_role;
select tests.ok((select (r ->> 'arrived')::int = 2 from arr), 'scanning the bag tag receives both parcels at once');
select tests.login('00000000-0000-0000-0000-000000000921');
select tests.ok((select close_manifest((select id from man)) -> 'missing' = '[]'::jsonb), 'manifest closed: nothing missing');
select tests.logout();
select tests.ok((select status = 'ARRIVED_DEST_HUB' and current_hub_id = (select kh from k) from orders where id = (select id from oa)), 'doorstep parcel waits for the last mile');
select tests.ok((select status = 'READY_FOR_COLLECTION' from orders where id = (select id from ob)), 'hub-collection parcel is ready');
select tests.ok(exists (select 1 from notifications where order_id = (select id from ob) and template = 'ready_for_collection'), 'recipient is told to come and collect');

-- =====================================================================
-- 4. Last mile and hub collection
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000923');
select tests.expect_error($$select plan_last_mile((select kh from k), array[(select id from ob)])$$, 'doorstep parcels', 'collection parcels don''t go on a delivery trip');
create temp table lm as select plan_last_mile((select kh from k), array[(select id from oa)]) trip;
grant select on lm to anon, authenticated, service_role;
select assign_trip((select trip from lm), '00000000-0000-0000-0000-000000000902');
select tests.login('00000000-0000-0000-0000-000000000902');
select tests.ok((my_job() #>> '{hub,name}') = 'Kumasi Hub', 'last-mile rider is told to collect at the Kumasi Hub');
select tests.login('00000000-0000-0000-0000-000000000921');
select tests.ok((select hub_handover_riders((select kh from k)) -> 0 ->> 'name' = 'Kofi Kumasi'), 'hub sees which rider is coming for which parcels');
select tests.ok((tests.scan('00000000-0000-0000-0000-000000000921', jsonb_build_object('type', 'handover', 'hub_id', (select kh from k), 'code', (select a from tn), 'rider_id', '00000000-0000-0000-0000-000000000902')) ->> 'status') = 'OUT_FOR_DELIVERY',
  'parcel handed to the rider: out for delivery');
select tests.login('00000000-0000-0000-0000-000000000902');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from oa), 'to', 'ARRIVED_AT_DROPOFF', 'lng', -1.618, 'lat', 6.69));
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'code', 'order_id', (select id from oa),
  'code', (select payload ->> 'code' from notifications where order_id = (select id from oa) and template = 'delivery_code' order by created_at desc limit 1)));
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'pod', 'order_id', (select id from oa), 'signature_path', (select id from oa) || '/sig.svg'));
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from oa), 'to', 'DELIVERED', 'lng', -1.618, 'lat', 6.69));
select tests.logout();
select tests.ok((select status = 'DELIVERED' from orders where id = (select id from oa)), 'Accra → Kumasi doorstep parcel delivered');
select tests.ok((select count(*) = 2 from rider_earnings where rider_id = '00000000-0000-0000-0000-000000000902'), 'last-mile rider paid: hub pickup + stop');

-- collection at the hub
select tests.ok((select not (tests.scan('00000000-0000-0000-0000-000000000921', jsonb_build_object('type', 'collect', 'hub_id', (select kh from k), 'code', (select b from tn), 'otp', '0000')) ->> 'ok')::boolean)
            or (select payload ->> 'code' = '0000' from notifications where order_id = (select id from ob) and template = 'delivery_code' limit 1), 'wrong code at the hub is refused');
create temp table cb as select payload ->> 'code' c from notifications where order_id = (select id from ob) and template = 'delivery_code' order by created_at desc limit 1;
grant select on cb to anon, authenticated, service_role;
select tests.ok((select (tests.scan('00000000-0000-0000-0000-000000000921', jsonb_build_object('type', 'collect', 'hub_id', (select kh from k), 'code', (select b from tn), 'otp', (select c from cb))) ->> 'error') like '%signature%'),
  'right code but no signature: not yet');
select tests.ok((select tests.scan('00000000-0000-0000-0000-000000000921', jsonb_build_object('type', 'collect', 'hub_id', (select kh from k), 'code', (select b from tn), 'otp', (select c from cb),
                 'signature_path', (select id from ob) || '/sig.svg')) ->> 'status' = 'COLLECTED'), 'collected with code + signature');
select tests.login('00000000-0000-0000-0000-000000000921');
create temp table hb as select hub_board((select kh from k)) j;
grant select on hb to anon, authenticated, service_role;
select tests.logout();
select tests.ok((select jsonb_array_length(j -> 'scans') >= 4 and j #>> '{scans,0,kind}' = 'collect' from hb), 'hub board shows who scanned what, latest first');
select tests.ok((select count(*) >= 10 from hub_scans), 'every scan is recorded');

-- =====================================================================
-- 5. Fulfilment
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000910');
select tests.expect_error($$select save_sku(null, '10000000-0000-0000-0000-000000000901', '{"sku": "tshirt-m", "name": "T-shirt M"}')$$, 'not switched on', 'fulfilment must be switched on by QCS');
select tests.logout();
update vendors set fulfilment_enabled = true where id = '10000000-0000-0000-0000-000000000901';
select tests.login('00000000-0000-0000-0000-000000000910');
create temp table sku as select save_sku(null, '10000000-0000-0000-0000-000000000901', '{"sku": "tshirt-m", "name": "Kente T-shirt M", "barcode": "6001234", "low_stock_at": 5}') id;
grant select on sku to anon, authenticated, service_role;
select tests.ok((select sku = 'TSHIRT-M' from skus where id = (select id from sku)), 'vendor adds a product');
select tests.logout();
select tests.login('00000000-0000-0000-0000-000000000920');
select tests.ok((select hub_vendors((select ah from k)) -> 0 ->> 'name' = 'Kente Hub'), 'hub handler sees fulfilment vendors to receive stock for');
select tests.logout();
select tests.ok((select tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'receive', 'hub_id', (select ah from k), 'vendor_id', '10000000-0000-0000-0000-000000000901',
                 'code', '6001234', 'qty', 10, 'location', 'a-01')) ->> 'on_hand' = '10'), 'hub receives 10 by scanning the barcode onto shelf A-01');
select tests.ok((select (tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'receive', 'hub_id', (select ah from k), 'vendor_id', '10000000-0000-0000-0000-000000000901', 'code', 'NOPE')) ->> 'error') like 'Unknown product%'),
  'unknown product is refused');

select tests.service();
create temp table fo as select (tests.book9('ecommerce', null, jsonb_build_array(jsonb_build_object('sku_id', (select id from sku), 'qty', 3)), (select ah from k)) -> 'orders' -> 0 ->> 'id')::uuid id;
grant select on fo to anon, authenticated, service_role;
select tests.expect_error($$select tests.book9('ecommerce', null, jsonb_build_array(jsonb_build_object('sku_id', (select id from sku), 'qty', 8)), (select ah from k))$$, 'not enough', 'can''t sell more than is available');
select tests.logout();
select tests.ok((select fulfilment_state = 'to_pick' and trip_id is null from orders where id = (select id from fo)), 'stock order waits to be picked');
select tests.ok((select reserved = 3 and available = 7 from stock_levels where sku_id = (select id from sku)), '3 reserved, 7 still available');
select tests.login('00000000-0000-0000-0000-000000000922');
select tests.expect_error($$select plan_trip(array[(select id from fo)])$$, 'dispatcher', 'hub manager does not plan trips');
select tests.logout();
select tests.service();
select tests.expect_error($$select plan_trip(array[(select id from fo)])$$, 'without a trip', 'not packed yet: can''t go on a trip');
select tests.logout();
select tests.login('00000000-0000-0000-0000-000000000920');
select tests.ok((select jsonb_array_length(pick_list((select ah from k))) = 1), 'hub sees the pick list with shelf locations');
select tests.ok((select (tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'pick', 'hub_id', (select ah from k), 'order_id', (select id from fo), 'code', '999')) ->> 'error') like '%not on this order%'),
  'wrong product can''t be picked');
select tests.ok((select (tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'pick', 'hub_id', (select ah from k), 'order_id', (select id from fo), 'code', '6001234', 'qty', 2)) ->> 'left_to_pick')::int = 1),
  'picked 2 from A-01, 1 to go');
select tests.login('00000000-0000-0000-0000-000000000920');
select tests.expect_error($$select pack_order((select id from fo))$$, 'pick every product', 'can''t pack before everything is picked');
select tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'pick', 'hub_id', (select ah from k), 'order_id', (select id from fo), 'code', 'TSHIRT-M'));
select tests.login('00000000-0000-0000-0000-000000000920');
select pack_order((select id from fo), 900);
select tests.logout();
select tests.ok((select fulfilment_state = 'packed' and weight_g = 900 from orders where id = (select id from fo)), 'packed and weighed');
select tests.ok((select amount = 300 from fulfilment_charges where order_id = (select id from fo) and kind = 'pick_pack'), 'GHS 3 pick & pack fee billed to the vendor wallet');
select tests.ok((select on_hand = 7 and reserved = 0 from stock_levels where sku_id = (select id from sku)), 'stock now 7 on the shelf, nothing reserved');
select tests.service();
select tests.ok(plan_trip(array[(select id from fo)]) is not null, 'packed order goes on a trip from the hub');
select tests.logout();

-- low stock and corrections
select tests.login('00000000-0000-0000-0000-000000000920');
select tests.expect_error($$select adjust_stock((select ah from k), (select id from sku), 'A-01', -3, 'Damaged by rain')$$, 'hub manager', 'hub handlers can''t correct stock');
select tests.login('00000000-0000-0000-0000-000000000922');
select adjust_stock((select ah from k), (select id from sku), 'A-01', -3, 'Damaged by rain');
select tests.expect_error($$select adjust_stock((select ah from k), (select id from sku), 'A-01', -50, 'Count is wrong')$$, 'below zero', 'stock can''t go below zero');
select tests.logout();
select tests.ok(exists (select 1 from notifications where template = 'low_stock' and user_id = '00000000-0000-0000-0000-000000000910' and payload ->> 'available' = '4'), 'vendor alerted: 4 left (alert at 5)');
select tests.ok(exists (select 1 from audit_log where table_name = 'stock_movements' and reason = 'Damaged by rain'), 'stock corrections are in the audit log');

-- cancelling a half-picked stock order puts the products back
select tests.service();
create temp table fo2 as select (tests.book9('ecommerce', null, jsonb_build_array(jsonb_build_object('sku_id', (select id from sku), 'qty', 2)), (select ah from k)) -> 'orders' -> 0 ->> 'id')::uuid id;
grant select on fo2 to anon, authenticated, service_role;
select tests.logout();
select tests.scan('00000000-0000-0000-0000-000000000920', jsonb_build_object('type', 'pick', 'hub_id', (select ah from k), 'order_id', (select id from fo2), 'code', 'TSHIRT-M'));
select tests.login('00000000-0000-0000-0000-000000000910');
select transition_order((select id from fo2), 'CANCELLED', null, null, 'Customer changed mind', null, null);
select tests.logout();
select tests.ok((select on_hand = 4 and reserved = 0 and locations ->> 'RETURNS' = '1' from stock_levels where sku_id = (select id from sku)), 'cancelled: picked item back on the returns shelf, reservation released');

-- monthly storage
select tests.login('00000000-0000-0000-0000-000000000924');
select tests.ok(bill_storage(date_trunc('month', now())::date) = 1, 'storage billed once per vendor per hub');
select tests.ok(bill_storage(date_trunc('month', now())::date) = 0, 'running it again bills nothing');
select tests.logout();
select tests.ok((select units = 4 and amount = 200 from fulfilment_charges where kind = 'storage'), 'storage = 4 units × GHS 0.50');

-- vendors see only their own stock
select tests.login('00000000-0000-0000-0000-000000000910');
select tests.ok((select count(*) = 1 from stock_levels), 'vendor sees their stock');
select tests.login('00000000-0000-0000-0000-000000000911');
select tests.ok((select count(*) = 0 from stock_levels) and (select count(*) = 0 from stock_movements), 'another vendor sees nothing');
select tests.logout();
select tests.ok((select sum(balance) = 0 from wallets), 'ledger still balanced');
rollback;
