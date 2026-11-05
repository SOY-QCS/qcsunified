-- =====================================================================
-- Phase 12 — Analytics & reports
--   1. order_facts: one row per booked delivery (times of each step, outcome, on-time), kept up to date by a trigger
--      on every status change — dashboards read this instead of scanning orders + history (10,000+ a day)
--   2. rider_shifts: when riders go online/offline (for utilisation)
--   3. Report functions for the ops dashboard (overview, riders, vendors, heatmap, COD outstanding)
--   4. Vendor analytics for the client portal
--   5. Scheduled email reports (daily / weekly / monthly)
-- =====================================================================

insert into public.app_settings (key, value, description) values
  ('ontime_express_minutes',  '90',      'On time: Express delivered within this many minutes of booking (or of the scheduled pickup)'),
  ('ontime_ecommerce_by',     '"21:00"', 'On time: e-commerce delivered by this time (Accra) on its pickup day'),
  ('ontime_intercity_hours',  '48',      'On time: inter-city delivered (or ready at the hub for collection) within this many hours of booking')
on conflict do nothing;

-- ---------- 1. order facts ----------
create table public.order_facts (
  order_id        uuid primary key references public.orders(id) on delete cascade,
  city_id         uuid references public.cities(id),
  service_type    text not null,
  intercity_option text,
  vendor_id       uuid references public.vendors(id) on delete set null,
  customer_id     uuid,
  rider_id        uuid,
  zone_id         uuid,
  drop_lat        double precision,
  drop_lng        double precision,
  booked_at       timestamptz not null,
  day             date not null,                 -- booking day, Accra
  assigned_at     timestamptz,
  picked_up_at    timestamptz,
  ready_at        timestamptz,                   -- hub collection: ready at the destination hub
  delivered_at    timestamptz,
  finished_at     timestamptz,
  status          text not null,
  outcome         text not null check (outcome in ('open', 'delivered', 'returned', 'cancelled', 'lost')),
  failed_attempts smallint not null default 0,
  last_failed_reason text,
  due_at          timestamptz,
  on_time         boolean,                        -- null until delivered / ready
  updated_at      timestamptz not null default now()
);
create index order_facts_day_city_idx on public.order_facts (day, city_id);
create index order_facts_vendor_day_idx on public.order_facts (vendor_id, day) where vendor_id is not null;
create index order_facts_rider_day_idx on public.order_facts (rider_id, day) where rider_id is not null;
create index order_events_failed_idx on public.order_events (created_at) where to_status = 'FAILED_ATTEMPT';
alter table public.order_facts enable row level security;    -- read only through the report functions below

