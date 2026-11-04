-- =====================================================================
-- Database tests: RLS per role, status machine, ledger, trips, audit.
-- Everything runs in one transaction and is rolled back at the end.
-- =====================================================================
\set QUIET on
begin;

\ir 01_helpers.sql

-- ---------- fixtures (created as the trusted server) ----------
insert into auth.users (id, email, phone) values
  ('00000000-0000-0000-0000-000000000001', 'super@qcs.test',    '+233200000001'),
  ('00000000-0000-0000-0000-000000000002', 'accadmin@qcs.test', '+233200000002'),
  ('00000000-0000-0000-0000-000000000003', 'ksiadmin@qcs.test', '+233200000003'),
  ('00000000-0000-0000-0000-000000000004', 'disp@qcs.test',     '+233200000004'),
  ('00000000-0000-0000-0000-000000000005', 'finance@qcs.test',  '+233200000005'),
  ('00000000-0000-0000-0000-000000000006', 'analyst@qcs.test',  '+233200000006'),
  ('00000000-0000-0000-0000-000000000007', 'cust1@qcs.test',    '+233200000007'),
  ('00000000-0000-0000-0000-000000000008', 'cust2@qcs.test',    '+233200000008'),
  ('00000000-0000-0000-0000-000000000009', 'vowner@qcs.test',   '+233200000009'),
  ('00000000-0000-0000-0000-000000000010', 'vstaff@qcs.test',   '+233200000010'),
  ('00000000-0000-0000-0000-000000000011', 'rider@qcs.test',    '+233200000011'),
  ('00000000-0000-0000-0000-000000000012', 'hub@qcs.test',      '+233200000012'),
  ('00000000-0000-0000-0000-000000000013', 'rider2@qcs.test',   '+233200000013');

create temp table ids as
select (select id from cities where code='ACC') acc, (select id from cities where code='KSI') ksi,
       (select id from hubs where code='ACC-HUB') acc_hub, (select id from hubs where code='KSI-HUB') ksi_hub;
grant select on ids to anon, authenticated;

insert into user_roles (user_id, role, city_id, hub_id) values
  ('00000000-0000-0000-0000-000000000001', 'super_admin', null, null),
  ('00000000-0000-0000-0000-000000000002', 'city_admin', (select acc from ids), null),
  ('00000000-0000-0000-0000-000000000003', 'city_admin', (select ksi from ids), null),
  ('00000000-0000-0000-0000-000000000004', 'dispatcher', (select acc from ids), null),
  ('00000000-0000-0000-0000-000000000005', 'finance', null, null),
  ('00000000-0000-0000-0000-000000000006', 'analyst', null, null),
  ('00000000-0000-0000-0000-000000000011', 'fleet_rider', (select acc from ids), null),
  ('00000000-0000-0000-0000-000000000013', 'fleet_rider', (select acc from ids), null),
  ('00000000-0000-0000-0000-000000000012', 'hub_handler', (select acc from ids), (select acc_hub from ids));

insert into vendors (id, owner_id, business_name, city_id, crm_stage)
values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000009', 'Ama''s Boutique', (select acc from ids), 'active');
insert into vendor_staff (vendor_id, user_id, permissions)
values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', '{book,track}');

insert into riders (id, rider_type, status, city_id, cod_float_limit) values
  ('00000000-0000-0000-0000-000000000011', 'fleet', 'active', (select acc from ids), 50000),
  ('00000000-0000-0000-0000-000000000013', 'fleet', 'active', (select acc from ids), 50000);

-- Drop-off point used by all Accra orders (Osu) and a far-away point (Tema) for the geofence test.
create temp table pts as select
  st_setsrid(st_makepoint(-0.1780, 5.5560), 4326)::geography as osu,
  st_setsrid(st_makepoint(-0.2050, 5.6050), 4326)::geography as hubpt;
grant select on pts to anon, authenticated;

insert into trips (id, trip_type, status, city_id, rider_id, vendor_id)
values ('20000000-0000-0000-0000-000000000001', 'bulk', 'ASSIGNED', (select acc from ids),
        '00000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001');

