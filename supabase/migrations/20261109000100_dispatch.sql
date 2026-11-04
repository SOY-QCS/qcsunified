-- =====================================================================
-- QCS Unified — Phase 5: dispatch engine (CLAUDE.md §6)
--
--  1. An Express order that becomes CONFIRMED gets its own trip, queued for dispatch.
--     Bulk trips are sent to riders by a dispatcher (start_dispatch) or assigned by hand.
--  2. dispatch_tick() runs every few seconds: it expires 20-second offers and offers the
--     job to the next nearest eligible rider. Straight-line distance by PostGIS (free);
--     if the Google ranking function has run, its road-time order is used first.
--  3. After 5 rejections/timeouts (or nobody available for 2 minutes) the job is escalated
--     to the city's dispatchers.
--  4. A rider holds ONE active job at a time (unique index on trips) and gets ONE offer at a time.
-- =====================================================================

insert into public.app_settings (key, value, description) values
  ('reject_score_penalty', '2', 'Score points lost per rejected or missed offer'),
  ('dispatch_no_rider_escalate_s', '120', 'Escalate if no eligible rider is found for this many seconds'),
  ('dispatch_min_rating', '3.5', 'Riders below this rating get no automatic offers'),
  ('rider_location_fresh_s', '180', 'A rider''s location older than this is ignored for dispatch'),
  ('scheduled_dispatch_lead_min', '20', 'Scheduled Express: start looking for a rider this many minutes before pickup')
on conflict do nothing;

create type public.offer_status as enum ('offered', 'accepted', 'rejected', 'expired', 'cancelled');

alter table public.trips
  add column dispatch_state      text not null default 'idle' check (dispatch_state in ('idle', 'queued', 'offering', 'escalated', 'assigned')),
  add column dispatch_misses     integer not null default 0,         -- rejections + timeouts on this trip
  add column dispatch_ranking    uuid[],                             -- road-time order from Google (optional)
  add column dispatch_started_at timestamptz,
  add column ready_at            timestamptz,                        -- don't dispatch before this (scheduled pickups)
  add column escalated_at        timestamptz,
  add column escalation_reason   text,
  add column pickup_location     geography(Point, 4326),
  add column max_weight_g        integer not null default 0,
  add column cod_total           bigint not null default 0;
create index trips_dispatch_idx on public.trips (dispatch_state, ready_at) where dispatch_state in ('queued', 'offering');

alter table public.riders add column push_token text;

create table public.job_offers (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips(id) on delete cascade,
  rider_id    uuid not null references public.riders(id),
  status      public.offer_status not null default 'offered',
  distance_m  integer,
  offered_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  answered_at timestamptz
);
-- one live offer per trip and per rider
create unique index job_offers_one_live_per_trip on public.job_offers (trip_id) where status = 'offered';
create unique index job_offers_one_live_per_rider on public.job_offers (rider_id) where status = 'offered';
create index job_offers_expiry_idx on public.job_offers (expires_at) where status = 'offered';
create index job_offers_trip_idx on public.job_offers (trip_id, rider_id);
alter table public.job_offers enable row level security;
create policy offers_read on public.job_offers for select to authenticated using (
  rider_id = (select auth.uid())
  or exists (select 1 from public.trips t where t.id = job_offers.trip_id and public.is_ops(t.city_id))
);
-- Riders hear about offers instantly through Supabase Realtime.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.job_offers';
  end if;
end $$;

-- ---------- 1. Express orders get a trip when confirmed ----------
create or replace function public.express_trip_on_confirm() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare t uuid;
begin
  if new.status = 'CONFIRMED' and old.status is distinct from 'CONFIRMED' and new.service_type = 'express' and new.trip_id is null then
    insert into public.trips (trip_type, status, city_id, vendor_id, created_by, dispatch_state, ready_at, pickup_location, max_weight_g, cod_total)
    values ('express', 'PLANNED', new.city_id, new.vendor_id, new.customer_id, 'queued',
            case when new.scheduled_pickup_at is not null
                 then new.scheduled_pickup_at - make_interval(mins => public.setting_int('scheduled_dispatch_lead_min', 20)::int) end,
            new.pickup_location, new.weight_g, new.cod_amount)
    returning id into t;
    perform public._sys(1);
    update public.orders set trip_id = t where id = new.id;
    perform public._sys(-1);
    insert into public.order_stops (trip_id, order_id, kind, location, suggested_seq)
    values (t, new.id, 'pickup', new.pickup_location, 0), (t, new.id, 'dropoff', new.dropoff_location, 1);
  end if;
  return new;
