-- =====================================================================
-- Phase 7 — Operations dashboard
--   1. Live map data (riders + active orders), colour states decided here
--   2. Exception queue (unassigned too long, late, failed, unconfirmed address, COD over limit, rider no signal)
--   3. Trip tools: reassign (also mid-trip, with reason), split, merge, send back to dispatch
--   4. Rider management: status changes, document review, performance + earnings estimate
--   5. Vendor controls (money controls = Finance only)
--   6. Zone / city / hub editors
--   7. Tighter rules on who may change money controls and rider status
-- City admins only ever see/change their own city: every function checks the city of the thing it touches.
-- =====================================================================

insert into public.app_settings (key, value, description) values
  ('exception_unassigned_minutes', '10',  'Exception queue: a job with no rider after this many minutes'),
  ('late_express_minutes',         '90',  'Exception queue: Express not delivered this long after booking'),
  ('late_intercity_hours',         '72',  'Exception queue: inter-city parcel not delivered after this many hours'),
  ('late_ecommerce_time',          '"20:00"', 'Exception queue: e-commerce parcel not delivered by this time on its pickup day'),
  ('rider_no_signal_minutes',      '10',  'Exception queue: rider on a job has not sent a location for this long'),
  ('rider_pay',                    '{"fleet_pickup_fee": 500, "fleet_delivery_fee": 800, "default_commission_bp": 2000}',
                                   'Rider pay (pesewas): QCS fleet = pickup fee per trip + fee per delivered stop; independent = commission % (basis points) of delivery fees')
on conflict do nothing;

create or replace function public._num_setting(p_key text, p_city uuid, p_default numeric) returns numeric
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((public.get_setting(p_key, p_city) #>> '{}')::numeric, p_default);
$$;

create or replace function public._need(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception '%', p_msg; end if; end $$;

-- ---------- 1. live map ----------
create or replace function public.ops_live_map(p_city uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare silent int;
begin
  perform public._need(public.is_ops(p_city), 'Staff only');
  silent := public._num_setting('rider_no_signal_minutes', p_city, 10);
  return jsonb_build_object(
    'riders', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object(
        'id', r.id, 'name', p.full_name, 'phone', p.phone, 'city_id', r.city_id,
        'lat', st_y(r.last_location::geometry), 'lng', st_x(r.last_location::geometry), 'at', r.last_location_at,
        'vehicle', v.type, 'plate', v.plate_number, 'trip_id', t.id, 'cod_held', r.cod_float_balance,
        'state', case
          when t.id is not null and r.last_location_at < now() - make_interval(mins => silent) then 'no_signal'
          when t.id is not null then 'on_job'
          when r.is_online then 'idle'
          else 'offline' end) x
      from public.riders r
      join public.profiles p on p.id = r.id
      left join public.vehicles v on v.id = r.vehicle_id
      left join lateral (select id from public.trips where rider_id = r.id and status in ('ASSIGNED', 'IN_PROGRESS') limit 1) t on true
      where r.status = 'active' and r.last_location is not null and public.is_ops(r.city_id)
        and (p_city is null or r.city_id = p_city)
        and (r.is_online or t.id is not null or r.last_location_at > now() - interval '2 hours')
      limit 3000) s), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object(
        'id', o.id, 'tracking_number', o.tracking_number, 'status', o.status, 'service_type', o.service_type,
        'rider_id', o.rider_id, 'trip_id', o.trip_id, 'recipient_name', o.recipient_name,
        'pickup', jsonb_build_object('lat', st_y(o.pickup_location::geometry), 'lng', st_x(o.pickup_location::geometry)),
        'dropoff', jsonb_build_object('lat', st_y(o.dropoff_location::geometry), 'lng', st_x(o.dropoff_location::geometry)),
        -- where the parcel is now: at the pickup until collected, then heading to the drop-off
        'at', case when o.status in ('CONFIRMED','SEARCHING_RIDER','ASSIGNED','RIDER_AT_PICKUP') then 'pickup' else 'dropoff' end) x
      from public.orders o
      where o.status in ('CONFIRMED','SEARCHING_RIDER','ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','ARRIVED_AT_DROPOFF','FAILED_ATTEMPT')
        and public.is_ops(o.city_id) and (p_city is null or o.city_id = p_city)
      order by o.created_at desc limit 5000) s), '[]'::jsonb));
end $$;
grant execute on function public.ops_live_map(uuid) to authenticated;