insert into orders (id, service_type, city_id, customer_id, vendor_id, pickup_location, dropoff_location,
                    recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method, rider_id, trip_id,
                    origin_hub_id, dest_hub_id, intercity_option) values
  -- o1: individual express, MoMo upfront
  ('30000000-0000-0000-0000-000000000001', 'express', (select acc from ids), '00000000-0000-0000-0000-000000000007', null,
   (select hubpt from pts), (select osu from pts), 'Kofi', '+233240000001', 2000, 4600, 'sender', 'momo', null, null, null, null, null),
  -- o2: vendor e-commerce, vendor wallet, on the rider's bulk trip
  ('30000000-0000-0000-0000-000000000002', 'ecommerce', (select acc from ids), '00000000-0000-0000-0000-000000000010',
   '10000000-0000-0000-0000-000000000001', (select hubpt from pts), (select osu from pts), 'Esi', '+233240000002', 1500, 2500,
   'vendor_wallet', 'wallet', '00000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000001', null, null, null),
  -- o3: Kumasi order by another customer
  ('30000000-0000-0000-0000-000000000003', 'express', (select ksi from ids), '00000000-0000-0000-0000-000000000008', null,
   st_setsrid(st_makepoint(-1.62, 6.69), 4326)::geography, st_setsrid(st_makepoint(-1.61, 6.70), 4326)::geography,
   'Yaw', '+233240000003', 1000, 2000, 'sender', 'cash', null, null, null, null, null),
  -- o4: inter-city Accra → Kumasi through the Accra hub
  ('30000000-0000-0000-0000-000000000004', 'intercity', (select acc from ids), '00000000-0000-0000-0000-000000000008', null,
   (select hubpt from pts), st_setsrid(st_makepoint(-1.61, 6.70), 4326)::geography, 'Abena', '+233240000004', 3000, 5000,
   'recipient', 'cash', null, null, (select acc_hub from ids), (select ksi_hub from ids), 'doorstep');

-- =====================================================================
-- 1. RLS is on for every table
-- =====================================================================
select tests.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity), 'RLS enabled on every public table');
select tests.ok((select count(*) from pg_tables where schemaname='public') >= 30, 'all core tables exist');
select tests.ok((select count(*) from cities) = 4 and (select count(*) from zones) = 12 and (select count(*) from hubs) = 4, 'seed: 4 cities, 12 zones, 4 hubs');
select tests.ok((select count(*) from wallets where owner_type='customer') = 13, 'every new user got a customer wallet');
select tests.ok(exists (select 1 from user_roles where user_id='00000000-0000-0000-0000-000000000009' and role='vendor_owner'), 'vendor owner role granted automatically');

-- =====================================================================
-- 2. Anonymous visitors (website)
-- =====================================================================
select tests.login(null);
select tests.ok((select count(*) from cities) = 4, 'anon reads cities');
select tests.ok((select count(*) from hubs) = 4, 'anon reads hubs (station pages)');
select tests.ok((select count(*) from pricing_rules where rule_kind='express') = 4, 'anon reads active prices (rate calculator)');
select tests.ok((select count(*) from orders) = 0, 'anon cannot see orders');
select tests.ok((select count(*) from profiles) = 0, 'anon cannot see profiles');
select tests.ok((select count(*) from wallets) = 0, 'anon cannot see wallets');
select tests.expect_error($$select public.transition_order('30000000-0000-0000-0000-000000000001', 'CANCELLED')$$, 'permission denied', 'anon cannot change orders');

-- =====================================================================
-- 3. Individual customer
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000007');
select tests.ok((select count(*) from orders) = 1, 'customer sees only their own order');
select tests.ok((select count(*) from wallets) = 1, 'customer sees only their own wallet');
select tests.ok((select count(*) from promo_codes) = 0, 'customer cannot list promo codes');
select tests.ok((select count(*) from audit_log) = 0, 'customer cannot read the audit log');
select tests.expect_error($$insert into orders (service_type, city_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payment_method)
  select 'express', acc, (select osu from pts), (select osu from pts), 'x', '+233240000009', 100, 1, 'cash' from ids$$,
  'row-level security', 'customer cannot insert orders directly (must use booking function)');
