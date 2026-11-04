-- =====================================================================
-- Phase 3 tests: quotes → bookings, bulk trips, promo codes, pricing settings.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000000201', '+233200000201'),  -- individual
  ('00000000-0000-0000-0000-000000000202', '+233200000202'),  -- vendor owner
  ('00000000-0000-0000-0000-000000000203', '+233200000203'),  -- vendor staff, track only
  ('00000000-0000-0000-0000-000000000204', '+233200000204'),  -- finance
  ('00000000-0000-0000-0000-000000000205', '+233200000205'),  -- Accra admin
  ('00000000-0000-0000-0000-000000000206', '+233200000206');  -- dispatcher
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000202', 'Kente Hub', id from cities where code = 'ACC';
insert into vendor_staff (vendor_id, user_id, permissions) values ('10000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000203', '{track}');
insert into user_roles (user_id, role, city_id) values ('00000000-0000-0000-0000-000000000204', 'finance', null);
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000205', 'city_admin', id from cities where code = 'ACC';
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000206', 'dispatcher', id from cities where code = 'ACC';
update promo_codes set is_active = true where code = 'WELCOME10';

create temp table k as select (select id from cities where code = 'ACC') acc, (select id from cities where code = 'KSI') ksi,
  (select id from zones where code = 'ACC-CEN') osu, (select id from zones where code = 'ACC-ELG') legon,
  (select id from promo_codes where code = 'WELCOME10') promo;
grant select on k to anon, authenticated, service_role;

-- A booking request as the server stores it after checking (prices from packages/pricing).
create function tests.req(p_payer text, p_method text, p_drops int, p_vendor boolean default false, p_ref text default 'WC-') returns jsonb language sql as $$
  select jsonb_build_object(
    'service', case when p_vendor then 'ecommerce' else 'express' end, 'payer', p_payer, 'payment_method', p_method,
    'pickup', jsonb_build_object('formatted_address', 'Oxford St, Osu', 'lat', 5.556, 'lng', -0.178, 'contact_name', 'Ama', 'contact_phone', '+233241111111', 'instructions', 'Shop 12'),
    'dropoffs', (select jsonb_agg(jsonb_build_object('formatted_address', 'Lagos Ave, East Legon ' || g, 'lat', 5.6355, 'lng', -0.161,
        'contact_name', 'Recipient ' || g, 'contact_phone', '+2432420000' || lpad(g::text, 2, '0'), 'weight_g', 1500, 'size', 'small', 'fragile', false,
        'item_value', 35000, 'cod_amount', case when p_vendor then 35000 else 0 end, 'external_ref', p_ref || g, 'instructions', 'Call on arrival'))
      from generate_series(1, p_drops) g))
$$;
create function tests.price(p_drops int) returns jsonb language sql as $$
  select jsonb_build_object('stops', (select jsonb_agg(jsonb_build_object('feePesewas', 3000, 'netPesewas', 3000, 'lines', '[{"label":"Delivery (per stop)","pesewas":3000}]'::jsonb)) from generate_series(1, p_drops)),
                            'pickupDate', '2026-11-05', 'totalPesewas', 3000 * p_drops)
$$;
create function tests.quote(p_user uuid, p_req jsonb, p_drops int, p_vendor uuid default null, p_promo uuid default null, p_expires interval default '15 minutes') returns uuid language sql as $$
  insert into quotes (user_id, vendor_id, service_type, city_id, request, price, zones, promo_code_id, total, expires_at)
  select p_user, p_vendor, (p_req ->> 'service')::service_type, acc, p_req, tests.price(p_drops),
         (select jsonb_agg(z) from (select k2.legon z from k k2, generate_series(1, p_drops)) s), p_promo, 3000 * p_drops, now() + p_expires from k
  returning id
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- ---------- zones ----------
select tests.ok((select zone_code from zone_for_point(-0.178, 5.556)) = 'ACC-CEN', 'Osu pin is in the Accra Central zone');
select tests.ok((select count(*) from zone_for_point(-1.0, 7.5)) = 0, 'a pin outside our zones finds no zone');

-- ---------- express, MoMo upfront ----------
create temp table b1 as select tests.quote('00000000-0000-0000-0000-000000000201', tests.req('sender', 'momo', 1), 1) as qid;
grant select on b1 to anon, authenticated, service_role;
select tests.login('00000000-0000-0000-0000-000000000201');
select tests.expect_error($$select create_booking('00000000-0000-0000-0000-000000000201', (select qid from b1))$$, 'permission denied', 'apps cannot call create_booking directly');
select tests.ok((select count(*) from quotes) = 1, 'customer sees their own quote');

