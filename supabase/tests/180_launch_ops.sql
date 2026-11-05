-- =====================================================================
-- Phase 14 tests: forced app updates, pausing a city, system health + alerts, deployment check.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone, email) values
  ('00000000-0000-0000-0000-000000001801', '+233200001801', null),                       -- customer in Accra
  ('00000000-0000-0000-0000-000000001810', '+233200001810', 'boss18@qcsghana.com'),      -- super admin
  ('00000000-0000-0000-0000-000000001811', '+233200001811', 'acc18@qcsghana.com'),       -- Accra city admin
  ('00000000-0000-0000-0000-000000001812', '+233200001812', 'disp18@qcsghana.com');      -- Accra dispatcher
update profiles set email = u.email from auth.users u where u.id = profiles.id and u.email is not null;
insert into user_roles (user_id, role) values ('00000000-0000-0000-0000-000000001810', 'super_admin');
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001811', 'city_admin', id from cities where code = 'ACC';
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001812', 'dispatcher', id from cities where code = 'ACC';
create temp table c18 as select (select id from cities where code = 'ACC') acc, (select id from cities where code = 'KSI') ksi;
grant select on c18 to anon, authenticated, service_role;
-- two draft cash bookings: one in Accra, one in Kumasi
insert into orders (id, service_type, city_id, customer_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method, status)
select ('20000000-0000-0000-0000-00000000180' || n)::uuid, 'express', case when n = 1 then acc else ksi end, '00000000-0000-0000-0000-000000001801',
       st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography, st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography, 'Esi', '+233240001801',
       1000, 2500, 'sender', 'cash', 'DRAFT'
from c18, generate_series(1, 3) n;

-- =====================================================================
-- 1. Versions
-- =====================================================================
select tests.ok(public._version_lt('1.2.9', '1.10.0') and not public._version_lt('1.10.0', '1.9.9') and not public._version_lt('2.0', '2.0.0')
                and public._version_lt('1.0', '1.0.1') and not public._version_lt('1.0.0 (45)', '1.0.0'), 'versions compare number by number');
update app_settings set value = '"1.1.0"' where key = 'app_min_version_rider' and city_id is null;
update app_settings set value = '"1.3.0"' where key = 'app_latest_version_rider' and city_id is null;
select tests.login(null);
select tests.ok((public.app_status('rider', '1.0.4', 'android') ->> 'update_required')::boolean, 'visitor (before sign-in): old rider app must update');
select tests.ok((public.app_status('rider', '1.0.4', 'android') ->> 'store_url') = 'https://play.google.com/store/apps/details?id=gh.qcs.rider', '… with the Play Store link');
select tests.ok(not (public.app_status('rider', '1.2.0', 'ios') ->> 'update_required')::boolean and (public.app_status('rider', '1.2.0', 'ios') ->> 'update_available')::boolean
                and (public.app_status('rider', '1.2.0', 'ios') ->> 'store_url') like 'https://apps.apple.com/%', 'newer-than-minimum: gentle "update available"');
select tests.ok(not (public.app_status('client', '1.0.0', 'android') ->> 'update_required')::boolean, 'client app has its own minimum');
select tests.ok(public.app_status('admin', '1.0.0') is null, 'unknown app: nothing');

