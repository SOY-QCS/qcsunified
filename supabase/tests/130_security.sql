-- =====================================================================
-- Phase 13 tests: security audit. These checks look at the WHOLE database, so a future migration
-- that forgets row-level security, opens a function to visitors, or exposes an internal helper fails here.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

-- 1. Every table has row-level security switched on.
select tests.ok(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
                'every public table has row-level security');

-- 2. Only reviewed tables can be read by signed-out visitors, and visitors can never write.
select tests.ok((select coalesce(array_agg(distinct tablename::text order by tablename::text), '{}') from pg_policies
                 where schemaname = 'public' and roles && array['anon', 'public']::name[])
                = array['cities', 'help_articles', 'hubs', 'order_status_transitions', 'pricing_rules', 'zones'],
                'visitor-readable tables are exactly the reviewed list');
select tests.ok(not exists (select 1 from pg_policies where schemaname = 'public' and roles && array['anon', 'public']::name[] and cmd <> 'SELECT'),
                'no visitor policy allows writing');

-- 3. Functions that run with owner rights pin their search_path (stops "fake table" tricks).
select tests.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.prosecdef
                              and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
                'every SECURITY DEFINER function sets search_path');

-- 4. Visitors may run exactly the public-website functions.
select tests.ok((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype and has_function_privilege('anon', p.oid, 'execute')
                   and p.oid not in (select objid from pg_depend where deptype = 'e'))
                = array['address_link', 'confirm_address', 'has_role', 'is_ops', 'track_order', 'unsubscribe'],
                'visitors can run only the public-website functions');

-- 5. Internal helpers ("_name") are server-only, except the two used inside row-level security rules.
select tests.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.proname like '\_%' and p.proname not in ('_need', '_hub_staff')
                              and has_function_privilege('authenticated', p.oid, 'execute')),
                'signed-in users cannot call internal helpers');

-- 6. Owner-rights functions open to signed-in users either check who is calling, or are on the reviewed "public info" list.
select tests.ok(coalesce((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype and has_function_privilege('authenticated', p.oid, 'execute')
                   and p.prosrc !~* '(auth\.uid|is_trusted|_need|is_ops|has_role|is_admin|is_finance|my_vendor_ids|my_hub_ids|_hub_staff|_report_cities|_cs_order|_is_ticket_customer|raise exception)'
                   and p.oid not in (select objid from pg_depend where deptype = 'e')), '{}')
                <@ array['address_link', 'get_setting', 'hub_point', 'nearest_hub', 'setting_int', 'unsubscribe', 'zone_for_point'],
                'every other owner-rights function checks its caller');

-- 7. Storage buckets are private; views respect the reader's permissions.
select tests.ok(not exists (select 1 from storage.buckets where public), 'no public storage bucket');
select tests.ok(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v'
                            and not coalesce(c.reloptions @> array['security_invoker=true'], false)),
                'every view runs with the reader''s permissions');

-- 8. Behaviour: what a visitor and a signed-in customer actually get.
insert into auth.users (id, phone) values ('00000000-0000-0000-0000-000000001301', '+233200001301');
select tests.login(null);
select tests.ok((select count(*) from cities) > 0, 'visitor can read active cities');
select tests.ok((select count(*) from app_settings) = 0, 'visitor cannot read settings');
select tests.ok((select count(*) from orders) = 0, 'visitor cannot read orders');
select tests.expect_error($$select public.approve_payout(gen_random_uuid())$$, 'permission denied', 'visitor cannot reach payout approval');
select tests.expect_error($$select public.analytics_overview(null, current_date, current_date, 'day')$$, 'permission denied', 'visitor cannot reach analytics');
select tests.ok((select public.track_order('ACC-000000000000-ACC', null)) is not distinct from (select public.track_order('ACC-000000000000-ACC', null)),
                'visitor can still use public tracking');
select tests.login('00000000-0000-0000-0000-000000001301');
select tests.expect_error($$select public._order_payload(null::orders)$$, 'permission denied', 'customer cannot call internal order payload');
select tests.expect_error($$select public.hub_cash_on_hand(gen_random_uuid())$$, 'permission denied', 'customer cannot see hub cash');
select tests.expect_error($$select public.next_tracking_number(gen_random_uuid(), null, now())$$, 'permission denied', 'customer cannot reserve tracking numbers');
select tests.expect_error($$select public._ledger('x', 'y', '[]', null, null, null)$$, 'permission denied', 'customer cannot write the ledger');
select tests.expect_error($$insert into app_settings (key, value) values ('topup_max', '1')$$, 'row-level security', 'customer cannot change settings');
select tests.ok((select public.get_setting('geofence_radius_m', null)) is not null, 'customer can read app settings the apps need');

-- =====================================================================
-- 9. Rate limiting
-- =====================================================================
select tests.logout();
select tests.ok((select array_agg(public.rate_hit('test:bucket', 3, 60)) from generate_series(1, 5)) = array[true, true, true, false, false],
                'rate_hit: 3 allowed, then refused');
select tests.ok(public.rate_hit('test:other', 3, 60), 'another bucket has its own count');
select tests.ok(not has_function_privilege('anon', 'public.rate_hit(text, int, int)', 'execute')
                and not has_function_privilege('authenticated', 'public.rate_hit(text, int, int)', 'execute'), 'apps cannot reset or fill the counters');
update rate_limits set window_start = window_start - interval '2 days' where bucket = 'test:other';
select tests.ok(public.purge_rate_limits() = 1, 'old counters are cleaned up');
select tests.ok(not exists (select 1 from rate_limits where bucket = 'test:other') and exists (select 1 from rate_limits where bucket = 'test:bucket'), 'only the old ones');

-- riders may resend a delivery code only 3 times an hour (each resend gives 5 new guesses)
insert into auth.users (id, phone) values ('00000000-0000-0000-0000-000000001320', '+233200001320'), ('00000000-0000-0000-0000-000000001321', '+233200001321');
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000001320', 'bike', 'GR-1320');
insert into riders (id, rider_type, status, city_id, vehicle_id) select '00000000-0000-0000-0000-000000001320', 'fleet', 'active', id, '50000000-0000-0000-0000-000000001320' from cities where code = 'ACC';
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001321', 'dispatcher', id from cities where code = 'ACC';
insert into orders (id, service_type, city_id, rider_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method, status)
select '20000000-0000-0000-0000-000000001320', 'express', id, '00000000-0000-0000-0000-000000001320', st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography,
       st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography, 'Ama', '+233240001320', 1000, 2000, 'sender', 'cash', 'ARRIVED_AT_DROPOFF' from cities where code = 'ACC';
select tests.login('00000000-0000-0000-0000-000000001320');
select public.resend_delivery_code('20000000-0000-0000-0000-000000001320') from generate_series(1, 3);
select tests.expect_error($$select public.resend_delivery_code('20000000-0000-0000-0000-000000001320')$$, 'resent 3 times', 'rider: 4th resend in an hour refused');
select tests.login('00000000-0000-0000-0000-000000001321');
select public.resend_delivery_code('20000000-0000-0000-0000-000000001320');
select tests.logout();
select tests.ok((select count(*) from notifications where order_id = '20000000-0000-0000-0000-000000001320' and template = 'delivery_code') = 4,
                'dispatch can still resend after the rider hit the limit');

rollback;