select tests.service();
create temp table r1 as select create_booking('00000000-0000-0000-0000-000000000201', (select qid from b1)) as res;
select tests.ok((select (res ->> 'needs_payment')::boolean from r1), 'MoMo booking needs payment');
select tests.ok((select o.status = 'PENDING_PAYMENT' and o.quoted_fee = 3000 and o.tracking_number like 'QCS%' and o.recipient_name = 'Recipient 1'
                        and o.pickup_instructions = 'Shop 12' and o.delivery_instructions = 'Call on arrival' and o.dropoff_zone_id = (select legon from k)
                 from orders o where o.quote_id = (select qid from b1)), 'express order saved: waiting for payment, fee, tracking number, instructions, zone');
select tests.expect_error($$select create_booking('00000000-0000-0000-0000-000000000201', (select qid from b1))$$, 'already been booked', 'a quote can only be booked once');
select tests.expect_error($$select create_booking('00000000-0000-0000-0000-000000000202', (select qid from b1))$$, 'not found', 'someone else cannot use your quote');
select tests.expect_error($$select create_booking('00000000-0000-0000-0000-000000000201', tests.quote('00000000-0000-0000-0000-000000000201', tests.req('sender', 'cash', 1), 1, null, null, '-1 minute'))$$,
  'expired', 'expired quotes are refused');
select tests.ok((select (create_booking('00000000-0000-0000-0000-000000000201', tests.quote('00000000-0000-0000-0000-000000000201', tests.req('sender', 'cash', 1), 1))
                 -> 'orders' -> 0 ->> 'status')) = 'CONFIRMED', 'cash booking is confirmed straight away');
select tests.ok((select count(*) from addresses where user_id = '00000000-0000-0000-0000-000000000201') = 4, 'pickup and drop-off saved to the customer''s address book');

-- ---------- vendor bulk trip ----------
create temp table b2 as select tests.quote('00000000-0000-0000-0000-000000000202', tests.req('vendor_wallet', 'wallet', 3, true), 3, '10000000-0000-0000-0000-000000000201') as qid;
grant select on b2 to anon, authenticated, service_role;
create temp table r2 as select create_booking('00000000-0000-0000-0000-000000000202', (select qid from b2)) as res;
select tests.ok((select jsonb_array_length(res -> 'orders') = 3 and res ->> 'trip_id' is not null from r2), 'bulk booking made 3 orders on one trip');
select tests.ok((select count(*) from order_stops where trip_id = (select (res ->> 'trip_id')::uuid from r2)) = 6, 'trip has a pickup and a drop-off stop per order');
select tests.ok((select count(*) from orders where trip_id = (select (res ->> 'trip_id')::uuid from r2) and status = 'CONFIRMED' and cod_amount = 35000 and pickup_date = '2026-11-05') = 3,
  'wallet orders confirmed with COD and pickup date');
select tests.ok((select count(*) from addresses where vendor_id = '10000000-0000-0000-0000-000000000201') = 4, 'recipients saved to the vendor''s address book');
select tests.ok((select bool_and(is_high_value = false) from orders where trip_id = (select (res ->> 'trip_id')::uuid from r2)), 'GHS 350 items are not high value');

select tests.expect_error($$select create_booking('00000000-0000-0000-0000-000000000202', tests.quote('00000000-0000-0000-0000-000000000202', tests.req('vendor_wallet', 'wallet', 2, true), 2, '10000000-0000-0000-0000-000000000201'))$$,
  'already booked: order number(s) wc-1, wc-2', 'uploading the same order numbers again is refused in plain words');
select tests.expect_error($$select create_booking('00000000-0000-0000-0000-000000000203', tests.quote('00000000-0000-0000-0000-000000000203', tests.req('vendor_wallet', 'wallet', 1, true), 1, '10000000-0000-0000-0000-000000000201'))$$,
  'not allowed to book', 'staff without booking permission cannot book for the vendor');

select tests.login('00000000-0000-0000-0000-000000000203');
select tests.ok((select count(*) from orders where vendor_id = '10000000-0000-0000-0000-000000000201') = 3, 'track-only staff can still see the vendor''s orders');

