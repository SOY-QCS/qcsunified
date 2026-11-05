-- Phase 13 · Faster reports (found by the load test: the Analytics overview took ~7 s on 30 days × 10,000 deliveries a day).
-- Why it was slow: every report joined the full orders table just to work out each order's fee, and the overview ran the
-- same summary 9 times (period, previous period, each city, each service).
-- Now the fee QCS earned ("revenue") and the COD amount live on the report row itself (kept up to date by triggers),
-- and the per-city / per-service figures come from one pass.

alter table public.order_facts add column if not exists revenue bigint not null default 0, add column if not exists cod_amount bigint not null default 0;
update public.order_facts f set revenue = public._order_revenue(o), cod_amount = coalesce(o.cod_amount, 0) from public.orders o where o.id = f.order_id;
create index if not exists order_facts_day_idx on public.order_facts (day) include (city_id, service_type, outcome);

-- keep them right: after every status change (event) and whenever a fee or COD amount changes without one
create or replace function public.order_fact_on_event() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._refresh_order_fact(new.order_id);
  update public.order_facts f set revenue = public._order_revenue(o), cod_amount = coalesce(o.cod_amount, 0)
    from public.orders o where o.id = new.order_id and f.order_id = o.id;
  return null;
end $$;

create or replace function public.order_fact_on_order() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.order_facts set rider_id = new.rider_id, zone_id = new.dropoff_zone_id,
         drop_lat = st_y(new.dropoff_location::geometry), drop_lng = st_x(new.dropoff_location::geometry),
         revenue = public._order_revenue(new), cod_amount = coalesce(new.cod_amount, 0), updated_at = now()
   where order_id = new.id;
  return null;
end $$;
drop trigger if exists orders_facts on public.orders;
create trigger orders_facts after update of rider_id, dropoff_location, dropoff_zone_id, status, quoted_fee, extra_fee, insurance_premium, failed_fee, cod_amount
  on public.orders for each row execute function public.order_fact_on_order();

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
    'revenue', coalesce(sum(f.revenue), 0),
    'avg_pickup_min', round(avg(extract(epoch from f.picked_up_at - f.booked_at) / 60) filter (where f.service_type = 'express' and f.picked_up_at is not null)),
    'avg_delivery_min', round(avg(extract(epoch from f.delivered_at - f.picked_up_at) / 60) filter (where f.service_type <> 'intercity' and f.delivered_at is not null and f.picked_up_at is not null)))
  from public.order_facts f
  where f.day between p_from and p_to and f.city_id = any (p_cities) and (p_service is null or f.service_type = p_service);
$$;

/** The same numbers as _kpis — in total, per city and per service — in ONE pass over the facts (the overview used to scan 7 times). */
create or replace function public._kpis_grouped(p_cities uuid[], p_from date, p_to date, p_service text)
returns table (by text, city_id uuid, service text, k jsonb)
language sql stable security definer set search_path = public, extensions as $$
  select case when grouping(f.city_id) = 0 then 'city' when grouping(f.service_type) = 0 then 'service' else 'total' end, f.city_id, f.service_type,
    jsonb_build_object(
    'orders', count(*),
    'delivered', count(*) filter (where f.outcome = 'delivered'),
    'returned', count(*) filter (where f.outcome = 'returned'),
    'cancelled', count(*) filter (where f.outcome = 'cancelled'),
    'lost', count(*) filter (where f.outcome = 'lost'),
    'open', count(*) filter (where f.outcome = 'open'),
    'failed_attempts', coalesce(sum(f.failed_attempts), 0),
    'success_pct', round(100.0 * count(*) filter (where f.outcome = 'delivered') / nullif(count(*) filter (where f.outcome in ('delivered', 'returned', 'lost')), 0), 1),
    'on_time_pct', round(100.0 * count(*) filter (where f.on_time) / nullif(count(*) filter (where f.on_time is not null), 0), 1),
    'revenue', coalesce(sum(f.revenue), 0),
    'avg_pickup_min', round(avg(extract(epoch from f.picked_up_at - f.booked_at) / 60) filter (where f.service_type = 'express' and f.picked_up_at is not null)),
    'avg_delivery_min', round(avg(extract(epoch from f.delivered_at - f.picked_up_at) / 60) filter (where f.service_type <> 'intercity' and f.delivered_at is not null and f.picked_up_at is not null)))
  from public.order_facts f
  where f.day between p_from and p_to and f.city_id = any (p_cities) and (p_service is null or f.service_type = p_service)
  group by grouping sets ((), (f.city_id), (f.service_type));