/** Rebuild one order's fact row from the order and its history (idempotent; cheap: an order has a handful of events). */
create or replace function public._refresh_order_fact(p_order uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; e record; due timestamptz; ot boolean; outc text;
begin
  select * into o from public.orders where id = p_order;
  if not found then return; end if;
  select min(t) filter (where to_status::text <> 'DRAFT') booked,
         min(t) filter (where to_status = 'ASSIGNED') assigned,
         min(t) filter (where to_status = 'PICKED_UP') picked,
         min(t) filter (where to_status = 'READY_FOR_COLLECTION') ready,
         max(t) filter (where to_status in ('DELIVERED', 'COLLECTED')) delivered,
         max(t) filter (where to_status in ('DELIVERED', 'COLLECTED', 'RETURNED', 'CANCELLED', 'LOST', 'DAMAGED')) finished,
         count(*) filter (where to_status = 'FAILED_ATTEMPT') fails,
         (array_agg(reason order by id desc) filter (where to_status = 'FAILED_ATTEMPT'))[1] last_reason
    into e
    from (select id, to_status, reason, coalesce(occurred_at, created_at) t from public.order_events where order_id = p_order) x;
  if e.booked is null then return; end if;     -- still a draft

  outc := case when o.status in ('DELIVERED', 'COLLECTED') then 'delivered' when o.status = 'RETURNED' then 'returned'
               when o.status = 'CANCELLED' then 'cancelled' when o.status in ('LOST', 'DAMAGED') then 'lost' else 'open' end;
  due := case
    when o.service_type = 'express' then coalesce(o.scheduled_pickup_at, e.booked) + make_interval(mins => public.setting_int('ontime_express_minutes', 90)::int)
    when o.service_type = 'intercity' then e.booked + make_interval(hours => public.setting_int('ontime_intercity_hours', 48)::int)
    else (coalesce(o.pickup_date, (e.booked at time zone 'Africa/Accra')::date)
          + coalesce((public.get_setting('ontime_ecommerce_by') #>> '{}')::time, '21:00'::time)) at time zone 'Africa/Accra' end;
  ot := case when o.intercity_option = 'hub_collection' and e.ready is not null then e.ready <= due
             when e.delivered is not null then e.delivered <= due end;

  insert into public.order_facts as f (order_id, city_id, service_type, intercity_option, vendor_id, customer_id, rider_id, zone_id, drop_lat, drop_lng,
      booked_at, day, assigned_at, picked_up_at, ready_at, delivered_at, finished_at, status, outcome, failed_attempts, last_failed_reason, due_at, on_time, updated_at)
  values (o.id, o.city_id, o.service_type::text, o.intercity_option::text, o.vendor_id, o.customer_id, o.rider_id, o.dropoff_zone_id,
      st_y(o.dropoff_location::geometry), st_x(o.dropoff_location::geometry),
      e.booked, (e.booked at time zone 'Africa/Accra')::date, e.assigned, e.picked, e.ready, e.delivered, e.finished,
      o.status::text, outc, e.fails, e.last_reason, due, ot, now())
  on conflict (order_id) do update set
      rider_id = excluded.rider_id, zone_id = excluded.zone_id, drop_lat = excluded.drop_lat, drop_lng = excluded.drop_lng,
      assigned_at = excluded.assigned_at, picked_up_at = excluded.picked_up_at, ready_at = excluded.ready_at,
      delivered_at = excluded.delivered_at, finished_at = excluded.finished_at, status = excluded.status, outcome = excluded.outcome,
      failed_attempts = excluded.failed_attempts, last_failed_reason = excluded.last_failed_reason, due_at = excluded.due_at,
      on_time = excluded.on_time, updated_at = now();
end $$;

create or replace function public.order_fact_on_event() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._refresh_order_fact(new.order_id);
  return null;
end $$;
create trigger order_events_facts after insert on public.order_events for each row execute function public.order_fact_on_event();

-- the rider of an order can change without a status change (reassignment); the drop-off can move (pin correction)
create or replace function public.order_fact_on_order() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.order_facts set rider_id = new.rider_id, zone_id = new.dropoff_zone_id,
         drop_lat = st_y(new.dropoff_location::geometry), drop_lng = st_x(new.dropoff_location::geometry), updated_at = now()
   where order_id = new.id;
  return null;
end $$;
create trigger orders_facts after update of rider_id, dropoff_location, dropoff_zone_id on public.orders
  for each row execute function public.order_fact_on_order();

-- every order booked before this phase
select public._refresh_order_fact(id) from public.orders where status <> 'DRAFT';

-- ---------- 2. rider shifts ----------
create table public.rider_shifts (
  id         bigint generated always as identity primary key,
  rider_id   uuid not null references public.riders(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);
create index rider_shifts_rider_idx on public.rider_shifts (rider_id, started_at desc);
create unique index rider_shifts_open_idx on public.rider_shifts (rider_id) where ended_at is null;
alter table public.rider_shifts enable row level security;
create policy rider_shifts_read on public.rider_shifts for select to authenticated
  using (rider_id = (select auth.uid()) or exists (select 1 from public.riders r where r.id = rider_shifts.rider_id and public.is_ops(r.city_id)));

create or replace function public.rider_shift_on_toggle() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.is_online and not coalesce(old.is_online, false) then
    insert into public.rider_shifts (rider_id) values (new.id) on conflict do nothing;
  elsif not new.is_online and coalesce(old.is_online, false) then
    update public.rider_shifts set ended_at = now() where rider_id = new.id and ended_at is null;
  end if;
  return null;
end $$;
create trigger riders_shifts after update of is_online on public.riders for each row execute function public.rider_shift_on_toggle();
insert into public.rider_shifts (rider_id) select id from public.riders where is_online;

-- ---------- 3. ops reports ----------
/** Cities this caller may see in reports (null p_city = all of theirs). Super Admin / Finance / Analyst without a city see all. */
create or replace function public._report_cities(p_city uuid) returns uuid[]
language plpgsql stable security definer set search_path = public, extensions as $$
declare all_c boolean; mine uuid[];
begin
  if public.is_trusted() then
    return case when p_city is null then array(select id from public.cities) else array[p_city] end;
  end if;
  select bool_or(city_id is null), array_agg(city_id) filter (where city_id is not null) into all_c, mine
    from public.user_roles where user_id = auth.uid() and role in ('super_admin', 'city_admin', 'finance', 'analyst', 'hub_manager');
  if all_c then return case when p_city is null then array(select id from public.cities) else array[p_city] end; end if;
  if mine is null then raise exception 'Reports are for admins, finance, analysts and hub managers'; end if;
  if p_city is not null then
    if not p_city = any (mine) then raise exception 'You can only see reports for your city'; end if;
    return array[p_city];
  end if;
  return mine;
end $$;

/** Fee QCS earned on an order: delivered → delivery fee (+ extra + insurance); returned → the failed/return fee. */
create or replace function public._order_revenue(o public.orders) returns bigint language sql immutable as $$
  select case when o.status in ('DELIVERED', 'COLLECTED') then o.quoted_fee + coalesce(o.extra_fee, 0) + coalesce(o.insurance_premium, 0)
              when o.status in ('RETURNED', 'RETURNING_TO_SENDER') then coalesce(o.failed_fee, 0) else 0 end;
$$;

create or replace function public._kpis(p_cities uuid[], p_from date, p_to date, p_service text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'orders', count(*),
    'delivered', count(*) filter (where f.outcome = 'delivered'),
    'returned', count(*) filter (where f.outcome = 'returned'),
    'cancelled', count(*) filter (where f.outcome = 'cancelled'),
    'lost', count(*) filter (where f.outcome = 'lost'),
    'open', count(*) filter (where f.outcome = 'open'),
    'failed_attempts', coalesce(sum(f.failed_attempts), 0),
    'success_pct', round(100.0 * count(*) filter (where f.outcome = 'delivered') / nullif(count(*) filter (where f.outcome in ('delivered', 'returned', 'lost')), 0), 1),
    'on_time_pct', round(100.0 * count(*) filter (where f.on_time) / nullif(count(*) filter (where f.on_time is not null), 0), 1),
    'revenue', coalesce(sum(public._order_revenue(o)), 0),
    'avg_pickup_min', round(avg(extract(epoch from f.picked_up_at - f.booked_at) / 60) filter (where f.service_type = 'express' and f.picked_up_at is not null)),
    'avg_delivery_min', round(avg(extract(epoch from f.delivered_at - f.picked_up_at) / 60) filter (where f.service_type <> 'intercity' and f.delivered_at is not null and f.picked_up_at is not null)))
  from public.order_facts f join public.orders o on o.id = f.order_id
  where f.day between p_from and p_to and f.city_id = any (p_cities) and (p_service is null or f.service_type = p_service);
$$;

/** Everything for the Analytics overview: KPIs (+ the previous period to compare), daily series, cities, services, failure reasons, COD. */
create or replace function public.analytics_overview(p_city uuid, p_from date, p_to date, p_service text default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid[] := public._report_cities(p_city); len int := p_to - p_from + 1;
begin
  perform public._need(p_to >= p_from and len <= 366, 'Choose a period of up to a year');
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'kpis', public._kpis(c, p_from, p_to, p_service),
    'previous', public._kpis(c, p_from - len, p_from - 1, p_service),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'express', coalesce(x.express, 0), 'ecommerce', coalesce(x.ecommerce, 0),
                'intercity', coalesce(x.intercity, 0), 'delivered', coalesce(x.delivered, 0), 'revenue', coalesce(x.revenue, 0)) order by d.day), '[]')
              from generate_series(p_from, p_to, interval '1 day') d(day)
              left join (select f.day, count(*) filter (where f.service_type = 'express') express, count(*) filter (where f.service_type in ('ecommerce', 'scheduled')) ecommerce,
                                count(*) filter (where f.service_type = 'intercity') intercity, count(*) filter (where f.outcome = 'delivered') delivered,
                                sum(public._order_revenue(o)) revenue
                         from public.order_facts f join public.orders o on o.id = f.order_id
                         where f.day between p_from and p_to and f.city_id = any (c) and (p_service is null or f.service_type = p_service) group by f.day) x on x.day = d.day::date),
    'by_city', (select coalesce(jsonb_agg(jsonb_build_object('city', ci.name, 'city_id', ci.id) || public._kpis(array[ci.id], p_from, p_to, p_service) order by ci.name), '[]')
                from public.cities ci where ci.id = any (c)),
    'by_service', (select coalesce(jsonb_agg(jsonb_build_object('service', s) || public._kpis(c, p_from, p_to, s)), '[]')
                   from unnest(array['express', 'ecommerce', 'intercity']) s where p_service is null or s = p_service),
    'failed_reasons', (select coalesce(jsonb_agg(jsonb_build_object('reason', r, 'count', n) order by n desc), '[]')
                       from (select coalesce(nullif(e.reason, ''), 'not given') r, count(*) n
                             from public.order_events e join public.order_facts f on f.order_id = e.order_id
                             where e.to_status = 'FAILED_ATTEMPT' and e.created_at >= (p_from::timestamp at time zone 'Africa/Accra')
                               and e.created_at < ((p_to + 1)::timestamp at time zone 'Africa/Accra') and f.city_id = any (c)
                               and (p_service is null or f.service_type = p_service) group by 1) x),
    'cod', public._cod_outstanding(c));
end $$;

/** COD money not yet with the vendor (a snapshot, now): with riders (and overdue), and held by QCS waiting for payout. */
create or replace function public._cod_outstanding(p_cities uuid[]) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'with_riders', coalesce(sum(amount) filter (where status = 'collected'), 0),
    'with_riders_overdue', coalesce(sum(amount) filter (where status = 'collected' and remit_due_by < now()), 0),
    'riders_overdue', count(distinct rider_id) filter (where status = 'collected' and remit_due_by < now()),
    'held_by_qcs', coalesce(sum(amount) filter (where status = 'remitted'), 0),
    'by_city', (select coalesce(jsonb_agg(jsonb_build_object('city', ci.name, 'with_riders', x.wr, 'overdue', x.od, 'held_by_qcs', x.held) order by ci.name), '[]')
                from (select city_id, sum(amount) filter (where status = 'collected') wr, sum(amount) filter (where status = 'collected' and remit_due_by < now()) od,
                             sum(amount) filter (where status = 'remitted') held
                      from public.cod_collections where city_id = any (p_cities) and status in ('collected', 'remitted') group by city_id) x
                join public.cities ci on ci.id = x.city_id))
  from public.cod_collections where city_id = any (p_cities) and status in ('collected', 'remitted');