-- blocked account: nothing is created
select tests.logout();
update vendors set booking_blocked = true, booking_block_reason = 'Invoice overdue' where id = '10000000-0000-0000-0000-000000000201';
create temp table b3 as select tests.quote('00000000-0000-0000-0000-000000000202', tests.req('vendor_wallet', 'wallet', 2, true, 'NEW-'), 2, '10000000-0000-0000-0000-000000000201') as qid;
grant select on b3 to anon, authenticated, service_role;
select tests.service();
select tests.expect_error($$select create_booking('00000000-0000-0000-0000-000000000202', (select qid from b3))$$, 'on hold', 'blocked business cannot book');
select tests.ok((select used_at is null from quotes where id = (select qid from b3)) and (select count(*) from orders where quote_id = (select qid from b3)) = 0, 'failed booking leaves nothing behind');
select tests.logout();
update vendors set booking_blocked = false where id = '10000000-0000-0000-0000-000000000201';

-- ---------- promo codes ----------
select tests.ok((select code from check_promo('welcome10', '00000000-0000-0000-0000-000000000201', 'express', (select acc from k))) = 'WELCOME10', 'promo code accepted (any letter case)');
select tests.expect_error($$select check_promo('NOPE', '00000000-0000-0000-0000-000000000201', 'express', (select acc from k))$$, 'isn''t valid', 'unknown promo code refused');
select tests.service();
select create_booking('00000000-0000-0000-0000-000000000201', tests.quote('00000000-0000-0000-0000-000000000201', tests.req('sender', 'cash', 1), 1, null, (select promo from k)));
select tests.logout();
select tests.ok((select used_count from promo_codes where code = 'WELCOME10') = 1, 'promo use counted');
select tests.expect_error($$select check_promo('WELCOME10', '00000000-0000-0000-0000-000000000201', 'express', (select acc from k))$$, 'already used', 'one use per customer');
select tests.login('00000000-0000-0000-0000-000000000201');
select tests.expect_error($$select check_promo('WELCOME10', '00000000-0000-0000-0000-000000000201', 'express', (select acc from k))$$, 'permission denied', 'apps cannot probe promo codes directly');

-- ---------- pricing settings ----------
select tests.login('00000000-0000-0000-0000-000000000205');  -- Accra admin
select set_city_cutoff((select acc from k), '10:30');
select tests.ok((select same_day_cutoff = '10:30' from cities where code = 'ACC'), 'Accra admin changes the Accra cut-off');
select tests.expect_error($$select set_city_cutoff((select ksi from k), '10:30')$$, 'only an admin', 'Accra admin cannot change Kumasi');
insert into app_settings (key, city_id, value) select 'surge_multiplier', acc, '1.3' from k;
select tests.ok((select value::text from app_settings where key = 'surge_multiplier' and city_id = (select acc from k)) = '1.3', 'Accra admin sets Accra surge');
select tests.ok(tests.rows($q$update app_settings set value = '99' where key = 'geofence_radius_m'$q$) = 0, 'city admin cannot change non-price settings');

select tests.login('00000000-0000-0000-0000-000000000204');  -- finance
update app_settings set value = '{"start":"21:00","end":"05:00"}' where key = 'night_window' and city_id is null;
select tests.ok((select value ->> 'start' from app_settings where key = 'night_window' and city_id is null) = '21:00', 'Finance changes the night window');
update pricing_rules set config = jsonb_set(config, '{perKm}', '350') where rule_kind = 'express' and city_id = (select acc from k);
select tests.ok((select (config ->> 'perKm')::int from pricing_rules where rule_kind = 'express' and city_id = (select acc from k)) = 350, 'Finance changes the per-km price');

select tests.login('00000000-0000-0000-0000-000000000206');  -- dispatcher
select tests.ok(tests.rows($q$update pricing_rules set is_active = false$q$) = 0, 'dispatcher cannot change prices');
select tests.ok(tests.rows($q$update app_settings set value = '3' where key = 'surge_multiplier'$q$) = 0, 'dispatcher cannot change surge');
select tests.expect_error($$select set_city_cutoff((select acc from k), '12:00')$$, 'only an admin', 'dispatcher cannot change the cut-off');

select tests.logout();
select tests.ok(exists (select 1 from audit_log where table_name = 'cities' and before ->> 'same_day_cutoff' = '09:00:00' and after ->> 'same_day_cutoff' = '10:30:00'), 'cut-off change audited');
select tests.ok(exists (select 1 from audit_log where table_name = 'app_settings' and actor_id = '00000000-0000-0000-0000-000000000204'), 'settings change audited');

rollback;