$$;

create or replace function public.analytics_overview(p_city uuid, p_from date, p_to date, p_service text default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid[] := public._report_cities(p_city); len int := p_to - p_from + 1; g jsonb;
begin
  perform public._need(p_to >= p_from and len <= 366, 'Choose a period of up to a year');
  g := (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public._kpis_grouped(c, p_from, p_to, p_service) x);
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'kpis', coalesce((select e -> 'k' from jsonb_array_elements(g) e where e ->> 'by' = 'total'), public._kpis(array[]::uuid[], p_from, p_to, p_service)),
    'previous', public._kpis(c, p_from - len, p_from - 1, p_service),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'express', coalesce(x.express, 0), 'ecommerce', coalesce(x.ecommerce, 0),
                'intercity', coalesce(x.intercity, 0), 'delivered', coalesce(x.delivered, 0), 'revenue', coalesce(x.revenue, 0)) order by d.day), '[]')
              from generate_series(p_from, p_to, interval '1 day') d(day)
              left join (select f.day, count(*) filter (where f.service_type = 'express') express, count(*) filter (where f.service_type in ('ecommerce', 'scheduled')) ecommerce,
                                count(*) filter (where f.service_type = 'intercity') intercity, count(*) filter (where f.outcome = 'delivered') delivered,
                                sum(f.revenue) revenue
                         from public.order_facts f
                         where f.day between p_from and p_to and f.city_id = any (c) and (p_service is null or f.service_type = p_service) group by f.day) x on x.day = d.day::date),
    'by_city', (select coalesce(jsonb_agg(jsonb_build_object('city', ci.name, 'city_id', ci.id) || coalesce(g.k, public._kpis(array[]::uuid[], p_from, p_to, p_service)) order by ci.name), '[]')
                from public.cities ci left join lateral (select e -> 'k' k from jsonb_array_elements(g) e where e ->> 'by' = 'city' and (e ->> 'city_id')::uuid = ci.id) g on true where ci.id = any (c)),
    'by_service', (select coalesce(jsonb_agg(jsonb_build_object('service', s) || coalesce(g.k, public._kpis(array[]::uuid[], p_from, p_to, s)) order by array_position(array['express', 'ecommerce', 'intercity'], s)), '[]')
                   from unnest(array['express', 'ecommerce', 'intercity']) s left join lateral (select e -> 'k' k from jsonb_array_elements(g) e where e ->> 'by' = 'service' and e ->> 'service' = s) g on true
                   where p_service is null or s = p_service),
    'failed_reasons', (select coalesce(jsonb_agg(jsonb_build_object('reason', r, 'count', n) order by n desc), '[]')
                       from (select coalesce(nullif(e.reason, ''), 'not given') r, count(*) n
                             from public.order_events e join public.order_facts f on f.order_id = e.order_id
                             where e.to_status = 'FAILED_ATTEMPT' and e.created_at >= (p_from::timestamp at time zone 'Africa/Accra')
                               and e.created_at < ((p_to + 1)::timestamp at time zone 'Africa/Accra') and f.city_id = any (c)
                               and (p_service is null or f.service_type = p_service) group by 1) x),
    'cod', public._cod_outstanding(c));
end $$;

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
                 sum(f.revenue) revenue, sum(f.cod_amount) filter (where f.outcome = 'delivered') cod
          from public.order_facts f
          where f.vendor_id is not null and f.day between p_from and p_to and f.city_id = any (c) group by f.vendor_id
          order by count(*) desc limit least(greatest(p_limit, 1), 200)) cur
    join public.vendors v on v.id = cur.vendor_id
    left join lateral (select count(*) orders from public.order_facts f2 where f2.vendor_id = cur.vendor_id and f2.day between p_from - len and p_from - 1) prev on true) x);
end $$;

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
    'delivery_spend', case when money then coalesce(sum(f.revenue), 0) end,
    'cod_collected', case when money then coalesce(sum(f.cod_amount) filter (where f.outcome = 'delivered'), 0) end)
  into k
  from public.order_facts f where f.vendor_id = p_vendor and f.day between p_from and p_to;
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

revoke execute on function public._kpis_grouped(uuid[], date, date, text) from public, anon, authenticated;