end $$;
create trigger orders_express_trip after update of status on public.orders for each row execute function public.express_trip_on_confirm();

-- Keep a trip's summary (pickup, heaviest parcel, COD) up to date for eligibility checks.
create or replace function public.refresh_trip_summary(p_trip uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update public.trips t set
    pickup_location = coalesce(t.pickup_location, (select o.pickup_location from public.orders o where o.trip_id = t.id order by o.created_at limit 1)),
    max_weight_g = coalesce((select max(o.weight_g) from public.orders o where o.trip_id = t.id), 0),
    cod_total = coalesce((select sum(o.cod_amount) from public.orders o where o.trip_id = t.id and o.status not in ('CANCELLED')), 0)
  where t.id = p_trip;
$$;

-- ---------- 2. who can take this job? ----------
-- Eligible: active, online, same city, fresh location, no active job, no other live offer, not offered this trip before,
-- vehicle can carry the heaviest parcel (Express = bike/e-bike only), COD not blocked when the trip has COD,
-- rating above the minimum, and no expired approved documents.
create or replace function public.candidate_riders(p_trip uuid, p_limit int default 5)
returns table (rider_id uuid, distance_m integer)
language sql stable security definer set search_path = public, extensions as $$
  select r.id, round(st_distance(r.last_location, t.pickup_location))::int
  from public.trips t
  join public.riders r on r.city_id = t.city_id
  left join public.vehicles v on v.id = r.vehicle_id
  where t.id = p_trip
    and r.status = 'active' and r.is_online and r.last_location is not null
    and r.last_location_at > now() - make_interval(secs => public.setting_int('rider_location_fresh_s', 180)::int)
    and r.rating >= coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'dispatch_min_rating' and city_id is null), 0)
    and coalesce(v.max_weight_g, 15000) >= t.max_weight_g
    and (t.trip_type <> 'express' or coalesce(v.type, 'bike') in ('bike', 'ebike'))
    and (t.cod_total = 0 or (not r.cod_blocked and r.cod_float_balance + t.cod_total <= r.cod_float_limit))
    and not exists (select 1 from public.trips a where a.rider_id = r.id and a.status in ('ASSIGNED', 'IN_PROGRESS'))
    and not exists (select 1 from public.job_offers o where o.rider_id = r.id and o.status = 'offered')
    and not exists (select 1 from public.job_offers o where o.rider_id = r.id and o.trip_id = t.id)
    and not exists (select 1 from public.rider_documents d where d.rider_id = r.id and d.status = 'approved' and d.expires_on < current_date)
  order by r.last_location <-> t.pickup_location
  limit p_limit;
$$;
revoke execute on function public.candidate_riders(uuid, int) from public, anon, authenticated;
grant execute on function public.candidate_riders(uuid, int) to service_role;