$$;

/** Riders: jobs, deliveries, online hours, busy hours (on a trip), utilisation, earnings, acceptance. */
create or replace function public.analytics_riders(p_city uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid[] := public._report_cities(p_city);
        t0 timestamptz := p_from::timestamp at time zone 'Africa/Accra'; t1 timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Accra';
begin
  perform public._need(p_to >= p_from and p_to - p_from <= 366, 'Choose a period of up to a year');
  return (select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.delivered desc, x.name), '[]') from (
    select r.id, p.full_name name, r.rider_type, ci.name city, r.rating, r.score,
           (select count(*) from public.trips t where t.rider_id = r.id and t.status = 'COMPLETED' and t.completed_at >= t0 and t.completed_at < t1) trips,
           (select count(*) from public.order_facts f where f.rider_id = r.id and f.outcome = 'delivered' and f.delivered_at >= t0 and f.delivered_at < t1) delivered,
           (select coalesce(sum(f.failed_attempts), 0) from public.order_facts f where f.rider_id = r.id and f.day between p_from and p_to) failed_attempts,
           round((select coalesce(sum(extract(epoch from least(coalesce(s.ended_at, least(now(), r.last_location_at + interval '5 minutes')), t1) - greatest(s.started_at, t0))), 0)
                   from public.rider_shifts s where s.rider_id = r.id and s.started_at < t1 and coalesce(s.ended_at, now()) > t0
                   and least(coalesce(s.ended_at, least(now(), r.last_location_at + interval '5 minutes')), t1) > greatest(s.started_at, t0)) / 3600, 1) online_hours,
           round((select coalesce(sum(extract(epoch from least(coalesce(t.completed_at, now()), t1) - greatest(t.assigned_at, t0))), 0)
                   from public.trips t where t.rider_id = r.id and t.assigned_at is not null and t.assigned_at < t1 and coalesce(t.completed_at, now()) > t0
                   and t.status <> 'CANCELLED') / 3600, 1) busy_hours,
           (select coalesce(sum(e.amount), 0) from public.rider_earnings e where e.rider_id = r.id and e.created_at >= t0 and e.created_at < t1) earnings,
           case when r.offers_received > 0 then round(100.0 * r.offers_accepted / r.offers_received) end acceptance_pct
    from public.riders r join public.profiles p on p.id = r.id left join public.cities ci on ci.id = r.city_id
    where r.city_id = any (c) and r.status in ('active', 'suspended')) x)
    -- utilisation = busy / online (capped at 100% — a trip can start before the shift is recorded)
    -- computed by the caller from busy_hours and online_hours to keep this query simple
    ;