select tests.ok(tests.rows($q$update orders set quoted_fee = 0$q$) = 0, 'customer cannot edit their order row');
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000001', 'CONFIRMED')$$, 'must be paid', 'MoMo order cannot skip payment');
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000001', 'DELIVERED')$$, 'not allowed', 'invalid jump DRAFT → DELIVERED refused');
select transition_order('30000000-0000-0000-0000-000000000001', 'PENDING_PAYMENT');
select tests.ok((select status from orders where id='30000000-0000-0000-0000-000000000001') = 'PENDING_PAYMENT', 'customer moves DRAFT → PENDING_PAYMENT');
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000001', 'CONFIRMED')$$, 'not allowed', 'customer cannot mark their own payment as received');
select tests.ok((select count(*) from order_events where order_id='30000000-0000-0000-0000-000000000001') = 2, 'status history recorded (created + payment)');

-- payment arrives from Hubtel (server)
select tests.logout();
select transition_order('30000000-0000-0000-0000-000000000001', 'CONFIRMED');

-- =====================================================================
-- 4. Vendor owner and vendor staff
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000010');  -- staff with book,track
select tests.ok((select count(*) from orders) = 1, 'vendor staff sees the vendor''s orders');
select tests.ok((select count(*) from wallets where owner_type='vendor') = 0, 'staff without wallet permission cannot see vendor wallet');

select tests.login('00000000-0000-0000-0000-000000000009');  -- owner
select tests.ok((select count(*) from orders) = 1, 'vendor owner sees the vendor''s orders');
select tests.ok((select count(*) from wallets where owner_type='vendor') = 1, 'vendor owner sees vendor wallet');
select tests.ok((select count(*) from profiles where id='00000000-0000-0000-0000-000000000010') = 1, 'vendor owner sees their staff profile');
update vendors set contact_phone = '+233201111111' where id='10000000-0000-0000-0000-000000000001';
select tests.ok((select contact_phone from vendors where id='10000000-0000-0000-0000-000000000001') = '+233201111111', 'vendor owner edits their contact details');
select tests.expect_error($$update vendors set cod_payout_on_hold = true where id='10000000-0000-0000-0000-000000000001'$$, 'only qcs staff', 'vendor cannot change account controls');

-- =====================================================================
-- 5. Riders
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000011');
select tests.ok((select count(*) from orders) = 1, 'rider sees only orders assigned to them');
select tests.ok((select count(*) from trips) = 1, 'rider sees their own trip');
update riders set is_online = true, last_location = (select hubpt from pts), last_location_at = now() where id = '00000000-0000-0000-0000-000000000011';
select tests.ok((select is_online from riders where id='00000000-0000-0000-0000-000000000011'), 'rider goes online and updates location');
select tests.expect_error($$update riders set score = 999 where id='00000000-0000-0000-0000-000000000011'$$, 'only qcs staff', 'rider cannot change their own score');
select tests.expect_error($$update riders set cod_float_limit = 99999999 where id='00000000-0000-0000-0000-000000000011'$$, 'only qcs staff', 'rider cannot raise their own COD limit');
select tests.ok((select count(*) from riders) = 1, 'rider cannot see other riders');
insert into rider_location_pings (rider_id, trip_id, location) values ('00000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000001', (select hubpt from pts));
select tests.expect_error($$insert into rider_location_pings (rider_id, location) values ('00000000-0000-0000-0000-000000000013', (select hubpt from pts))$$, 'row-level security', 'rider cannot send pings for another rider');

-- new rider sign-up always starts as applicant, whatever the app sends
select tests.login('00000000-0000-0000-0000-000000000008');
insert into riders (id, rider_type, status, city_id, score, cod_float_limit)
select '00000000-0000-0000-0000-000000000008', 'commission', 'active', acc, 999, 99999999 from ids;
select tests.ok((select status = 'applicant' and score = 100 and cod_float_limit = 50000 from riders where id='00000000-0000-0000-0000-000000000008'), 'rider sign-up forced to applicant with default settings');
select tests.expect_error($$update riders set is_online = true where id='00000000-0000-0000-0000-000000000008'$$, 'not active', 'applicant cannot go online');