-- ---------- 2. exception queue ----------
create or replace function public.ops_exceptions(p_city uuid default null) returns setof jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  un int := public._num_setting('exception_unassigned_minutes', p_city, 10);
  lx int := public._num_setting('late_express_minutes', p_city, 90);
  li int := public._num_setting('late_intercity_hours', p_city, 72);
  le time := coalesce(public.get_setting('late_ecommerce_time', p_city) #>> '{}', '20:00')::time;
  ns int := public._num_setting('rider_no_signal_minutes', p_city, 10);
begin
  perform public._need(public.is_ops(p_city), 'Staff only');
  return query
  with o as (
    select o.*, coalesce((select min(e.created_at) from public.order_events e where e.order_id = o.id and e.to_status = 'CONFIRMED'), o.created_at) confirmed_at
    from public.orders o
    where o.status in ('CONFIRMED','SEARCHING_RIDER','ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','AT_HUB','DEPARTED_HUB','ARRIVED_DEST_HUB',
                       'OUT_FOR_DELIVERY','ARRIVED_AT_DROPOFF','FAILED_ATTEMPT')
      and public.is_ops(o.city_id) and (p_city is null or o.city_id = p_city)
  )
  -- no rider yet, too long
  select jsonb_build_object('kind', 'unassigned', 'order_id', o.id, 'trip_id', o.trip_id, 'tracking_number', o.tracking_number, 'service_type', o.service_type,
         'since', coalesce(t.ready_at, o.confirmed_at), 'detail', 'No rider after ' || round(extract(epoch from now() - coalesce(t.ready_at, o.confirmed_at)) / 60) || ' min')
  from o left join public.trips t on t.id = o.trip_id
  where o.rider_id is null and o.status in ('CONFIRMED','SEARCHING_RIDER') and o.service_type <> 'intercity'
    and coalesce(t.ready_at, o.confirmed_at) < now() - make_interval(mins => un)
  union all
  -- late against the promise for that service
  select jsonb_build_object('kind', 'late', 'order_id', o.id, 'trip_id', o.trip_id, 'rider_id', o.rider_id, 'tracking_number', o.tracking_number,
         'service_type', o.service_type, 'since', o.confirmed_at, 'detail', replace(lower(o.status::text), '_', ' ') || ', booked ' ||
         to_char(o.confirmed_at at time zone 'Africa/Accra', 'DD Mon HH24:MI'))
  from o
  where o.status <> 'FAILED_ATTEMPT' and (
       (o.service_type = 'express' and o.confirmed_at < now() - make_interval(mins => lx))
    or (o.service_type = 'intercity' and o.confirmed_at < now() - make_interval(hours => li))
    or (o.service_type = 'ecommerce' and o.pickup_date is not null and (o.pickup_date + le) at time zone 'Africa/Accra' < now()))
  union all
  select jsonb_build_object('kind', 'failed', 'order_id', o.id, 'trip_id', o.trip_id, 'rider_id', o.rider_id, 'tracking_number', o.tracking_number,
         'service_type', o.service_type, 'since', o.updated_at,
         'detail', coalesce((select e.reason from public.order_events e where e.order_id = o.id and e.to_status = 'FAILED_ATTEMPT' order by e.id desc limit 1), 'failed attempt'))
  from o where o.status = 'FAILED_ATTEMPT'
  union all
  select jsonb_build_object('kind', 'unconfirmed_address', 'order_id', o.id, 'trip_id', o.trip_id, 'tracking_number', o.tracking_number,
         'service_type', o.service_type, 'since', o.confirmed_at, 'detail', o.recipient_name || ' · ' || o.recipient_phone)
  from o where o.address_confirmation = 'unconfirmed'
     or (o.address_confirmation = 'pending' and o.service_type <> 'express' and o.status in ('CONFIRMED','SEARCHING_RIDER','ASSIGNED'))
  union all
  -- riders holding more cash than their limit, or blocked for not remitting
  select jsonb_build_object('kind', 'cod_over_limit', 'rider_id', r.id, 'since', r.updated_at,
         'detail', p.full_name || ' holds GHS ' || to_char(r.cod_float_balance / 100.0, 'FM999,990.00') ||
                   case when r.cod_float_limit is not null then ' (limit GHS ' || to_char(r.cod_float_limit / 100.0, 'FM999,990.00') || ')' else ' — remittance overdue' end)
  from public.riders r join public.profiles p on p.id = r.id
  where public.is_ops(r.city_id) and (p_city is null or r.city_id = p_city)
    and r.cod_float_balance > 0 and (r.cod_blocked or (r.cod_float_limit is not null and r.cod_float_balance > r.cod_float_limit))
  union all
  select jsonb_build_object('kind', 'no_signal', 'rider_id', r.id, 'trip_id', t.id, 'since', r.last_location_at,
         'detail', p.full_name || ' (' || coalesce(p.phone, '') || ') on a job, no location for ' || round(extract(epoch from now() - r.last_location_at) / 60) || ' min')
  from public.trips t join public.riders r on r.id = t.rider_id join public.profiles p on p.id = r.id
  where t.status in ('ASSIGNED', 'IN_PROGRESS') and public.is_ops(t.city_id) and (p_city is null or t.city_id = p_city)
    and coalesce(r.last_location_at, t.assigned_at) < now() - make_interval(mins => ns);
end $$;
grant execute on function public.ops_exceptions(uuid) to authenticated;

-- ---------- 3. trip tools ----------
create or replace function public._dispatcher(p_city uuid) returns void language plpgsql as $$
begin
  perform public._need(public.is_trusted() or public.has_role(array['super_admin','city_admin','dispatcher']::public.app_role[], p_city),
                       'Only dispatchers can change trips');
end $$;

-- Parcels already in the rider's hands?
create or replace function public._picked(p_trip uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.orders where trip_id = p_trip
                 and status not in ('CONFIRMED','SEARCHING_RIDER','ASSIGNED','RIDER_AT_PICKUP','CANCELLED'));
$$;

/** Give a trip to another rider. Before pickup: like a normal assignment. After pickup (e.g. bike broke down):
    the new rider collects the parcels from the old one; a reason is required and it is written to the audit log. */
create or replace function public.reassign_trip(p_trip uuid, p_rider uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare t public.trips; r public.riders; old uuid; pl jsonb;
begin
  select * into t from public.trips where id = p_trip for update;
  perform public._need(found, 'Trip not found');
  perform public._dispatcher(t.city_id);
  perform public._need(t.status in ('PLANNED', 'ASSIGNED', 'IN_PROGRESS'), 'This trip is finished');
  perform public._need(coalesce(length(trim(p_reason)), 0) >= 5, 'Give a short reason for the change');
  select * into r from public.riders where id = p_rider;
  perform public._need(r.status = 'active', 'That rider is not active');
  perform public._need(r.city_id = t.city_id, 'That rider works in another city');
  perform public._need(not exists (select 1 from public.trips where rider_id = p_rider and status in ('ASSIGNED','IN_PROGRESS') and id <> p_trip),
                       'That rider already has an active job');
  perform public._need(t.rider_id is distinct from p_rider, 'That rider already has this trip');
  old := t.rider_id;
  perform set_config('qcs.audit_reason', 'reassigned: ' || trim(p_reason), true);
  if not public._picked(p_trip) then
    perform public._assign(p_trip, p_rider);
  else
    perform public._sys(1);
    update public.trips set rider_id = p_rider, assigned_at = now() where id = p_trip;
    update public.orders set rider_id = p_rider where trip_id = p_trip
       and status not in ('DELIVERED','COLLECTED','CANCELLED','RETURNED','LOST','DAMAGED');
    perform public._sys(-1);
  end if;
  pl := jsonb_build_object('reason', trim(p_reason), 'trip_id', p_trip);
  perform public._enqueue(p_rider, null, null, 'job_assigned', pl);
  if old is not null then perform public._enqueue(old, null, null, 'job_reassigned', pl); end if;
end $$;

/** Take the rider off a trip that hasn't been picked up, and offer it again. */
create or replace function public.unassign_trip(p_trip uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare t public.trips; o record;
begin
  select * into t from public.trips where id = p_trip for update;
  perform public._need(found, 'Trip not found');
  perform public._dispatcher(t.city_id);
  perform public._need(t.rider_id is not null, 'This trip has no rider');
  perform public._need(coalesce(length(trim(p_reason)), 0) >= 5, 'Give a short reason');
  perform public._need(not exists (select 1 from public.orders where trip_id = p_trip and status not in ('ASSIGNED','CANCELLED','CONFIRMED','SEARCHING_RIDER')),
                       'The rider is already at the pickup or has the parcels — reassign instead');
  perform set_config('qcs.audit_reason', 'unassigned: ' || trim(p_reason), true);
  perform public._enqueue(t.rider_id, null, null, 'job_reassigned', jsonb_build_object('reason', trim(p_reason)));
  perform public._sys(1);
  update public.trips set rider_id = null, status = 'PLANNED', assigned_at = null, dispatch_state = 'idle' where id = p_trip;
  update public.orders set rider_id = null where trip_id = p_trip;
  for o in select id from public.orders where trip_id = p_trip and status = 'ASSIGNED' loop
    perform public.transition_order(o.id, 'SEARCHING_RIDER', null, null, 'Rider removed by dispatch: ' || trim(p_reason), null, null);
  end loop;
  perform public._sys(-1);
  perform public.start_dispatch(p_trip);
end $$;

/** Move some drop-offs (not yet collected) into a new trip, which then goes to dispatch on its own. */
create or replace function public.split_trip(p_trip uuid, p_orders uuid[]) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare t public.trips; nt uuid; n int; o record;
begin
  perform public.refresh_trip_summary(p_trip);
  select * into t from public.trips where id = p_trip for update;
  perform public._need(found, 'Trip not found');
  perform public._dispatcher(t.city_id);
  perform public._need(coalesce(array_length(p_orders, 1), 0) > 0, 'Choose the drop-offs to move');
  select count(*) into n from public.orders where id = any (p_orders) and trip_id = p_trip;
  perform public._need(n = array_length(p_orders, 1), 'Some of those parcels are not on this trip');
  perform public._need(not exists (select 1 from public.orders where id = any (p_orders) and status not in ('CONFIRMED','SEARCHING_RIDER','ASSIGNED')),
                       'Only parcels not yet collected can be moved (the rider has not reached the pickup)');
  perform public._need(exists (select 1 from public.orders where trip_id = p_trip and not (id = any (p_orders)) and status <> 'CANCELLED'),
                       'Leave at least one parcel on the original trip');
  insert into public.trips (trip_type, status, city_id, vendor_id, hub_id, created_by, pickup_location, ready_at)
  values (t.trip_type, 'PLANNED', t.city_id, t.vendor_id, t.hub_id, auth.uid(), t.pickup_location, now()) returning id into nt;
  perform set_config('qcs.audit_reason', 'split from trip ' || p_trip, true);
  perform public._sys(1);
  update public.orders set trip_id = nt, rider_id = null where id = any (p_orders);
  update public.order_stops set trip_id = nt where order_id = any (p_orders) and trip_id = p_trip;
  for o in select id from public.orders where id = any (p_orders) and status = 'ASSIGNED' loop
    perform public.transition_order(o.id, 'SEARCHING_RIDER', null, null, 'Moved to a separate trip by dispatch', null, null);
  end loop;
  perform public._sys(-1);
  perform public.refresh_trip_summary(p_trip);
  perform public.refresh_trip_summary(nt);
  perform public.start_dispatch(nt);
  return nt;
end $$;

/** Put the drop-offs of one trip into another (same pickup area, nothing collected yet, max 25 drop-offs). */
create or replace function public.merge_trips(p_into uuid, p_from uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a public.trips; b public.trips; n int; o record;
begin
  perform public._need(p_into <> p_from, 'Choose two different trips');
  perform public.refresh_trip_summary(p_into); perform public.refresh_trip_summary(p_from);
  select * into a from public.trips where id = p_into for update;
  select * into b from public.trips where id = p_from for update;
  perform public._need(a.id is not null and b.id is not null, 'Trip not found');
  perform public._dispatcher(a.city_id);
  perform public._need(a.city_id = b.city_id, 'Trips are in different cities');
  perform public._need(a.status in ('PLANNED','ASSIGNED') and b.status in ('PLANNED','ASSIGNED'), 'Only trips that have not started can be merged');
  perform public._need(not public._picked(p_into) and not public._picked(p_from), 'Only trips with nothing collected yet can be merged');
  perform public._need(st_dwithin(a.pickup_location, b.pickup_location, 300), 'The pickups are more than 300 m apart — one rider can''t collect both in one stop');
  select count(*) into n from public.orders where trip_id in (p_into, p_from) and status <> 'CANCELLED';
  perform public._need(n <= 25, format('Together that is %s drop-offs; the maximum is 25', n));
  perform set_config('qcs.audit_reason', 'merged trip ' || p_from || ' into ' || p_into, true);
  perform public._sys(1);
  update public.job_offers set status = 'cancelled' where trip_id in (p_into, p_from) and status = 'offered';
  if b.rider_id is not null and b.rider_id is distinct from a.rider_id then
    perform public._enqueue(b.rider_id, null, null, 'job_reassigned', jsonb_build_object('reason', 'Trip merged with another'));
  end if;
  update public.orders set trip_id = p_into, rider_id = a.rider_id where trip_id = p_from;
  update public.order_stops set trip_id = p_into where trip_id = p_from;
  update public.trips set status = 'CANCELLED', rider_id = null, dispatch_state = 'idle' where id = p_from;
  if a.rider_id is not null then
    for o in select id from public.orders where trip_id = p_into and status in ('CONFIRMED','SEARCHING_RIDER') loop
      perform public.transition_order(o.id, 'ASSIGNED', null, null, 'Added to the rider''s trip by dispatch', null, null);
    end loop;
  else
    for o in select id from public.orders where trip_id = p_into and status = 'ASSIGNED' loop
      perform public.transition_order(o.id, 'SEARCHING_RIDER', null, null, 'Trips merged by dispatch', null, null);
    end loop;
  end if;
  perform public._sys(-1);
  perform public.refresh_trip_summary(p_into);
end $$;
/** Turn loose e-commerce parcels (no trip yet — e.g. single-drop bookings) into one trip and send it to riders.
    All parcels must share a pickup point (within 300 m) and city; max 25. */
create or replace function public.plan_trip(p_orders uuid[]) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c uuid; n int; nt uuid; first public.orders;
begin
  perform public._need(coalesce(array_length(p_orders, 1), 0) between 1 and 25, 'Choose 1 to 25 parcels');
  select * into first from public.orders where id = p_orders[1];
  perform public._need(found, 'Order not found');
  c := first.city_id;
  perform public._dispatcher(c);
  select count(*) into n from public.orders o where o.id = any (p_orders) and o.city_id = c and o.trip_id is null
     and o.status = 'CONFIRMED' and o.service_type = 'ecommerce' and st_dwithin(o.pickup_location, first.pickup_location, 300);
  perform public._need(n = array_length(p_orders, 1), 'Only confirmed e-commerce parcels without a trip, from the same pickup (within 300 m), can be planned together');
  insert into public.trips (trip_type, status, city_id, vendor_id, created_by, pickup_location, ready_at)
  values ('bulk', 'PLANNED', c, first.vendor_id, auth.uid(), first.pickup_location, now()) returning id into nt;
  perform public._sys(1);
  update public.orders set trip_id = nt where id = any (p_orders);
  perform public._sys(-1);
  insert into public.order_stops (trip_id, order_id, kind, location, suggested_seq)
  select nt, o.id, 'pickup'::public.stop_kind, o.pickup_location, 0 from public.orders o where o.id = any (p_orders)
  union all
  select nt, o.id, 'dropoff'::public.stop_kind, o.dropoff_location, (row_number() over (order by o.created_at))::int from public.orders o where o.id = any (p_orders);
  perform public.start_dispatch(nt);
  return nt;
end $$;

grant execute on function public.reassign_trip(uuid, uuid, text), public.unassign_trip(uuid, text), public.plan_trip(uuid[]),
  public.split_trip(uuid, uuid[]), public.merge_trips(uuid, uuid) to authenticated;

insert into public.notification_templates (key, channel, audience, subject, body, essential, description) values
  ('job_assigned',   'push', 'rider', 'New job from dispatch', 'Dispatch gave you a job. Open the app to see it.', true, 'Dispatcher assigned a job'),
  ('job_reassigned', 'push', 'rider', 'Job changed', 'Dispatch moved a job off your list: {{reason}}', true, 'Dispatcher took a job away')
on conflict do nothing;

-- ---------- 4. riders ----------
/** Suspend / reactivate / offboard a rider. City or Super Admin only; reason required; audit log. */
create or replace function public.set_rider_status(p_rider uuid, p_status public.rider_status, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r public.riders;
begin
  select * into r from public.riders where id = p_rider for update;
  perform public._need(found, 'Rider not found');
  perform public._need(public.is_trusted() or public.is_admin(r.city_id), 'Only a City or Super Admin can change a rider''s status');
  perform public._need(p_status in ('active', 'suspended', 'offboarded'), 'Use the applications page to approve new riders');
  perform public._need(coalesce(length(trim(p_reason)), 0) >= 5, 'Give a short reason');
  perform public._need(p_status = 'active' or not exists (select 1 from public.trips where rider_id = p_rider and status in ('ASSIGNED','IN_PROGRESS')),
                       'The rider has a job in progress — reassign it first');
  perform set_config('qcs.audit_reason', trim(p_reason), true);
  perform public._sys(1);
  update public.riders set status = p_status, is_online = case when p_status = 'active' then is_online else false end where id = p_rider;
  perform public._sys(-1);
end $$;

create or replace function public.review_rider_document(p_doc uuid, p_approve boolean, p_expires_on date default null, p_note text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare d public.rider_documents; c uuid;
begin
  select * into d from public.rider_documents where id = p_doc for update;
  perform public._need(found, 'Document not found');
  select city_id into c from public.riders where id = d.rider_id;
  perform public._need(public.is_trusted() or public.is_admin(c), 'Only a City or Super Admin can review documents');
  perform public._need(p_approve or coalesce(length(trim(p_note)), 0) >= 3, 'Say why the document is refused');
  update public.rider_documents set status = case when p_approve then 'approved' else 'rejected' end::public.review_status,
         expires_on = coalesce(p_expires_on, expires_on), reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(trim(p_note), '')
   where id = p_doc;
end $$;

/** Performance and an earnings ESTIMATE for a date range (actual pay runs come with rider payouts). */
create or replace function public.rider_stats(p_rider uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare r public.riders; pay jsonb; f timestamptz; t timestamptz; delivered int; failed int; trips int; fees bigint; ontime int; res jsonb;
begin
  select * into r from public.riders where id = p_rider;
  perform public._need(found and (public.is_ops(r.city_id) or p_rider = auth.uid()), 'Not allowed');
  f := (p_from::timestamp) at time zone 'Africa/Accra'; t := ((p_to + 1)::timestamp) at time zone 'Africa/Accra';
  pay := coalesce(public.get_setting('rider_pay', r.city_id), '{}');
  select count(*) filter (where o.status in ('DELIVERED','COLLECTED')),
         count(*) filter (where exists (select 1 from public.order_events e where e.order_id = o.id and e.to_status = 'FAILED_ATTEMPT' and e.actor_id = p_rider)),
         coalesce(sum(o.quoted_fee + o.extra_fee) filter (where o.status in ('DELIVERED','COLLECTED')), 0),
         count(*) filter (where o.status in ('DELIVERED','COLLECTED') and o.service_type = 'express'
                          and o.delivered_at <= o.created_at + make_interval(mins => public._num_setting('late_express_minutes', r.city_id, 90)::int))
    into delivered, failed, fees, ontime
  from public.orders o where o.rider_id = p_rider and o.updated_at >= f and coalesce(o.delivered_at, o.updated_at) < t;
  select count(*) into trips from public.trips where rider_id = p_rider and started_at >= f and started_at < t;
  res := jsonb_build_object(
    'rating', r.rating, 'score', r.score, 'offers_received', r.offers_received, 'offers_accepted', r.offers_accepted,
    'acceptance_rate', case when r.offers_received > 0 then round(100.0 * r.offers_accepted / r.offers_received) end,
    'delivered', delivered, 'failed', failed, 'trips', trips, 'delivery_fees', fees,
    'express_on_time', ontime, 'cod_held', r.cod_float_balance, 'cod_limit', r.cod_float_limit,
    'ratings_count', (select count(*) from public.ratings where rider_id = p_rider and kind = 'client'),
    'earnings_estimate', case when r.rider_type = 'fleet'
      then trips * coalesce((pay ->> 'fleet_pickup_fee')::bigint, 0) + delivered * coalesce((pay ->> 'fleet_delivery_fee')::bigint, 0)
      else round(fees * coalesce(r.commission_rate_bp, (pay ->> 'default_commission_bp')::int, 0) / 10000.0)::bigint end,
    'pay_basis', case when r.rider_type = 'fleet' then 'fleet' else 'commission' end);
  return res;
end $$;
grant execute on function public.set_rider_status(uuid, public.rider_status, text), public.review_rider_document(uuid, boolean, date, text),
  public.rider_stats(uuid, date, date) to authenticated;

-- ---------- 5. vendors ----------
/** Change vendor controls. Money controls (booking block, COD hold, payout schedule) are Finance's; the rest City/Super Admin. */
create or replace function public.set_vendor_controls(p_vendor uuid, p jsonb, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v public.vendors; money boolean;
begin
  select * into v from public.vendors where id = p_vendor for update;
  perform public._need(found, 'Vendor not found');
  money := p ?| array['booking_blocked', 'cod_payout_on_hold', 'cod_payout_schedule'];
  perform public._need(not money or public.is_finance(), 'Only Finance can change booking blocks, COD holds or payout schedules');
  perform public._need(money or public.is_admin(v.city_id) or public.is_finance(), 'Only a City or Super Admin can change vendor settings');
  perform public._need(coalesce(length(trim(p_reason)), 0) >= 5, 'Give a short reason');
  perform set_config('qcs.audit_reason', trim(p_reason), true);
  perform public._sys(1);
  update public.vendors set
    booking_blocked = coalesce((p ->> 'booking_blocked')::boolean, booking_blocked),
    booking_block_reason = case when p ? 'booking_blocked' then case when (p ->> 'booking_blocked')::boolean then trim(p_reason) end else booking_block_reason end,
    cod_payout_on_hold = coalesce((p ->> 'cod_payout_on_hold')::boolean, cod_payout_on_hold),
    cod_payout_schedule = coalesce((p ->> 'cod_payout_schedule')::public.payout_schedule, cod_payout_schedule),
    pod_require_photo = coalesce((p ->> 'pod_require_photo')::boolean, pod_require_photo),
    pod_require_pickup_code = coalesce((p ->> 'pod_require_pickup_code')::boolean, pod_require_pickup_code),
    cs_service_enabled = coalesce((p ->> 'cs_service_enabled')::boolean, cs_service_enabled),
    fulfilment_enabled = coalesce((p ->> 'fulfilment_enabled')::boolean, fulfilment_enabled),
    account_manager_id = case when p ? 'account_manager_id' then nullif(p ->> 'account_manager_id', '')::uuid else account_manager_id end,
    city_id = coalesce((p ->> 'city_id')::uuid, city_id),
    updated_at = now()
  where id = p_vendor;
  perform public._sys(-1);
end $$;

create or replace function public.vendor_stats(p_vendor uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v public.vendors; wk int; avg4 numeric; res jsonb;
begin
  select * into v from public.vendors where id = p_vendor;
  perform public._need(found and public.is_ops(v.city_id), 'Staff only');
  select count(*) into wk from public.orders where vendor_id = p_vendor and created_at >= now() - interval '7 days' and status not in ('DRAFT','CANCELLED');
  select count(*) / 4.0 into avg4 from public.orders where vendor_id = p_vendor and created_at >= now() - interval '35 days'
     and created_at < now() - interval '7 days' and status not in ('DRAFT','CANCELLED');
  res := jsonb_build_object(
    'orders_7d', wk, 'weekly_avg_4w', round(avg4, 1),
    'churn_risk', avg4 > 0 and wk <= avg4 * 0.7,
    'delivered_30d', (select count(*) from public.orders where vendor_id = p_vendor and status in ('DELIVERED','COLLECTED') and delivered_at > now() - interval '30 days'),
    'failed_30d', (select count(*) from public.orders where vendor_id = p_vendor and status in ('FAILED_ATTEMPT','RETURNED','RETURNING_TO_SENDER') and updated_at > now() - interval '30 days'),
    'cod_collected_not_paid', coalesce((select sum(amount) from public.cod_collections c join public.orders o on o.id = c.order_id
                                        where o.vendor_id = p_vendor and c.status <> 'paid_out'), 0),
    'wallet_balance', (select balance from public.wallets where owner_type = 'vendor' and owner_id = p_vendor limit 1),
    'pickup_rating', (select round(avg(score), 1) from public.ratings where vendor_id = p_vendor and kind = 'rider'));
  return res;
end $$;
grant execute on function public.set_vendor_controls(uuid, jsonb, text), public.vendor_stats(uuid) to authenticated;

-- ---------- 6. zones, cities, hubs ----------
create or replace function public.zones_geojson(p_city uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', z.id, 'code', z.code, 'name', z.name, 'is_active', z.is_active,
           'geojson', st_asgeojson(z.area::geometry, 6)::jsonb,
           'area_km2', round((st_area(z.area) / 1e6)::numeric, 2)) order by z.name), '[]'::jsonb)
  from public.zones z where z.city_id = p_city and public.is_ops(p_city);
$$;

/** Create or update a zone from a drawn shape (GeoJSON Polygon/MultiPolygon). */
create or replace function public.save_zone(p_id uuid, p_city uuid, p_code text, p_name text, p_geojson jsonb, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare g geometry; id uuid := p_id; km2 numeric;
begin
  perform public._need(public.is_admin(p_city), 'Only a City or Super Admin can edit zones');
  perform public._need(p_code ~ '^[A-Z0-9-]{2,20}$', 'Code: 2–20 capital letters, numbers or dashes, e.g. ACC-OSU');
  perform public._need(length(trim(p_name)) >= 2, 'Give the zone a name');
  begin
    g := st_multi(st_setsrid(st_geomfromgeojson(p_geojson::text), 4326));
  exception when others then raise exception 'The shape could not be read — draw it again';
  end;
  perform public._need(geometrytype(g) = 'MULTIPOLYGON', 'Draw an area (at least 3 points)');
  if not st_isvalid(g) then g := st_multi(st_collectionextract(st_makevalid(g), 3)); end if;
  perform public._need(st_isvalid(g) and not st_isempty(g), 'The shape crosses itself — redraw it');
  km2 := st_area(g::geography) / 1e6;
  perform public._need(km2 between 0.05 and 5000, format('That area is %s km² — zones must be between 0.05 and 5,000 km²', round(km2, 2)));
  perform public._need(st_within(st_centroid(g), st_makeenvelope(-3.4, 4.5, 1.3, 11.3, 4326)), 'The zone must be in Ghana');
  if id is null then
    insert into public.zones (city_id, code, name, area, is_active) values (p_city, p_code, trim(p_name), g::geography, coalesce(p_active, true)) returning zones.id into id;
  else
    update public.zones set code = p_code, name = trim(p_name), area = g::geography, is_active = coalesce(p_active, true)
     where zones.id = p_id and city_id = p_city;
    perform public._need(found, 'Zone not found in this city');
  end if;
  return id;
exception when unique_violation then raise exception 'Another zone in this city already uses the code %', p_code;
end $$;
create trigger audit_zones after insert or update or delete on public.zones for each row execute function public.audit_row();

create or replace function public.save_city(p_id uuid, p_code text, p_name text, p_cutoff time, p_active boolean) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare id uuid := p_id;
begin
  perform public._need(public.has_role(array['super_admin']::public.app_role[]), 'Only a Super Admin can add or change cities');
  perform public._need(p_code ~ '^[A-Z]{3}$', 'City code: 3 capital letters, e.g. CPC');
  if id is null then
    insert into public.cities (code, name, same_day_cutoff, is_active) values (p_code, trim(p_name), coalesce(p_cutoff, '09:00'), coalesce(p_active, true)) returning cities.id into id;
  else
    update public.cities set code = p_code, name = trim(p_name), same_day_cutoff = coalesce(p_cutoff, same_day_cutoff), is_active = coalesce(p_active, is_active) where cities.id = p_id;
  end if;
  return id;
exception when unique_violation then raise exception 'Another city already uses the code %', p_code;
end $$;

create or replace function public.save_hub(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare id uuid := p_id; c uuid := (p ->> 'city_id')::uuid; lat float8 := (p ->> 'lat')::float8; lng float8 := (p ->> 'lng')::float8;
begin
  perform public._need(public.is_admin(c), 'Only a City or Super Admin can edit hubs');
  perform public._need(p ->> 'code' ~ '^[A-Z0-9-]{2,12}$', 'Hub code: 2–12 capital letters/numbers, e.g. ACC-HUB1');
  perform public._need(length(trim(coalesce(p ->> 'name', ''))) >= 2 and length(trim(coalesce(p ->> 'address', ''))) >= 3, 'Name and address are needed');
  perform public._need(lat between 4.5 and 11.3 and lng between -3.4 and 1.3, 'Put the hub on the map (in Ghana)');
  if id is null then
    insert into public.hubs (city_id, code, name, address, location, phone, opening_hours, capacity, is_active)
    values (c, p ->> 'code', trim(p ->> 'name'), trim(p ->> 'address'), st_setsrid(st_makepoint(lng, lat), 4326)::geography,
            nullif(p ->> 'phone', ''), coalesce(p -> 'opening_hours', '{}'), coalesce((p ->> 'capacity')::int, 0), coalesce((p ->> 'is_active')::boolean, true))
    returning hubs.id into id;
  else
    update public.hubs set city_id = c, code = p ->> 'code', name = trim(p ->> 'name'), address = trim(p ->> 'address'),
           location = st_setsrid(st_makepoint(lng, lat), 4326)::geography, phone = nullif(p ->> 'phone', ''),
           opening_hours = coalesce(p -> 'opening_hours', opening_hours), capacity = coalesce((p ->> 'capacity')::int, capacity),
           is_active = coalesce((p ->> 'is_active')::boolean, is_active)
     where hubs.id = p_id and public.is_admin(hubs.city_id);
    perform public._need(found, 'Hub not found');
  end if;
  return id;
exception when unique_violation then raise exception 'Another hub already uses the code %', p ->> 'code';
end $$;
create trigger audit_hubs after insert or update or delete on public.hubs for each row execute function public.audit_row();

create or replace function public.hubs_overview(p_city uuid default null) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', h.id, 'city_id', h.city_id, 'code', h.code, 'name', h.name, 'address', h.address, 'phone', h.phone,
    'lat', st_y(h.location::geometry), 'lng', st_x(h.location::geometry), 'opening_hours', h.opening_hours, 'capacity', h.capacity, 'is_active', h.is_active,
    'parcels_in', (select count(*) from public.orders o where (o.origin_hub_id = h.id and o.status = 'AT_HUB')
                                                       or (o.dest_hub_id = h.id and o.status in ('ARRIVED_DEST_HUB', 'READY_FOR_COLLECTION'))),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'role', ur.role)), '[]'::jsonb)
              from public.user_roles ur join public.profiles p on p.id = ur.user_id where ur.hub_id = h.id)) order by h.name), '[]'::jsonb)
  from public.hubs h where public.is_ops(h.city_id) and (p_city is null or h.city_id = p_city);
$$;
grant execute on function public.zones_geojson(uuid), public.save_zone(uuid, uuid, text, text, jsonb, boolean), public.save_city(uuid, text, text, time, boolean),
  public.save_hub(uuid, jsonb), public.hubs_overview(uuid) to authenticated;

-- ---------- 7. settings: city admins may set city-level overrides of operational knobs ----------
create or replace function public.save_setting(p_key text, p_city uuid, p_value jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare d text;
begin
  perform public._need(case when p_city is null then public.has_role(array['super_admin']::public.app_role[]) else public.is_admin(p_city) end,
                       'Only a Super Admin can change the default; City Admins can change their own city');
  select description into d from public.app_settings where key = p_key and city_id is null;
  perform public._need(found, 'Unknown setting');
  perform public._need(jsonb_typeof(p_value) = jsonb_typeof((select value from public.app_settings where key = p_key and city_id is null)),
                       'That value has the wrong type for this setting');
  perform public._sys(1);
  insert into public.app_settings (key, city_id, value, description, updated_by, updated_at) values (p_key, p_city, p_value, d, auth.uid(), now())
  on conflict (key, city_id) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  perform public._sys(-1);
end $$;
create or replace function public.clear_city_setting(p_key text, p_city uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._need(p_city is not null and public.is_admin(p_city), 'Not allowed');
  delete from public.app_settings where key = p_key and city_id = p_city;
end $$;
grant execute on function public.save_setting(text, uuid, jsonb), public.clear_city_setting(text, uuid) to authenticated;

-- ---------- 8. who may change money controls & rider status directly ----------
-- (Row Level Security lets most staff edit vendors/riders in their city; these rules narrow the sensitive columns.)
create or replace function public.protect_vendor_money() returns trigger language plpgsql as $$
begin
  if not public.is_trusted() and (new.booking_blocked, new.cod_payout_on_hold, new.cod_payout_schedule)
       is distinct from (old.booking_blocked, old.cod_payout_on_hold, old.cod_payout_schedule) and not public.is_finance() then
    raise exception 'Only Finance can change booking blocks, COD holds or payout schedules';
  end if;
  return new;
end $$;
create or replace function public.protect_rider_controls() returns trigger language plpgsql as $$
begin
  if public.is_trusted() then return new; end if;
  if new.status is distinct from old.status and not public.is_admin(old.city_id) then
    raise exception 'Only a City or Super Admin can change a rider''s status';
  end if;
  if (new.commission_rate_bp, new.cod_float_limit) is distinct from (old.commission_rate_bp, old.cod_float_limit)
     and not (public.is_admin(old.city_id) or public.is_finance()) then
    raise exception 'Only an Admin or Finance can change rider pay or cash limits';
  end if;
  return new;
end $$;
create trigger vendors_protect_money before update on public.vendors for each row execute function public.protect_vendor_money();
create trigger riders_protect_controls before update on public.riders for each row execute function public.protect_rider_controls();