end $$;

/** Vendor ranking by deliveries, with success rate, revenue, COD and change vs the previous period. */
create or replace function public.analytics_vendors(p_city uuid, p_from date, p_to date, p_limit int default 25) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid[] := public._report_cities(p_city); len int := p_to - p_from + 1;
begin
  perform public._need(p_to >= p_from and len <= 366, 'Choose a period of up to a year');
  return (select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.orders desc), '[]') from (
    select v.id, v.business_name name, v.crm_stage stage, cur.orders, cur.delivered,
           round(100.0 * cur.delivered / nullif(cur.done, 0), 1) success_pct, cur.revenue, cur.cod, prev.orders prev_orders,
           case when prev.orders > 0 then round(100.0 * (cur.orders - prev.orders) / prev.orders) end change_pct
    from (select f.vendor_id, count(*) orders, count(*) filter (where f.outcome = 'delivered') delivered,
                 count(*) filter (where f.outcome in ('delivered', 'returned', 'lost')) done,
                 sum(public._order_revenue(o)) revenue, sum(o.cod_amount) filter (where f.outcome = 'delivered') cod
          from public.order_facts f join public.orders o on o.id = f.order_id
          where f.vendor_id is not null and f.day between p_from and p_to and f.city_id = any (c) group by f.vendor_id
          order by count(*) desc limit least(greatest(p_limit, 1), 200)) cur
    join public.vendors v on v.id = cur.vendor_id
    left join lateral (select count(*) orders from public.order_facts f2 where f2.vendor_id = cur.vendor_id and f2.day between p_from - len and p_from - 1) prev on true) x);