-- =====================================================================
-- 6. Ops staff: city scoping, analyst read-only, role granting
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000002');  -- Accra admin
select tests.ok((select count(*) from orders) = 3, 'Accra admin sees all Accra orders');
select tests.ok((select count(*) from orders where city_id = (select ksi from ids)) = 0, 'Accra admin cannot see Kumasi orders');
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000013', 'dispatcher', acc from ids;
select tests.ok(true, 'Accra admin grants a dispatcher role in Accra');
select tests.expect_error($$insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000013', 'super_admin', acc from ids$$, 'row-level security', 'city admin cannot create a super admin');
select tests.expect_error($$insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000013', 'dispatcher', ksi from ids$$, 'row-level security', 'city admin cannot grant roles in another city');

select tests.login('00000000-0000-0000-0000-000000000003');  -- Kumasi admin
select tests.ok((select count(*) from orders) = 1, 'Kumasi admin sees only the Kumasi order');

select tests.login('00000000-0000-0000-0000-000000000006');  -- analyst
select tests.ok((select count(*) from orders) = 4, 'analyst sees every city');
select tests.ok(tests.rows($q$update orders set recipient_name = 'x'$q$) = 0, 'analyst cannot edit orders');
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000003', 'CANCELLED')$$, 'not allowed', 'analyst cannot change order status');

select tests.login('00000000-0000-0000-0000-000000000012');  -- hub handler at Accra hub
select tests.ok((select count(*) from orders) = 1 and exists (select 1 from orders where id='30000000-0000-0000-0000-000000000004'), 'hub handler sees parcels routed through their hub');

-- =====================================================================
-- 7. Status machine, proof of delivery, geofence
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000004');  -- Accra dispatcher
select transition_order('30000000-0000-0000-0000-000000000002', 'CONFIRMED');
select transition_order('30000000-0000-0000-0000-000000000002', 'ASSIGNED');

select tests.login('00000000-0000-0000-0000-000000000011');  -- rider
select transition_order('30000000-0000-0000-0000-000000000002', 'RIDER_AT_PICKUP', -0.2050, 5.6050);
select transition_order('30000000-0000-0000-0000-000000000002', 'PICKED_UP', -0.2050, 5.6050);
select transition_order('30000000-0000-0000-0000-000000000002', 'IN_TRANSIT');
select transition_order('30000000-0000-0000-0000-000000000002', 'ARRIVED_AT_DROPOFF', -0.1781, 5.5561);
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000002', 'FAILED_ATTEMPT')$$, 'reason is required', 'failed attempt needs a reason');
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000002', 'DELIVERED', -0.1781, 5.5561)$$, 'proof of delivery', 'cannot deliver without OTP + signature');
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000004', 'CANCELLED')$$, 'not allowed', 'rider cannot touch an order that is not theirs');

-- the OTP check and signature upload happen in the rider-app phase; simulate them as the server
select tests.logout();
update orders set pod_otp_verified_at = now(), pod_signature_path = 'pod/sig.png' where id='30000000-0000-0000-0000-000000000002';

select tests.login('00000000-0000-0000-0000-000000000011');
-- Tema is ~15 km from Osu
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000002', 'DELIVERED', -0.0170, 5.6690)$$, 'from the drop-off', 'geofence blocks delivery from 15 km away');
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000002', 'DELIVERED')$$, 'location is required', 'delivery needs the rider''s location');
select transition_order('30000000-0000-0000-0000-000000000002', 'DELIVERED', -0.1900, 5.5650);  -- ~1.6 km away: within 3 km
select tests.ok((select status = 'DELIVERED' and delivered_at is not null from orders where id='30000000-0000-0000-0000-000000000002'), 'delivered within the 3 km geofence');
select tests.ok((select count(*) from order_events where order_id='30000000-0000-0000-0000-000000000002') = 8, 'every step recorded in order_events');
select tests.ok((select actor_id from order_events where order_id='30000000-0000-0000-0000-000000000002' and to_status='DELIVERED') = '00000000-0000-0000-0000-000000000011', 'event records who made the change');
select tests.ok((select location is not null from order_events where order_id='30000000-0000-0000-0000-000000000002' and to_status='DELIVERED'), 'event records GPS point');
select tests.ok(tests.rows($q$update order_events set note = 'x'$q$) = 0, 'rider cannot edit status history');
select tests.logout();
select tests.expect_error($$update order_events set note = 'x'$$, 'append-only', 'status history cannot be edited, even by the server');

-- corporate credit limit
select tests.logout();
update vendors set booking_blocked = true, booking_block_reason = 'Invoice INV-001 unpaid over 2 months' where id='10000000-0000-0000-0000-000000000001';
insert into orders (id, service_type, city_id, customer_id, vendor_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method)
select '30000000-0000-0000-0000-000000000005', 'ecommerce', acc, '00000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001',
       (select osu from pts), (select osu from pts), 'Ato', '+233240000005', 1000, 2500, 'vendor_wallet', 'wallet' from ids;
select tests.login('00000000-0000-0000-0000-000000000009');
select tests.expect_error($$select transition_order('30000000-0000-0000-0000-000000000005', 'CONFIRMED')$$, 'on hold', 'blocked account cannot confirm new bookings');
select tests.logout();
select tests.ok(exists (select 1 from audit_log where table_name='vendors' and before->>'booking_blocked'='false' and after->>'booking_blocked'='true'), 'booking block written to audit log');

-- express weight cap
select tests.expect_error($$insert into orders (service_type, city_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payment_method)
  select 'express', acc, (select osu from pts), (select osu from pts), 'x', '+233240000009', 15001, 1, 'cash' from ids$$, 'express_weight_cap', 'express over 15 kg refused');

-- =====================================================================
-- 8. Trips: 25-stop cap, express = 1 order, one active job per rider
-- =====================================================================
insert into trips (id, trip_type, status, city_id) select '20000000-0000-0000-0000-000000000002', 'bulk', 'PLANNED', acc from ids;
insert into orders (service_type, city_id, vendor_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method, trip_id)
select 'ecommerce', acc, '10000000-0000-0000-0000-000000000001', (select osu from pts), (select osu from pts), 'R' || g, '+233240000010', 1000, 2500, 'vendor_wallet', 'wallet', '20000000-0000-0000-0000-000000000002'
from ids, generate_series(1, 25) g;
select tests.ok((select count(*) from orders where trip_id='20000000-0000-0000-0000-000000000002') = 25, 'bulk trip takes 25 orders');
select tests.expect_error($$insert into orders (service_type, city_id, vendor_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method, trip_id)
  select 'ecommerce', acc, '10000000-0000-0000-0000-000000000001', (select osu from pts), (select osu from pts), 'R26', '+233240000010', 1000, 2500, 'vendor_wallet', 'wallet', '20000000-0000-0000-0000-000000000002' from ids$$,
  'at most 25', '26th order on a bulk trip refused');

insert into trips (id, trip_type, status, city_id) select '20000000-0000-0000-0000-000000000003', 'express', 'PLANNED', acc from ids;
update orders set trip_id = '20000000-0000-0000-0000-000000000003' where id = '30000000-0000-0000-0000-000000000001';
select tests.expect_error($$update orders set trip_id = '20000000-0000-0000-0000-000000000003' where id = '30000000-0000-0000-0000-000000000005'$$, 'one order', 'express trip holds one order');
select tests.expect_error($$update trips set rider_id = '00000000-0000-0000-0000-000000000011', status = 'ASSIGNED' where id = '20000000-0000-0000-0000-000000000003'$$, 'trips_one_active_per_rider', 'rider cannot hold two active jobs');

-- =====================================================================
-- 9. Money: double-entry ledger
-- =====================================================================
create temp table w as select
  (select id from wallets where owner_type='customer' and owner_id='00000000-0000-0000-0000-000000000007') cust,
  (select id from wallets where system_code='HUBTEL_CLEARING') hubtel,
  (select id from wallets where system_code='QCS_REVENUE') revenue;
grant select on w to anon, authenticated;

select tests.login('00000000-0000-0000-0000-000000000007');
select tests.expect_error($$select post_ledger_transaction('topup', 'free money', jsonb_build_array(jsonb_build_object('wallet_id', cust, 'amount', 100000), jsonb_build_object('wallet_id', hubtel, 'amount', -100000))) from w$$,
  'only finance', 'customer cannot post money to their own wallet');
select tests.ok(tests.rows($q$update wallets set balance = 999999$q$) = 0, 'customer cannot edit their wallet balance');

select tests.login('00000000-0000-0000-0000-000000000005');  -- finance
select post_ledger_transaction('topup', 'MoMo top-up', jsonb_build_array(
  jsonb_build_object('wallet_id', cust, 'amount', 5000), jsonb_build_object('wallet_id', hubtel, 'amount', -5000)), null, 'HUBTEL-123') from w;
select post_ledger_transaction('delivery_fee', 'Express fee', jsonb_build_array(
  jsonb_build_object('wallet_id', cust, 'amount', -4600), jsonb_build_object('wallet_id', revenue, 'amount', 4600)), '30000000-0000-0000-0000-000000000001') from w;
select tests.ok((select balance from wallets where id = (select cust from w)) = 400, 'wallet balance follows the ledger (5000 − 4600 = 400 pesewas)');
select tests.expect_error($$select post_ledger_transaction('delivery_fee', 'too much', jsonb_build_array(jsonb_build_object('wallet_id', cust, 'amount', -1000), jsonb_build_object('wallet_id', revenue, 'amount', 1000))) from w$$,
  'insufficient', 'customer wallet cannot go below zero');
select tests.ok((select sum(balance) from wallets) = 0, 'all wallets together always sum to zero');

select tests.logout();
select tests.expect_error($$update wallets set balance = 1 where id = (select cust from w)$$, 'only change through the ledger', 'even the server cannot edit a balance directly');
select tests.expect_error($$delete from ledger_entries$$, 'append-only', 'ledger entries can never be deleted');
select tests.expect_error($$delete from audit_log$$, 'append-only', 'audit log cannot be deleted, even by the server');
savepoint unbalanced;
select post_ledger_transaction('adjustment', 'one-sided', jsonb_build_array(jsonb_build_object('wallet_id', cust, 'amount', 100))) from w;
select tests.expect_error($$set constraints ledger_balanced immediate$$, 'does not balance', 'unbalanced ledger transaction refused');
rollback to savepoint unbalanced;

-- =====================================================================
-- 10. COD cash float and audit
-- =====================================================================
insert into cod_collections (order_id, rider_id, vendor_id, city_id, amount, remit_due_by)
select '30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', acc, 60000, now() + interval '8 hours' from ids;
select tests.ok((select cod_float_balance = 60000 and cod_blocked from riders where id='00000000-0000-0000-0000-000000000011'), 'rider over COD float limit is blocked from COD jobs');
update cod_collections set status = 'remitted', remitted_at = now(), remit_method = 'momo' where order_id = '30000000-0000-0000-0000-000000000002';
select tests.ok((select cod_float_balance = 0 and not cod_blocked from riders where id='00000000-0000-0000-0000-000000000011'), 'remitting the cash unblocks the rider');

select tests.login('00000000-0000-0000-0000-000000000005');
update pricing_rules set config = jsonb_set(config, '{baseFee}', '1200') where rule_kind='express' and city_id = (select acc from ids);
select tests.ok(exists (select 1 from audit_log where table_name='pricing_rules' and actor_id='00000000-0000-0000-0000-000000000005' and before->'config'->>'baseFee'='1000' and after->'config'->>'baseFee'='1200'), 'price change audited with who/before/after');
select tests.ok(tests.rows($q$delete from audit_log$q$) = 0, 'finance cannot delete audit entries');

select tests.login('00000000-0000-0000-0000-000000000004');  -- dispatcher (not finance)
select tests.expect_error($$update orders set quoted_fee = 1 where id = '30000000-0000-0000-0000-000000000005'$$, 'only finance', 'dispatcher cannot change prices on an order');

select tests.logout();
rollback;
\echo 'schema & RLS tests: done'
