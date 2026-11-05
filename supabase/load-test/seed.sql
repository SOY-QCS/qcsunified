-- =====================================================================
-- Load-test data: a city-scale QCS at 10,000 deliveries/day.
--   1,500 riders (60% Accra, 20% Kumasi, 10% Takoradi, 10% Tamale), 3,000 customers, 300 vendors,
--   30 days of history = 300,000 orders + ~1.6 million status events + order facts for the reports,
--   2 million recent location pings.
-- For a THROW-AWAY database only (run.sh creates and drops one). Never run against Supabase.
-- =====================================================================
\set QUIET on
\set ON_ERROR_STOP on
create schema loadtest;

-- ids: rider n = b1…n, customer n = c1…n, vendor owner n = d1…n, vendor n = e1…n
create function loadtest.id(p_kind text, n int) returns uuid language sql immutable as $$
  select (p_kind || '1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function loadtest.city_for(n int) returns uuid language sql stable as $$
  select id from public.cities where code = case when n % 10 < 6 then 'ACC' when n % 10 < 8 then 'KSI' when n % 10 = 8 then 'TKD' else 'TML' end $$;
-- a random spot near the middle of one of the city's zones (± ~1.5 km)
create function loadtest.spot(p_city uuid) returns geography language sql volatile as $$
  select st_setsrid(st_makepoint(st_x(c) + (random() - 0.5) * 0.03, st_y(c) + (random() - 0.5) * 0.03), 4326)::geography
  from (select st_centroid(area::geometry) c from public.zones where city_id = p_city order by random() limit 1) z $$;

-- ---------- people ----------
insert into auth.users (id, phone)
select loadtest.id('b', n), '+23320' || lpad(n::text, 7, '0') from generate_series(1, 1500) n
union all select loadtest.id('c', n), '+23324' || lpad(n::text, 7, '0') from generate_series(1, 3000) n
union all select loadtest.id('d', n), '+23326' || lpad(n::text, 7, '0') from generate_series(1, 300) n;
update public.profiles set full_name = 'Load ' || left(id::text, 1) || right(id::text, 5), terms_accepted_at = now();
insert into auth.users (id, phone, email) values ('a1000000-0000-4000-8000-000000000001', '+233200999999', 'boss@qcsghana.com');
insert into public.user_roles (user_id, role) values ('a1000000-0000-4000-8000-000000000001', 'super_admin');
insert into public.vendors (id, owner_id, business_name, city_id)
select loadtest.id('e', n), loadtest.id('d', n), 'Load Vendor ' || n, loadtest.city_for(n) from generate_series(1, 300) n;

insert into public.vehicles (id, type, plate_number, max_weight_g)
select loadtest.id('f', n), 'bike', 'LT-' || n, 15000 from generate_series(1, 1500) n;
-- 1,200 riders online (80%), positioned around their city
insert into public.riders (id, rider_type, status, city_id, vehicle_id, is_online, last_location, last_location_at)
select loadtest.id('b', n), case when n % 3 = 0 then 'commission' else 'fleet' end::public.rider_type, 'active', loadtest.city_for(n), loadtest.id('f', n),
       n <= 1200, loadtest.spot(loadtest.city_for(n)), now()
from generate_series(1, 1500) n;

-- ---------- 30 days of history (triggers off for speed; the facts are rebuilt below) ----------
set session_replication_role = replica;
create temp table h as
select n, now() - make_interval(secs => n * 8.64 + 600)  at0,     -- 300,000 orders spread evenly over 30 days
       loadtest.city_for(n) city, n % 4 = 0 is_vendor, n % 100 x
from generate_series(1, 300000) n;
insert into public.orders (id, tracking_number, service_type, city_id, vendor_id, customer_id, rider_id, pickup_location, dropoff_location, dropoff_zone_id,
                           recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method, status, created_at, delivered_at, cod_amount)
select loadtest.id('9', n),
       c.tracking_code || '-' || to_char(h.at0 at time zone 'Africa/Accra', 'YYYYMMDDHH24MI') || '-' || c.tracking_code || '-' || n,
       case when h.is_vendor then 'ecommerce' else 'express' end::public.service_type, h.city,
       case when h.is_vendor then loadtest.id('e', 1 + n % 300) end, case when h.is_vendor then loadtest.id('d', 1 + n % 300) else loadtest.id('c', 1 + n % 3000) end,
       loadtest.id('b', 1 + n % 1500), loadtest.spot(h.city), loadtest.spot(h.city), null,
       'Recipient ' || n, '+23355' || lpad((n % 200000)::text, 7, '0'), 1000 + n % 9000, 2500 + (n % 20) * 100, 'sender', 'cash',
       case when h.x < 90 then 'DELIVERED' when h.x < 95 then 'CANCELLED' else 'RETURNED' end::public.order_status,
       h.at0, case when h.x < 90 then h.at0 + interval '55 minutes' end, case when h.is_vendor then 15000 else 0 end
from h join public.cities c on c.id = h.city;
-- every history order travelled on a (finished) trip: Express = one trip each, e-commerce = 10 stops per trip
insert into public.trips (id, trip_type, status, city_id, rider_id, vendor_id, assigned_at, completed_at, created_at, dispatch_state, pickup_location)
select loadtest.id('8', n), case when n % 4 = 0 then 'bulk' else 'express' end::public.trip_type,
       case when x < 90 then 'COMPLETED' else 'CANCELLED' end::public.trip_status, city, loadtest.id('b', 1 + n % 1500),
       case when n % 4 = 0 then loadtest.id('e', 1 + n % 300) end, at0, at0 + interval '1 hour', at0, 'assigned', null
from h where n % 4 <> 0 or n % 40 = 0;
update public.orders o set trip_id = loadtest.id('8', case when n % 4 <> 0 then n else (n / 40) * 40 end)
from h where o.id = loadtest.id('9', h.n) and (h.n % 4 <> 0 or (h.n / 40) * 40 > 0);
update public.orders o set dropoff_zone_id = (select z.zone_id from public.zone_for_point(st_x(o.dropoff_location::geometry), st_y(o.dropoff_location::geometry)) z limit 1)
where o.id in (select loadtest.id('9', n) from generate_series(1, 300000) n);
insert into public.order_events (order_id, from_status, to_status, actor_id, created_at, occurred_at)
select loadtest.id('9', h.n), s.f::public.order_status, s.t::public.order_status, case when s.t <> 'CONFIRMED' then loadtest.id('b', 1 + h.n % 1500) end,
       h.at0 + s.m * interval '1 minute', h.at0 + s.m * interval '1 minute'
from h cross join lateral (values ('DRAFT', 'CONFIRMED', 0), ('CONFIRMED', 'ASSIGNED', 3), ('ASSIGNED', 'PICKED_UP', 18), ('PICKED_UP', 'IN_TRANSIT', 20),
                                  ('IN_TRANSIT', case when h.x < 90 then 'DELIVERED' else 'FAILED_ATTEMPT' end, 55),
                                  ('FAILED_ATTEMPT', 'RETURNED', 120)) s(f, t, m)
where h.x >= 90 and h.x < 95 and s.m = 0 or h.x < 90 and s.m <= 55 or h.x >= 95;
-- cancelled ones: CONFIRMED then CANCELLED
insert into public.order_events (order_id, from_status, to_status, actor_id, created_at, occurred_at)
select loadtest.id('9', n), 'CONFIRMED', 'CANCELLED', null, at0 + interval '5 minutes', at0 + interval '5 minutes' from h where x >= 90 and x < 95;
-- 2 million location pings over the last 7 days (idle riders: the kind that gets cleaned up)
insert into public.rider_location_pings (rider_id, location, accuracy_m, recorded_at)
select loadtest.id('b', 1 + n % 1500), st_setsrid(st_makepoint(-0.2 + (n % 1000) * 0.0001, 5.6), 4326)::geography, 12, now() - make_interval(secs => n * 0.3)
from generate_series(1, 2000000) n;
set session_replication_role = origin;

-- report facts for every history order (what the analytics pages read)
select count(*) from (select public._refresh_order_fact(id) from public.orders) f;
analyze;

-- ---------- the actors (each call = one thing a real person/app does) ----------
create function loadtest.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true) $$;
create function loadtest.as_server() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true) $$;