-- ---------- escalate to a dispatcher ----------
create or replace function public._escalate(p_trip uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare t public.trips;
begin
  update public.trips set dispatch_state = 'escalated', escalated_at = now(), escalation_reason = p_reason where id = p_trip returning * into t;
  insert into public.notifications (user_id, channel, template, payload)
  select distinct ur.user_id, 'push'::public.notification_channel, 'dispatch_escalated', jsonb_build_object('trip_id', p_trip, 'reason', p_reason)
  from public.user_roles ur where ur.role in ('dispatcher', 'city_admin') and (ur.city_id = t.city_id or ur.city_id is null);
end $$;

-- ---------- offer the job to the next rider ----------
create or replace function public.offer_next(p_trip uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare t public.trips; pick uuid; dist int; offer uuid; secs int := public.setting_int('dispatch_accept_seconds', 20)::int;
begin
  select * into t from public.trips where id = p_trip for update skip locked;
  if not found or t.dispatch_state not in ('queued', 'offering') or t.rider_id is not null then return null; end if;
  if exists (select 1 from public.job_offers where trip_id = p_trip and status = 'offered') then return null; end if;

  if t.dispatch_misses >= public.setting_int('dispatch_max_rejections', 5) then
    perform public._escalate(p_trip, format('%s riders rejected or missed the offer', t.dispatch_misses));
    return null;
  end if;

  -- Google's road-time order first (if the ranking function ran), then nearest by straight line.
  select c.rider_id, c.distance_m into pick, dist
  from public.candidate_riders(p_trip, 25) c
  order by coalesce(array_position(t.dispatch_ranking, c.rider_id), 1000), c.distance_m
  limit 1;

  if pick is null then
    if coalesce(t.dispatch_started_at, now()) < now() - make_interval(secs => public.setting_int('dispatch_no_rider_escalate_s', 120)::int) then
      perform public._escalate(p_trip, 'No eligible rider online nearby');
    end if;
    return null;
  end if;

  insert into public.job_offers (trip_id, rider_id, distance_m, expires_at) values (p_trip, pick, dist, now() + make_interval(secs => secs))
  returning id into offer;
  update public.trips set dispatch_state = 'offering' where id = p_trip;
  perform public._sys(1);
  update public.riders set offers_received = offers_received + 1 where id = pick;
  perform public._sys(-1);
  insert into public.notifications (user_id, channel, template, payload)
  values (pick, 'push', 'job_offer', jsonb_build_object('offer_id', offer, 'trip_id', p_trip, 'expires_in', secs));
  return offer;
end $$;

-- ---------- start / restart looking for a rider ----------
create or replace function public.start_dispatch(p_trip uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare t public.trips; o record;
begin
  select * into t from public.trips where id = p_trip for update;
  if not found then raise exception 'Trip not found'; end if;
  if not (public.is_trusted() or public.has_role(array['super_admin','city_admin','dispatcher']::public.app_role[], t.city_id)) then
    raise exception 'Only dispatchers can send jobs to riders';
  end if;
  if t.rider_id is not null then raise exception 'This trip already has a rider'; end if;
  perform public.refresh_trip_summary(p_trip);
  update public.job_offers set status = 'cancelled' where trip_id = p_trip and status = 'offered';
  update public.trips set dispatch_state = 'queued', dispatch_started_at = now(), dispatch_misses = 0, escalated_at = null, escalation_reason = null,
                          ready_at = least(coalesce(ready_at, now()), now())
   where id = p_trip;
  for o in select id, status from public.orders where trip_id = p_trip and status = 'CONFIRMED' loop
    if t.trip_type = 'express' then perform public.transition_order(o.id, 'SEARCHING_RIDER', null, null, 'Looking for a rider', null, null); end if;
  end loop;
  return public.offer_next(p_trip);
end $$;

-- ---------- the clock: runs every few seconds ----------
create or replace function public.dispatch_tick() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare off record; t record; expired int := 0; offered int := 0; pen int := public.setting_int('reject_score_penalty', 2)::int;
begin
  -- 1. offers nobody answered in time count as a miss (and against the rider's score)
  for off in update public.job_offers set status = 'expired', answered_at = now()
             where status = 'offered' and expires_at < now() returning trip_id, rider_id loop
    update public.trips set dispatch_misses = dispatch_misses + 1 where id = off.trip_id;
    perform public._sys(1);
    update public.riders set score = score - pen where id = off.rider_id;
    perform public._sys(-1);
    expired := expired + 1;
  end loop;

  -- 2. new Express jobs: move their orders to SEARCHING_RIDER and start the clock
  for t in select id from public.trips where dispatch_state = 'queued' and dispatch_started_at is null and coalesce(ready_at, now()) <= now() loop
    perform public.start_dispatch(t.id);
  end loop;

  -- 3. every job still looking gets its next offer
  for t in select id from public.trips where dispatch_state in ('queued', 'offering') and rider_id is null and coalesce(ready_at, now()) <= now()
             and not exists (select 1 from public.job_offers o where o.trip_id = trips.id and o.status = 'offered') loop
    if public.offer_next(t.id) is not null then offered := offered + 1; end if;
  end loop;
  return jsonb_build_object('expired', expired, 'offered', offered);
end $$;

-- ---------- assigning a rider (accepted offer or dispatcher's choice) ----------
create or replace function public._assign(p_trip uuid, p_rider uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o record;
begin
  perform public._sys(1);
  update public.trips set rider_id = p_rider, status = 'ASSIGNED', assigned_at = now(), dispatch_state = 'assigned' where id = p_trip;
  update public.orders set rider_id = p_rider where trip_id = p_trip;
  for o in select id, status from public.orders where trip_id = p_trip and status in ('CONFIRMED', 'SEARCHING_RIDER') loop
    perform public.transition_order(o.id, 'ASSIGNED', null, null, 'Rider assigned', null, null);
  end loop;
  perform public._sys(-1);
  update public.job_offers set status = 'cancelled' where trip_id = p_trip and status = 'offered' and rider_id <> p_rider;
end $$;

-- The rider answers an offer.
create or replace function public.respond_offer(p_offer uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare off public.job_offers; pen int := public.setting_int('reject_score_penalty', 2)::int;
begin
  select * into off from public.job_offers where id = p_offer for update;
  if not found or off.rider_id <> auth.uid() then raise exception 'Offer not found'; end if;
  if off.status <> 'offered' then return off.status::text; end if;                       -- already answered/expired
  if off.expires_at + interval '2 seconds' < now() then                                  -- small allowance for slow networks
    update public.job_offers set status = 'expired', answered_at = now() where id = off.id;
    return 'expired';
  end if;

  if p_accept then
    if exists (select 1 from public.trips where rider_id = off.rider_id and status in ('ASSIGNED', 'IN_PROGRESS')) then
      raise exception 'Finish your current job first';
    end if;
    update public.job_offers set status = 'accepted', answered_at = now() where id = off.id;
    perform public._sys(1);
    update public.riders set offers_accepted = offers_accepted + 1 where id = off.rider_id;
    perform public._sys(-1);
    perform public._assign(off.trip_id, off.rider_id);
    return 'accepted';
  end if;

  update public.job_offers set status = 'rejected', answered_at = now() where id = off.id;
  update public.trips set dispatch_misses = dispatch_misses + 1 where id = off.trip_id;
  perform public._sys(1);
  update public.riders set score = score - pen where id = off.rider_id;
  perform public._sys(-1);
  perform public.offer_next(off.trip_id);                                                 -- straight to the next rider
  return 'rejected';
end $$;

-- A dispatcher assigns (or re-assigns) a trip by hand.
create or replace function public.assign_trip(p_trip uuid, p_rider uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare t public.trips; r public.riders; o record;
begin
  select * into t from public.trips where id = p_trip for update;
  if not found then raise exception 'Trip not found'; end if;
  if not (public.is_trusted() or public.has_role(array['super_admin','city_admin','dispatcher']::public.app_role[], t.city_id)) then
    raise exception 'Only dispatchers can assign trips';
  end if;
  select * into r from public.riders where id = p_rider;
  if r.status <> 'active' then raise exception 'That rider is not active'; end if;
  if r.city_id <> t.city_id then raise exception 'That rider works in another city'; end if;
  if exists (select 1 from public.trips where rider_id = p_rider and status in ('ASSIGNED', 'IN_PROGRESS') and id <> p_trip) then
    raise exception 'That rider already has an active job';
  end if;
  if t.rider_id is not null and t.rider_id <> p_rider then
    -- re-assign: only before pickup
    if exists (select 1 from public.orders where trip_id = p_trip and status not in ('CONFIRMED','SEARCHING_RIDER','ASSIGNED','RIDER_AT_PICKUP')) then
      raise exception 'Parcels are already picked up — hand-over between riders comes later';
    end if;
  end if;
  perform set_config('qcs.audit_reason', 'manual assignment', true);
  perform public._assign(p_trip, p_rider);
end $$;

-- ---------- trips follow their orders ----------
create or replace function public.trip_progress() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.trip_id is null or new.status = old.status then return new; end if;
  update public.order_stops set status = 'DONE', completed_at = now() where order_id = new.id and kind = 'pickup' and new.status = 'PICKED_UP';
  update public.order_stops set status = 'ARRIVED', arrived_at = now() where order_id = new.id and kind = 'dropoff' and new.status = 'ARRIVED_AT_DROPOFF';
  update public.order_stops set status = 'DONE', completed_at = now() where order_id = new.id and kind = 'dropoff' and new.status in ('DELIVERED', 'COLLECTED', 'AT_HUB');
  update public.order_stops set status = 'FAILED', completed_at = now() where order_id = new.id and kind = 'dropoff' and new.status = 'FAILED_ATTEMPT';
  update public.trips set status = 'IN_PROGRESS', started_at = now() where id = new.trip_id and status = 'ASSIGNED' and new.status = 'PICKED_UP';
  -- the rider's job is done when every parcel has reached an end point for this trip
  if not exists (select 1 from public.orders o where o.trip_id = new.trip_id
                 and o.status not in ('DELIVERED','COLLECTED','RETURNED','CANCELLED','LOST','DAMAGED','AT_HUB','RESCHEDULED')) then
    update public.trips set status = 'COMPLETED', completed_at = now() where id = new.trip_id and status in ('ASSIGNED', 'IN_PROGRESS');
    update public.trips set status = 'CANCELLED', dispatch_state = 'idle' where id = new.trip_id and status = 'PLANNED';
    update public.job_offers set status = 'cancelled' where trip_id = new.trip_id and status = 'offered';
  end if;
  return new;
end $$;
create trigger orders_trip_progress after update of status on public.orders for each row execute function public.trip_progress();

-- ---------- rider location ----------
-- Latest position always; trip pings kept as history; idle pings at most once a minute (CLAUDE.md §13).
create or replace function public.rider_ping(p_lng double precision, p_lat double precision, p_accuracy real default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); pt geography := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography; trip uuid; last timestamptz;
begin
  if me is null or not exists (select 1 from public.riders where id = me) then raise exception 'Riders only'; end if;
  if p_lat not between 4.5 and 11.3 or p_lng not between -3.4 and 1.3 then return; end if;   -- ignore GPS glitches outside Ghana
  select id into trip from public.trips where rider_id = me and status in ('ASSIGNED', 'IN_PROGRESS') limit 1;
  update public.riders set last_location = pt, last_location_at = now() where id = me;
  if trip is not null then
    insert into public.rider_location_pings (rider_id, trip_id, location, accuracy_m) values (me, trip, pt, p_accuracy);
  else
    select max(recorded_at) into last from public.rider_location_pings where rider_id = me and trip_id is null;
    if last is null or last < now() - interval '55 seconds' then
      insert into public.rider_location_pings (rider_id, trip_id, location, accuracy_m) values (me, null, pt, p_accuracy);
    end if;
  end if;
end $$;

-- The rider's current job with its stops (for the app; works with RLS too, this is just one round-trip).
create or replace function public.my_job() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'trip', to_jsonb(t) - 'dispatch_ranking',
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'tracking_number', o.tracking_number, 'status', o.status, 'service_type', o.service_type,
        'recipient_name', o.recipient_name, 'recipient_phone', o.recipient_phone,
        'pickup_address', o.pickup_address_text, 'pickup_contact', o.pickup_contact_name, 'pickup_phone', o.pickup_contact_phone, 'pickup_note', o.pickup_instructions,
        'pickup_lat', st_y(o.pickup_location::geometry), 'pickup_lng', st_x(o.pickup_location::geometry),
        'dropoff_address', o.dropoff_address_text, 'landmark', o.dropoff_landmark, 'gps', o.dropoff_ghana_post_gps, 'note', o.delivery_instructions,
        'dropoff_lat', st_y(o.dropoff_location::geometry), 'dropoff_lng', st_x(o.dropoff_location::geometry),
        'weight_g', o.weight_g, 'fragile', o.is_fragile, 'cod_amount', o.cod_amount, 'pod_photo_required', coalesce(v.pod_require_photo, false),
        'pickup_code_required', o.is_high_value or coalesce(v.pod_require_pickup_code, false),
        'otp_verified', o.pod_otp_verified_at is not null, 'signature', o.pod_signature_path is not null, 'photo', o.pod_photo_path is not null,
        'cod_collected', exists (select 1 from public.cod_collections c where c.order_id = o.id)
      ) order by o.created_at) from public.orders o left join public.vendors v on v.id = o.vendor_id where o.trip_id = t.id), '[]'::jsonb))
  from public.trips t where t.rider_id = auth.uid() and t.status in ('ASSIGNED', 'IN_PROGRESS') limit 1;
$$;

-- The live offer waiting for this rider (if any).
create or replace function public.my_offer() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('id', o.id, 'expires_at', o.expires_at, 'distance_m', o.distance_m, 'trip_type', t.trip_type,
    'stops', (select count(*) from public.orders x where x.trip_id = t.id), 'cod_total', t.cod_total,
    'pickup', (select x.pickup_address_text from public.orders x where x.trip_id = t.id limit 1),
    'dropoff', (select case when count(*) = 1 then max(x.dropoff_address_text) else count(*) || ' drop-offs' end from public.orders x where x.trip_id = t.id),
    'fee', (select sum(x.quoted_fee) from public.orders x where x.trip_id = t.id))
  from public.job_offers o join public.trips t on t.id = o.trip_id
  where o.rider_id = auth.uid() and o.status = 'offered' and o.expires_at > now() limit 1;
$$;

revoke execute on function public.offer_next(uuid), public.dispatch_tick(), public._escalate(uuid, text), public._assign(uuid, uuid), public.refresh_trip_summary(uuid) from public, anon, authenticated;
grant execute on function public.dispatch_tick() to service_role;
revoke execute on function public.start_dispatch(uuid), public.assign_trip(uuid, uuid), public.respond_offer(uuid, boolean), public.rider_ping(double precision, double precision, real), public.my_job(), public.my_offer() from public, anon;
grant execute on function public.start_dispatch(uuid), public.assign_trip(uuid, uuid), public.respond_offer(uuid, boolean), public.rider_ping(double precision, double precision, real), public.my_job(), public.my_offer() to authenticated, service_role;

-- Run the dispatch clock every 5 seconds where pg_cron supports second schedules (Supabase does).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dispatch-tick', '5 seconds', 'select public.dispatch_tick()');
  end if;
end $$;