end $$;

/** Where demand is: drop-offs per ~550 m square (for the map) and per zone. */
create or replace function public.analytics_heatmap(p_city uuid, p_from date, p_to date, p_service text default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid[] := public._report_cities(p_city);
begin
  perform public._need(p_to >= p_from and p_to - p_from <= 366, 'Choose a period of up to a year');
  return jsonb_build_object(
    'cells', (select coalesce(jsonb_agg(jsonb_build_object('lat', lat, 'lng', lng, 'n', n) order by n desc), '[]') from (
              select round((floor(drop_lat / 0.005) * 0.005 + 0.0025)::numeric, 4) lat, round((floor(drop_lng / 0.005) * 0.005 + 0.0025)::numeric, 4) lng, count(*) n
              from public.order_facts where day between p_from and p_to and city_id = any (c) and drop_lat is not null and (p_service is null or service_type = p_service)
              group by 1, 2 order by 3 desc limit 2000) x),
    'zones', (select coalesce(jsonb_agg(jsonb_build_object('zone_id', z.id, 'zone', z.name, 'city', ci.name, 'orders', x.n, 'delivered', x.d,
                       'success_pct', round(100.0 * x.d / nullif(x.done, 0), 1)) order by x.n desc), '[]')
              from (select zone_id, count(*) n, count(*) filter (where outcome = 'delivered') d, count(*) filter (where outcome in ('delivered', 'returned', 'lost')) done
                    from public.order_facts where day between p_from and p_to and city_id = any (c) and (p_service is null or service_type = p_service) group by zone_id) x
              join public.zones z on z.id = x.zone_id join public.cities ci on ci.id = z.city_id));
end $$;

-- ---------- 4. vendor analytics (client portal) ----------
/** A business's own numbers. Money (spend, COD) only for the owner and staff with the wallet permission. */
create or replace function public.vendor_analytics(p_vendor uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare money boolean; len int := p_to - p_from + 1;
        t0 timestamptz := p_from::timestamp at time zone 'Africa/Accra'; t1 timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Accra';
        k jsonb; pk jsonb;
begin
  perform public._need(p_vendor in (select public.my_vendor_ids()), 'Not your business');
  perform public._need(p_to >= p_from and len <= 366, 'Choose a period of up to a year');
  money := p_vendor in (select public.my_vendor_ids('wallet'));
  select jsonb_build_object(
    'orders', count(*), 'delivered', count(*) filter (where f.outcome = 'delivered'), 'returned', count(*) filter (where f.outcome = 'returned'),
    'cancelled', count(*) filter (where f.outcome = 'cancelled'), 'open', count(*) filter (where f.outcome = 'open'),
    'failed_attempts', coalesce(sum(f.failed_attempts), 0),
    'success_pct', round(100.0 * count(*) filter (where f.outcome = 'delivered') / nullif(count(*) filter (where f.outcome in ('delivered', 'returned', 'lost')), 0), 1),
    'on_time_pct', round(100.0 * count(*) filter (where f.on_time) / nullif(count(*) filter (where f.on_time is not null), 0), 1),
    'avg_delivery_hours', round((avg(extract(epoch from coalesce(f.delivered_at, f.ready_at) - f.booked_at)) filter (where f.delivered_at is not null or f.ready_at is not null) / 3600)::numeric, 1),
    'delivery_spend', case when money then coalesce(sum(public._order_revenue(o)), 0) end,
    'cod_collected', case when money then coalesce(sum(o.cod_amount) filter (where f.outcome = 'delivered'), 0) end)
  into k
  from public.order_facts f join public.orders o on o.id = f.order_id where f.vendor_id = p_vendor and f.day between p_from and p_to;
  select jsonb_build_object('orders', count(*), 'delivered', count(*) filter (where outcome = 'delivered'),
           'success_pct', round(100.0 * count(*) filter (where outcome = 'delivered') / nullif(count(*) filter (where outcome in ('delivered', 'returned', 'lost')), 0), 1))
    into pk from public.order_facts where vendor_id = p_vendor and day between p_from - len and p_from - 1;
  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'money', money, 'kpis', k, 'previous', pk,
    'other_fees', case when money then (
      select coalesce(jsonb_object_agg(kind, amt), '{}') from (
        select t.kind, -sum(e.amount) amt from public.ledger_entries e join public.ledger_transactions t on t.id = e.transaction_id
        where e.wallet_id = public.wallet_for('vendor', p_vendor) and t.kind in ('fulfilment_fee', 'storage_fee', 'cs_fee')
          and t.created_at >= t0 and t.created_at < t1 group by t.kind) y) end,
    'cod_paid_out', case when money then (select coalesce(sum(amount), 0) from public.cod_collections c join public.orders o on o.id = c.order_id
                                            where o.vendor_id = p_vendor and c.status = 'paid_out' and c.remitted_at >= t0 and c.remitted_at < t1) end,
    'cod_waiting', case when money then (select coalesce(sum(amount), 0) from public.cod_collections c join public.orders o on o.id = c.order_id
                                           where o.vendor_id = p_vendor and c.status in ('collected', 'remitted')) end,
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'orders', coalesce(x.n, 0), 'delivered', coalesce(x.dl, 0), 'not_delivered', coalesce(x.nd, 0)) order by d.day), '[]')
              from generate_series(p_from, p_to, interval '1 day') d(day)
              left join (select day, count(*) n, count(*) filter (where outcome = 'delivered') dl, count(*) filter (where outcome in ('returned', 'lost')) nd
                         from public.order_facts where vendor_id = p_vendor and day between p_from and p_to group by day) x on x.day = d.day::date),
    'by_service', (select coalesce(jsonb_agg(jsonb_build_object('service', service_type, 'orders', n, 'success_pct', s) order by n desc), '[]') from (
                    select service_type, count(*) n, round(100.0 * count(*) filter (where outcome = 'delivered') / nullif(count(*) filter (where outcome in ('delivered', 'returned', 'lost')), 0), 1) s
                    from public.order_facts where vendor_id = p_vendor and day between p_from and p_to group by 1) y),
    'failed_reasons', (select coalesce(jsonb_agg(jsonb_build_object('reason', r, 'count', n) order by n desc), '[]') from (
                        select coalesce(nullif(e.reason, ''), 'not given') r, count(*) n from public.order_events e join public.orders o on o.id = e.order_id
                        where o.vendor_id = p_vendor and e.to_status = 'FAILED_ATTEMPT' and e.created_at >= t0 and e.created_at < t1 group by 1) y),
    'top_areas', (select coalesce(jsonb_agg(jsonb_build_object('area', coalesce(z.name, 'Other'), 'city', ci.name, 'orders', y.n, 'success_pct', y.s) order by y.n desc), '[]') from (
                   select zone_id, count(*) n, round(100.0 * count(*) filter (where outcome = 'delivered') / nullif(count(*) filter (where outcome in ('delivered', 'returned', 'lost')), 0), 1) s
                   from public.order_facts where vendor_id = p_vendor and day between p_from and p_to group by zone_id order by 2 desc limit 10) y
                   left join public.zones z on z.id = y.zone_id left join public.cities ci on ci.id = z.city_id));