-- a rider's phone sends its position (on a job: every ~12 s; idle: every ~60 s)
create function loadtest.ping(n int) returns void language plpgsql as $$
declare r public.riders;
begin
  select * into r from public.riders where id = loadtest.id('b', n);
  if not r.is_online then return; end if;
  perform loadtest.as_user(r.id);
  perform public.rider_ping(st_x(r.last_location::geometry) + (random() - 0.5) * 0.002, st_y(r.last_location::geometry) + (random() - 0.5) * 0.002, 10);
end $$;

-- a customer (or vendor) books, as the booking server does after pricing: quote → create_booking
create function loadtest.book(n int, p_vendor boolean default false) returns void language plpgsql as $$
declare city uuid := loadtest.city_for(n); p geography := loadtest.spot(city); d geography := loadtest.spot(city); q uuid; req jsonb;
        who uuid := case when p_vendor then loadtest.id('d', 1 + n % 300) else loadtest.id('c', 1 + n % 3000) end;
        ven uuid := case when p_vendor then loadtest.id('e', 1 + n % 300) end;
begin
  req := jsonb_build_object('service', case when p_vendor then 'ecommerce' else 'express' end, 'payer', 'sender', 'payment_method', 'cash',
    'pickup', jsonb_build_object('formatted_address', 'Shop', 'lat', st_y(p::geometry), 'lng', st_x(p::geometry), 'contact_name', 'Ama', 'contact_phone', '+233241111111'),
    'dropoffs', jsonb_build_array(jsonb_build_object('formatted_address', 'Home', 'lat', st_y(d::geometry), 'lng', st_x(d::geometry), 'contact_name', 'Esi',
       'contact_phone', '+23324' || lpad((n % 9999999)::text, 7, '0'), 'weight_g', 1500, 'size', 'small', 'fragile', false, 'item_value', 0, 'cod_amount', 0,
       'external_ref', case when p_vendor then 'LT-' || n || '-' || floor(random() * 1e9)::bigint end)));
  insert into public.quotes (user_id, vendor_id, service_type, city_id, request, price, zones, total)
  values (who, ven, (req ->> 'service')::public.service_type, city, req,
          jsonb_build_object('stops', jsonb_build_array(jsonb_build_object('netPesewas', 3000, 'insurancePesewas', 0, 'lines', '[]'::jsonb))),
          jsonb_build_array((select z.zone_id from public.zone_for_point(st_x(d::geometry), st_y(d::geometry)) z limit 1)), 3000)
  returning id into q;
  perform loadtest.as_server();
  perform public.create_booking(who, q);