-- =====================================================================
-- 2. Pausing a city
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001812');
select tests.expect_error(format('select public.set_city_pause(%L, now() + interval ''2 hours'', ''Heavy rain'')', (select acc from c18)), 'only a super admin', 'a dispatcher cannot pause a city');
select tests.login('00000000-0000-0000-0000-000000001811');
select tests.expect_error(format('select public.set_city_pause(%L, now() + interval ''2 hours'', ''Rain'')', (select ksi from c18)), 'only a super admin', 'the Accra admin cannot pause Kumasi');
select tests.expect_error(format('select public.set_city_pause(%L, now() + interval ''8 days'', ''Long'')', (select acc from c18)), 'up to 7 days', 'at most 7 days');
select tests.expect_error(format('select public.set_city_pause(%L, now() + interval ''2 hours'', '''')', (select acc from c18)), 'short message', 'a message is required');
select public.set_city_pause((select acc from c18), date_trunc('minute', now()) + interval '2 hours', 'Heavy rain: back soon');
-- the customer tries to book in Accra and in Kumasi
select tests.login('00000000-0000-0000-0000-000000001801');
select tests.expect_error($$select transition_order('20000000-0000-0000-0000-000000001801', 'CONFIRMED')$$, 'bookings in accra are paused until', 'Accra booking refused with the reason');
select tests.ok((select status from orders where id = '20000000-0000-0000-0000-000000001801') = 'DRAFT', '… and it stays a draft');
select transition_order('20000000-0000-0000-0000-000000001802', 'CONFIRMED');
select tests.ok((select status from orders where id = '20000000-0000-0000-0000-000000001802') = 'CONFIRMED', 'Kumasi carries on');
select tests.ok((select jsonb_array_length(public.app_status('client', '1.0.0') -> 'pauses')) = 1
                and (public.app_status('client', '1.0.0') -> 'pauses' -> 0 ->> 'text') like 'Bookings in Accra are paused until __:__: Heavy rain: back soon', 'the apps get the message to show');
select tests.logout();
select tests.ok(exists (select 1 from audit_log where table_name = 'cities' and reason = 'Heavy rain: back soon'), 'pausing is in the audit log');
select tests.login('00000000-0000-0000-0000-000000001811');
select public.set_city_pause((select acc from c18), null, null);
select tests.login('00000000-0000-0000-0000-000000001801');
select transition_order('20000000-0000-0000-0000-000000001801', 'CONFIRMED');
select tests.ok((select status from orders where id = '20000000-0000-0000-0000-000000001801') = 'CONFIRMED', 'after resuming, Accra books again');
select tests.ok(public.app_status('client', '1.0.0') -> 'pauses' = '[]'::jsonb, 'banner gone');

-- =====================================================================
-- 3. System health
-- =====================================================================
select tests.login(null);
select tests.expect_error($$select public.system_health()$$, 'permission denied', 'visitors cannot see system health');
select tests.login('00000000-0000-0000-0000-000000001801');
select tests.expect_error($$select public.system_health()$$, 'not allowed', 'customers cannot see system health');
select tests.expect_error($$select public.health_ping()$$, 'permission denied', 'health_ping is for the server');
select tests.login('00000000-0000-0000-0000-000000001810');
select tests.ok((select x ->> 'status' from jsonb_array_elements(public.system_health() -> 'checks') x where x ->> 'key' = 'messages_waiting') = 'ok', 'messages: ok to start with');
select tests.ok((select x ->> 'status' from jsonb_array_elements(public.system_health() -> 'checks') x where x ->> 'key' = 'scheduled_jobs') = 'bad', 'no scheduler installed here: red, with the fix');
-- the message sender stops: 25 messages waiting 20 minutes
select tests.logout();
insert into notifications (to_address, channel, template, payload, status, created_at, next_attempt_at)
select '+233200001801', 'sms', 'delivery_code', '{}', 'queued', now() - interval '20 minutes', now() - interval '20 minutes' from generate_series(1, 25);
select tests.service();
select tests.ok(not (public.health_ping() ->> 'ok')::boolean and public.health_ping() -> 'bad' ? 'messages_waiting', 'uptime endpoint sees the problem');
select tests.ok((public.health_check() ->> 'alerted')::int = 2, 'health check: two red problems → one email');
select tests.logout();
select tests.ok((select count(*) from notifications where template = 'system_alert') = 1
                and (select user_id from notifications where template = 'system_alert') = '00000000-0000-0000-0000-000000001810', 'email goes to the Super Admin');
select tests.ok((select payload ->> 'summary' from notifications where template = 'system_alert') like '%Messages waiting to be sent: 25%', 'it says what is wrong');
select tests.service();
select public.health_check();
select tests.logout();
select tests.ok((select count(*) from notifications where template = 'system_alert') = 1, 'no repeat email within 3 hours');
-- fixed
update notifications set status = 'sent', sent_at = now() where template = 'delivery_code' and to_address = '+233200001801';
select tests.service();
select public.health_check();
select tests.logout();
select tests.ok((select resolved_at is not null and status <> 'bad' from health_alerts where key = 'messages_waiting'), 'recovery is recorded');
select tests.login('00000000-0000-0000-0000-000000001812');
select tests.ok((select count(*) from jsonb_array_elements(public.system_health() -> 'checks')) >= 9, 'dispatcher sees all the checks');

-- =====================================================================
-- 4. Deployment check
-- =====================================================================
select tests.expect_error($$select public.deployment_check()$$, 'permission denied', 'deployment check is for the server');
select tests.service();
select tests.ok(not (public.deployment_check() ->> 'ok')::boolean, 'this test database is not a complete deployment');
select tests.ok((select x ->> 'fix' from jsonb_array_elements(public.deployment_check() -> 'items') x where x ->> 'item' like 'pg_cron%') like '%Extensions%', 'each missing piece says how to fix it');
select tests.ok((select (x ->> 'ok')::boolean from jsonb_array_elements(public.deployment_check() -> 'items') x where x ->> 'item' = 'storage buckets'), 'buckets are there');
select tests.logout();

rollback;