end $$;

-- ---------- 5. scheduled email reports ----------
create table public.report_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  frequency    text not null check (frequency in ('daily', 'weekly', 'monthly')),
  city_id      uuid references public.cities(id),     -- null = all the cities this person may see
  is_active    boolean not null default true,
  last_sent_at timestamptz,
  last_period_to date,                               -- last day covered by the last report sent (never the same period twice)
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create unique index report_subscriptions_uniq on public.report_subscriptions (user_id, frequency, coalesce(city_id, '00000000-0000-0000-0000-000000000000'));
alter table public.report_subscriptions enable row level security;
create policy report_subs_read on public.report_subscriptions for select to authenticated
  using (user_id = (select auth.uid()) or public.has_role(array['super_admin']::public.app_role[]));

/** Turn an email report on/off. Anyone with report access for themselves; a Super Admin also for other staff. */
create or replace function public.save_report_subscription(p_frequency text, p_city uuid, p_active boolean, p_user uuid default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid := coalesce(p_user, auth.uid());
begin
  perform public._need(p_frequency in ('daily', 'weekly', 'monthly'), 'Choose daily, weekly or monthly');
  perform public._need(u = auth.uid() or public.has_role(array['super_admin']::public.app_role[]), 'Only a Super Admin can set reports for someone else');
  perform public._need(exists (select 1 from public.user_roles where user_id = u and role in ('super_admin', 'city_admin', 'finance', 'analyst', 'hub_manager')
                               and (p_city is null or city_id is null or city_id = p_city)), 'That person can''t see reports for this city');
  perform public._need(exists (select 1 from public.profiles where id = u and email is not null), 'Add an email address to the account first');
  insert into public.report_subscriptions (user_id, frequency, city_id, is_active, created_by) values (u, p_frequency, p_city, p_active, auth.uid())
  on conflict (user_id, frequency, coalesce(city_id, '00000000-0000-0000-0000-000000000000')) do update set is_active = excluded.is_active;
end $$;

/** The report as plain text (email body). */
create or replace function public._report_text(p_user uuid, p_city uuid, p_from date, p_to date) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid[]; k jsonb; pv jsonb; r record; t text; ghs text;
begin
  select case when bool_or(city_id is null) then case when p_city is null then array(select id from public.cities) else array[p_city] end
              else case when p_city is null then array_agg(city_id) else array[p_city] end end into c
    from public.user_roles where user_id = p_user and role in ('super_admin', 'city_admin', 'finance', 'analyst', 'hub_manager');
  if c is null then return null; end if;
  k := public._kpis(c, p_from, p_to, null);
  pv := public._kpis(c, p_from - (p_to - p_from + 1), p_from - 1, null);
  t := format(E'Orders: %s%s\nDelivered: %s · Returned: %s · Cancelled: %s · Still open: %s\nSuccess rate: %s%% · On time: %s%%\nRevenue: GHS %s\nAverage Express pickup: %s min · Average delivery: %s min\nFailed attempts: %s',
         k ->> 'orders', case when (pv ->> 'orders')::int > 0 then format(' (%s%s%% vs previous period)', case when (k ->> 'orders')::int >= (pv ->> 'orders')::int then '+' else '' end,
                                                                     round(100.0 * ((k ->> 'orders')::int - (pv ->> 'orders')::int) / (pv ->> 'orders')::int)) else '' end,
         k ->> 'delivered', k ->> 'returned', k ->> 'cancelled', k ->> 'open', coalesce(k ->> 'success_pct', '—'), coalesce(k ->> 'on_time_pct', '—'),
         to_char((k ->> 'revenue')::numeric / 100, 'FM999,999,990.00'), coalesce(k ->> 'avg_pickup_min', '—'), coalesce(k ->> 'avg_delivery_min', '—'), k ->> 'failed_attempts');
  if array_length(c, 1) > 1 then
    t := t || E'\n\nBy city:';
    for r in select ci.name, public._kpis(array[ci.id], p_from, p_to, null) x from public.cities ci where ci.id = any (c) order by ci.name loop
      t := t || format(E'\n  %s: %s orders, %s delivered, success %s%%, on time %s%%', r.name, r.x ->> 'orders', r.x ->> 'delivered', coalesce(r.x ->> 'success_pct', '—'), coalesce(r.x ->> 'on_time_pct', '—'));
    end loop;
  end if;
  t := t || E'\n\nTop failure reasons:';
  for r in select coalesce(nullif(e.reason, ''), 'not given') reason, count(*) n from public.order_events e join public.order_facts f on f.order_id = e.order_id
            where e.to_status = 'FAILED_ATTEMPT' and e.created_at >= (p_from::timestamp at time zone 'Africa/Accra') and e.created_at < ((p_to + 1)::timestamp at time zone 'Africa/Accra')
              and f.city_id = any (c) group by 1 order by 2 desc limit 5 loop
    t := t || format(E'\n  %s: %s', replace(r.reason, '_', ' '), r.n);
  end loop;
  t := t || E'\n\nTop vendors:';
  for r in select v.business_name, count(*) n from public.order_facts f join public.vendors v on v.id = f.vendor_id
            where f.day between p_from and p_to and f.city_id = any (c) group by v.business_name order by 2 desc limit 5 loop
    t := t || format(E'\n  %s: %s orders', r.business_name, r.n);
  end loop;
  k := public._cod_outstanding(c);
  t := t || format(E'\n\nCOD now: GHS %s with riders (GHS %s overdue, %s riders) · GHS %s held by QCS for vendor payouts',
         to_char((k ->> 'with_riders')::numeric / 100, 'FM999,999,990.00'), to_char((k ->> 'with_riders_overdue')::numeric / 100, 'FM999,999,990.00'),
         k ->> 'riders_overdue', to_char((k ->> 'held_by_qcs')::numeric / 100, 'FM999,999,990.00'));
  return t;
end $$;

/**
 * Every morning (06:15 Accra): daily reports cover yesterday; weekly ones go on Mondays (last Monday–Sunday);
 * monthly ones on the 1st (last month). Sent by email through the normal notification queue.
 */
create or replace function public.send_scheduled_reports(p_today date default (now() at time zone 'Africa/Accra')::date) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare s record; f date; t date; body text; n int := 0; label text; site text := rtrim(public._setting('ops_dashboard_url', '"https://ops.qcsghana.com"') #>> '{}', '/');
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  for s in select rs.*, ci.name city_name from public.report_subscriptions rs left join public.cities ci on ci.id = rs.city_id
            where rs.is_active
              and (rs.frequency = 'daily' or (rs.frequency = 'weekly' and extract(isodow from p_today) = 1) or (rs.frequency = 'monthly' and extract(day from p_today) = 1))
  loop
    if s.frequency = 'daily' then f := p_today - 1; t := p_today - 1; label := to_char(f, 'Dy DD Mon YYYY');
    elsif s.frequency = 'weekly' then f := p_today - 7; t := p_today - 1; label := to_char(f, 'DD Mon') || ' – ' || to_char(t, 'DD Mon YYYY');
    else f := (date_trunc('month', p_today) - interval '1 month')::date; t := p_today - 1; label := to_char(f, 'FMMonth YYYY'); end if;
    if s.last_period_to is not null and s.last_period_to >= t then continue; end if;
    body := public._report_text(s.user_id, s.city_id, f, t);
    if body is null then continue; end if;      -- lost report access: skip quietly
    perform public._enqueue(s.user_id, null, null, 'analytics_report', jsonb_build_object(
      'frequency', initcap(s.frequency), 'period', label, 'scope', coalesce(s.city_name, 'all your cities'), 'summary', body,
      'link', site || '/analytics?from=' || f || '&to=' || t || coalesce('&city=' || s.city_id, '')));
    update public.report_subscriptions set last_sent_at = now(), last_period_to = t where id = s.id;
    n := n + 1;
  end loop;
  return n;
end $$;

insert into public.app_settings (key, value, description) values
  ('ops_dashboard_url', '"https://ops.qcsghana.com"', 'Address of the operations dashboard (links in email reports)')
on conflict do nothing;
insert into public.notification_templates (key, channel, audience, subject, body, wa_template, essential, description) values
  ('analytics_report', 'email', 'staff', 'QCS {{frequency}} report — {{period}} ({{scope}})',
   'QCS {{frequency}} report — {{period}} ({{scope}})\n\n{{summary}}\n\nCharts and details: {{link}}\n\nYou get this because you turned on email reports in the Operations dashboard (Analytics → Email reports).',
   null, true, 'Scheduled analytics report (daily / weekly / monthly)')
on conflict do nothing;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('analytics-reports', '15 6 * * *', 'select public.send_scheduled_reports()');   -- 06:15 Accra (= UTC)
  end if;
end $$;

-- ---------- who may call what ----------
revoke execute on function public._refresh_order_fact(uuid), public.order_fact_on_event(), public.order_fact_on_order(), public.rider_shift_on_toggle(),
  public._kpis(uuid[], date, date, text), public._cod_outstanding(uuid[]), public._report_text(uuid, uuid, date, date), public.send_scheduled_reports(date)
  from public, anon, authenticated;
grant execute on function public.send_scheduled_reports(date) to service_role;
revoke execute on function public.analytics_overview(uuid, date, date, text), public.analytics_riders(uuid, date, date), public.analytics_vendors(uuid, date, date, int),
  public.analytics_heatmap(uuid, date, date, text), public.vendor_analytics(uuid, date, date), public.save_report_subscription(text, uuid, boolean, uuid),
  public._report_cities(uuid) from public, anon;
grant execute on function public.analytics_overview(uuid, date, date, text), public.analytics_riders(uuid, date, date), public.analytics_vendors(uuid, date, date, int),
  public.analytics_heatmap(uuid, date, date, text), public.vendor_analytics(uuid, date, date), public.save_report_subscription(text, uuid, boolean, uuid)
  to authenticated;