end $$;

-- a rider answers a job offer (85% accept)
create function loadtest.answer_offer() returns void language plpgsql as $$
declare o public.job_offers;
begin
  select * into o from public.job_offers where status = 'offered' and expires_at > now() limit 1 for update skip locked;
  if not found then return; end if;
  perform loadtest.as_user(o.rider_id);
  perform public.respond_offer(o.id, random() < 0.85);
end $$;

-- a rider moves one of their jobs one step forward (at the drop-off: code + signature + DELIVERED)
create function loadtest.advance() returns void language plpgsql as $$
declare o public.orders; nxt text; pt geometry;
begin
  select * into o from public.orders
  where rider_id is not null and status in ('ASSIGNED', 'RIDER_AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_AT_DROPOFF')
  limit 1 offset floor(random() * 20) for update skip locked;
  if not found then return; end if;
  perform loadtest.as_user(o.rider_id);
  nxt := case o.status when 'ASSIGNED' then 'RIDER_AT_PICKUP' when 'RIDER_AT_PICKUP' then 'PICKED_UP' when 'PICKED_UP' then 'IN_TRANSIT'
                       when 'IN_TRANSIT' then 'ARRIVED_AT_DROPOFF' else 'DELIVERED' end;
  pt := case when nxt in ('RIDER_AT_PICKUP', 'PICKED_UP') then o.pickup_location::geometry else o.dropoff_location::geometry end;
  if nxt = 'DELIVERED' then
    -- the recipient reads the code out: we know it because we set it (the real code was texted)
    perform public._sys(1);
    update public.orders set delivery_otp_hash = crypt('4821', gen_salt('bf', 6)), pod_otp_attempts = 0 where id = o.id;
    perform public._sys(-1);
    perform public.rider_action(gen_random_uuid(), jsonb_build_object('type', 'code', 'order_id', o.id, 'code', '4821'));
    insert into storage.objects (bucket_id, name) values ('pod', o.id::text || '/signature.svg');
    perform public.rider_action(gen_random_uuid(), jsonb_build_object('type', 'pod', 'order_id', o.id, 'signature_path', o.id::text || '/signature.svg'));
  end if;
  perform public.rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', o.id, 'to', nxt, 'lng', st_x(pt), 'lat', st_y(pt)));
end $$;

-- someone opens the public tracking page
create function loadtest.track(n int) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform public.track_order((select tracking_number from public.orders where id = loadtest.id('9', 1 + n % 300000)), null);
end $$;

-- the dispatch schedule (every 5 s in production)
create function loadtest.tick() returns void language plpgsql as $$
begin perform loadtest.as_server(); perform public.dispatch_tick(); end $$;

select 'seeded' as done, (select count(*) from public.orders) orders, (select count(*) from public.order_events) events,
       (select count(*) from public.order_facts) facts, (select count(*) from public.rider_location_pings) pings, pg_size_pretty(pg_database_size(current_database())) size;
