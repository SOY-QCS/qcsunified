-- Phase 13 · Fraud flags.
-- An hourly scan looks for suspicious patterns and puts them on a review list in the Ops dashboard (Fraud page).
-- A flag is a QUESTION for a person, never an automatic punishment: Ops reviews, then dismisses or confirms (with a note, audited).
-- Patterns:
--   shared_device       one phone used by many accounts (fake sign-ups for referral credit, banned users coming back)
--   recipient_failures  the same recipient phone keeps failing / returning (fake or prank orders, COD refusals)
--   rider_failures      a rider marks far more deliveries "failed" than normal (avoiding work, keeping goods)
--   vendor_failures     a vendor's orders fail or come back far more than normal
--   gps_spoofing        the rider app reports a fake-location app, or the rider "jumps" faster than a motorbike can go
--   far_deliveries      a rider repeatedly marks deliveries done far from the drop-off pin
--   cancellations       a customer or vendor cancels far more than normal (wastes riders' time, tests stolen cards)
-- Every threshold is a setting (Settings page), so Ops can tune it without a developer.

-- ---------- 1. Which phone is this? (apps send the phone's own app ID after sign-in) ----------
create table public.device_logins (
  device_id  text        not null check (length(device_id) between 8 and 128),
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  app        text        not null check (app in ('client', 'rider')),
  platform   text,
  model      text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (device_id, user_id)
);
create index device_logins_user_idx on public.device_logins (user_id);
create index device_logins_seen_idx on public.device_logins (last_seen);
alter table public.device_logins enable row level security;
create policy device_logins_read on public.device_logins for select to authenticated
  using (user_id = (select auth.uid()) or public.has_role(array['super_admin', 'city_admin', 'dispatcher', 'support']::public.app_role[]));
comment on table public.device_logins is 'Which accounts signed in on which phone (the phone''s own app ID). Used to spot one phone with many accounts.';

create or replace function public.register_device(p_device text, p_app text, p_platform text default null, p_model text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._need(auth.uid() is not null, 'Please sign in');
  perform public._need(p_app in ('client', 'rider') and length(coalesce(p_device, '')) between 8 and 128, 'Unknown device');
  insert into public.device_logins (device_id, user_id, app, platform, model)
  values (p_device, auth.uid(), p_app, left(p_platform, 20), left(p_model, 60))
  on conflict (device_id, user_id) do update set last_seen = now(), app = excluded.app, platform = excluded.platform, model = excluded.model;
end $$;

-- ---------- 2. Rider GPS: remember fake-location reports and impossible jumps ----------
alter table public.rider_location_pings
  add column mocked    boolean,   -- Android says the location came from a "mock location" app
  add column speed_kmh real,      -- speed implied by the jump from the previous position (only for jumps of 1 km+)
  add column suspect   boolean not null default false;
create index rider_pings_suspect_idx on public.rider_location_pings (recorded_at) where suspect;

drop function public.rider_ping(double precision, double precision, real);
create function public.rider_ping(p_lng double precision, p_lat double precision, p_accuracy real default null, p_mocked boolean default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); pt geography := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography; trip uuid; last timestamptz;
        prev geography; prev_at timestamptz; metres float8; kmh real; sus boolean;
begin
  if me is null or not exists (select 1 from public.riders where id = me) then raise exception 'Riders only'; end if;
  if p_lat not between 4.5 and 11.3 or p_lng not between -3.4 and 1.3 then return; end if;   -- ignore GPS glitches outside Ghana
  select last_location, last_location_at into prev, prev_at from public.riders where id = me;
  if prev is not null and prev_at < now() then
    metres := st_distance(prev, pt);
    -- only real jumps with a decent fix count (small GPS wobbles over a few seconds look "fast" but mean nothing)
    if metres >= 1000 and coalesce(p_accuracy, 0) <= 100 then
      kmh := (metres / 1000.0) / greatest(extract(epoch from now() - prev_at) / 3600.0, 1 / 3600.0);
    end if;
  end if;
  sus := coalesce(p_mocked, false) or coalesce(kmh > public.setting_int('fraud_max_speed_kmh', 150), false);
  select id into trip from public.trips where rider_id = me and status in ('ASSIGNED', 'IN_PROGRESS') limit 1;
  update public.riders set last_location = pt, last_location_at = now() where id = me;
  if trip is not null or sus then
    insert into public.rider_location_pings (rider_id, trip_id, location, accuracy_m, mocked, speed_kmh, suspect) values (me, trip, pt, p_accuracy, p_mocked, kmh, sus);
  else
    select max(recorded_at) into last from public.rider_location_pings where rider_id = me and trip_id is null;
    if last is null or last < now() - interval '55 seconds' then
      insert into public.rider_location_pings (rider_id, trip_id, location, accuracy_m, mocked, speed_kmh, suspect) values (me, null, pt, p_accuracy, p_mocked, kmh, false);
    end if;
  end if;
end $$;
revoke execute on function public.rider_ping(double precision, double precision, real, boolean) from public, anon;
grant execute on function public.rider_ping(double precision, double precision, real, boolean) to authenticated;

-- ---------- 3. The review list ----------
create table public.fraud_flags (
  id           uuid        primary key default gen_random_uuid(),
  kind         text        not null check (kind in ('shared_device', 'recipient_failures', 'rider_failures', 'vendor_failures', 'gps_spoofing', 'far_deliveries', 'cancellations')),
  subject_type text        not null check (subject_type in ('device', 'phone', 'rider', 'vendor', 'customer')),
  subject_id   uuid,                                -- rider / vendor / customer id (none for a phone or device)
  subject_key  text        not null,                -- what is flagged: device id, phone number, or the id as text
  city_id      uuid        references public.cities(id),
  severity     text        not null default 'medium' check (severity in ('low', 'medium', 'high')),
  summary      text        not null,
  evidence     jsonb       not null default '{}'::jsonb,
  status       text        not null default 'open' check (status in ('open', 'dismissed', 'confirmed')),
  times_seen   int         not null default 1,      -- how many hourly scans found it
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  reviewed_by  uuid        references public.profiles(id),
  reviewed_at  timestamptz,
  review_note  text
);
create unique index fraud_flags_open_uq on public.fraud_flags (kind, subject_key) where status = 'open';
create index fraud_flags_list_idx on public.fraud_flags (status, last_seen desc);
alter table public.fraud_flags enable row level security;
create policy fraud_flags_read on public.fraud_flags for select to authenticated
  using (public.has_role(array['super_admin', 'city_admin', 'dispatcher', 'finance', 'support']::public.app_role[], city_id));
create trigger audit_fraud_flags after update of status on public.fraud_flags for each row execute function public.audit_row();
comment on table public.fraud_flags is 'Suspicious patterns found by fraud_scan(), waiting for a person to review.';

-- the scan looks back over days of events: these keep it fast at 10,000+ deliveries a day
create index if not exists order_events_status_time_idx on public.order_events (to_status, created_at);
create index if not exists orders_created_idx on public.orders (created_at);

insert into public.app_settings (key, value, description) values
  ('fraud_device_accounts',     '3',   'Fraud: flag a phone used by this many accounts or more in 30 days (owner + staff of one vendor are fine)'),
  ('fraud_recipient_failures',  '3',   'Fraud: flag a recipient phone with this many failed or returned deliveries in 30 days'),
  ('fraud_rider_failure_pct',   '30',  'Fraud: flag a rider whose failed attempts are this % or more of their attempts in 7 days…'),
  ('fraud_rider_min_attempts',  '10',  '…counting only riders with at least this many attempts in 7 days'),
  ('fraud_vendor_failure_pct',  '40',  'Fraud: flag a vendor whose orders failed or came back this % or more in 7 days…'),
  ('fraud_vendor_min_orders',   '20',  '…counting only vendors with at least this many orders in 7 days'),
  ('fraud_max_speed_kmh',       '150', 'Fraud: a rider position jump faster than this (km/h) counts as suspicious GPS'),
  ('fraud_gps_events',          '3',   'Fraud: flag a rider with this many suspicious GPS readings (fake-location app or impossible jumps) in 24 hours'),
  ('fraud_far_deliveries',      '3',   'Fraud: flag a rider who marked this many deliveries done away from the pin (beyond the geofence flag distance) in 7 days'),
  ('fraud_cancels_per_day',     '5',   'Fraud: flag a customer or vendor who cancels this many bookings in 24 hours…'),
  ('fraud_cancel_pct',          '50',  '…or who cancels this % or more of their bookings in 7 days…'),
  ('fraud_cancel_min_orders',   '10',  '…counting only those with at least this many bookings in 7 days')
on conflict do nothing;

insert into public.notification_templates (key, channel, audience, subject, body, wa_template, essential, description) values
  ('fraud_alert', 'email', 'staff', 'QCS fraud check: {{count}} new high-priority flag(s)',
   'The hourly fraud check found {{count}} new high-priority flag(s):\n\n{{summary}}\n\nReview them: {{link}}\n\nFlags are questions, not proof: check the evidence, then dismiss or confirm with a note.',
   null, true, 'New high-priority fraud flags (to Super Admins and the City Admin of that city)')
on conflict do nothing;

-- Add or refresh a flag. Returns the id only when the flag is NEW (so the scan knows whom to alert).
-- A flag someone dismissed or confirmed in the last 30 days is not raised again for the same thing.
create or replace function public._flag(p_kind text, p_type text, p_id uuid, p_key text, p_city uuid, p_severity text, p_summary text, p_evidence jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare fid uuid; fresh boolean;
begin
  if exists (select 1 from public.fraud_flags where kind = p_kind and subject_key = p_key and status <> 'open' and reviewed_at > now() - interval '30 days') then
    return null;
  end if;
  insert into public.fraud_flags as f (kind, subject_type, subject_id, subject_key, city_id, severity, summary, evidence)
  values (p_kind, p_type, p_id, p_key, p_city, p_severity, p_summary, p_evidence)
  on conflict (kind, subject_key) where status = 'open' do update
    set last_seen = now(), times_seen = f.times_seen + 1, summary = excluded.summary, evidence = excluded.evidence,
        severity = case when 'high' in (f.severity, excluded.severity) then 'high' when 'medium' in (f.severity, excluded.severity) then 'medium' else 'low' end
  returning id, (xmax = 0) into fid, fresh;
  return case when fresh then fid end;
end $$;

-- ---------- 4. The hourly scan ----------
create or replace function public.fraud_scan() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  r record; fid uuid; fresh uuid[] := '{}'; found jsonb := '{}'::jsonb;
  staff public.app_role[] := array['super_admin', 'city_admin', 'dispatcher', 'hub_manager', 'finance', 'support', 'analyst'];
  dev_n    int := public.setting_int('fraud_device_accounts', 3);
  rec_n    int := public.setting_int('fraud_recipient_failures', 3);
  rid_pct  int := public.setting_int('fraud_rider_failure_pct', 30);
  rid_min  int := public.setting_int('fraud_rider_min_attempts', 10);
  ven_pct  int := public.setting_int('fraud_vendor_failure_pct', 40);
  ven_min  int := public.setting_int('fraud_vendor_min_orders', 20);
  gps_n    int := public.setting_int('fraud_gps_events', 3);
  far_n    int := public.setting_int('fraud_far_deliveries', 3);
  far_m    int := public.setting_int('geofence_flag_m', 500);
  can_day  int := public.setting_int('fraud_cancels_per_day', 5);
  can_pct  int := public.setting_int('fraud_cancel_pct', 50);
  can_min  int := public.setting_int('fraud_cancel_min_orders', 10);
  n int;
begin
  -- 1. one phone, many accounts (staff test phones and a vendor's shared shop phone are fine)
  n := 0;
  for r in
    select d.device_id, array_agg(distinct d.user_id) users, count(distinct d.user_id)::int cnt
    from public.device_logins d
    where d.last_seen > now() - interval '30 days'
      and not exists (select 1 from public.user_roles ur where ur.user_id = d.user_id and ur.role = any (staff))
    group by d.device_id having count(distinct d.user_id) >= dev_n
  loop
    continue when exists (select 1 from public.vendors v
                          where (select bool_and(u = v.owner_id or exists (select 1 from public.vendor_staff s where s.vendor_id = v.id and s.user_id = u)) from unnest(r.users) u));
    fid := public._flag('shared_device', 'device', null, r.device_id,
      (select p.city_id from public.profiles p where p.id = any (r.users) and p.city_id is not null limit 1),
      case when r.cnt >= dev_n * 2 or exists (select 1 from public.riders where id = any (r.users)) then 'high' else 'medium' end,
      format('%s accounts signed in on one phone in the last 30 days', r.cnt),
      jsonb_build_object('accounts', (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'phone', p.phone,
                                        'rider', exists (select 1 from public.riders where id = p.id), 'joined', p.created_at,
                                        'last_seen', (select max(last_seen) from public.device_logins where device_id = r.device_id and user_id = p.id)) order by p.created_at)
                                      from public.profiles p where p.id = any (r.users)),
                         'model', (select max(model) from public.device_logins where device_id = r.device_id)));
    n := n + 1; if fid is not null then fresh := fresh || fid; end if;
  end loop;
  found := found || jsonb_build_object('shared_device', n);

  -- 2. the same recipient phone keeps failing or sending parcels back
  n := 0;
  for r in
    select o.recipient_phone phone, count(distinct o.id)::int cnt, count(distinct coalesce(o.vendor_id, o.customer_id))::int senders,
           (array_agg(o.city_id order by o.created_at desc))[1] city,
           jsonb_agg(distinct jsonb_build_object('tracking_number', o.tracking_number, 'status', e.to_status, 'reason', e.reason, 'at', e.created_at)) items
    from public.order_events e join public.orders o on o.id = e.order_id
    where e.to_status in ('FAILED_ATTEMPT', 'RETURNED') and e.created_at > now() - interval '30 days'
    group by o.recipient_phone having count(distinct o.id) >= rec_n
  loop
    fid := public._flag('recipient_failures', 'phone', null, r.phone, r.city,
      case when r.cnt >= rec_n * 2 or r.senders > 1 then 'high' else 'medium' end,
      format('%s deliveries to %s failed or came back in 30 days%s', r.cnt, r.phone, case when r.senders > 1 then format(' (from %s different senders)', r.senders) else '' end),
      jsonb_build_object('orders', r.items, 'senders', r.senders));
    n := n + 1; if fid is not null then fresh := fresh || fid; end if;
  end loop;
  found := found || jsonb_build_object('recipient_failures', n);

  -- 3. a rider who fails far more deliveries than normal
  n := 0;
  for r in
    select e.actor_id rider, rd.city_id city, count(*) filter (where e.to_status = 'FAILED_ATTEMPT')::int failed, count(*)::int attempts,
           (select jsonb_object_agg(coalesce(x.reason, 'no reason'), x.c) from (
              select e2.reason, count(*) c from public.order_events e2
              where e2.actor_id = e.actor_id and e2.to_status = 'FAILED_ATTEMPT' and e2.created_at > now() - interval '7 days' group by e2.reason) x) reasons
    from public.order_events e join public.riders rd on rd.id = e.actor_id
    where e.to_status in ('DELIVERED', 'FAILED_ATTEMPT') and e.created_at > now() - interval '7 days'
    group by e.actor_id, rd.city_id
    having count(*) >= rid_min and 100 * count(*) filter (where e.to_status = 'FAILED_ATTEMPT') >= rid_pct * count(*)
  loop
    fid := public._flag('rider_failures', 'rider', r.rider, r.rider::text, r.city,
      case when 100 * r.failed >= least(100, rid_pct * 2) * r.attempts then 'high' else 'medium' end,
      format('%s of %s delivery attempts marked failed in 7 days (%s%%)', r.failed, r.attempts, round(100.0 * r.failed / r.attempts)),
      jsonb_build_object('failed', r.failed, 'attempts', r.attempts, 'reasons', r.reasons));
    n := n + 1; if fid is not null then fresh := fresh || fid; end if;
  end loop;
  found := found || jsonb_build_object('rider_failures', n);

  -- 4. a vendor whose orders fail or come back far more than normal
  n := 0;
  for r in
    select o.vendor_id vendor, max(v.city_id::text)::uuid city, count(*)::int orders,
           count(*) filter (where exists (select 1 from public.order_events e where e.order_id = o.id and e.to_status in ('FAILED_ATTEMPT', 'RETURNED')))::int bad
    from public.orders o join public.vendors v on v.id = o.vendor_id
    where o.created_at > now() - interval '7 days' and o.status not in ('DRAFT', 'PENDING_PAYMENT', 'CANCELLED')
    group by o.vendor_id having count(*) >= ven_min
  loop
    continue when 100 * r.bad < ven_pct * r.orders;
    fid := public._flag('vendor_failures', 'vendor', r.vendor, r.vendor::text, r.city, 'medium',
      format('%s of %s orders failed or came back in 7 days (%s%%)', r.bad, r.orders, round(100.0 * r.bad / r.orders)),
      jsonb_build_object('orders', r.orders, 'failed_or_returned', r.bad));
    n := n + 1; if fid is not null then fresh := fresh || fid; end if;
  end loop;
  found := found || jsonb_build_object('vendor_failures', n);

  -- 5. fake-location apps and impossible jumps
  n := 0;
  for r in
    select p.rider_id rider, rd.city_id city, count(*)::int cnt, count(*) filter (where p.mocked)::int mocked,
           count(*) filter (where p.speed_kmh is not null and not coalesce(p.mocked, false))::int jumps,
           round(max(p.speed_kmh))::int top_kmh, max(p.recorded_at) last_at
    from public.rider_location_pings p join public.riders rd on rd.id = p.rider_id
    where p.suspect and p.recorded_at > now() - interval '24 hours'
    group by p.rider_id, rd.city_id having count(*) >= gps_n
  loop
    fid := public._flag('gps_spoofing', 'rider', r.rider, r.rider::text, r.city,
      case when r.mocked > 0 then 'high' else 'medium' end,
      case when r.mocked > 0 then format('Phone reported a fake-location app %s time(s) in 24 hours', r.mocked)
           else format('%s impossible position jumps in 24 hours (fastest %s km/h)', r.jumps, r.top_kmh) end,
      jsonb_build_object('mocked', r.mocked, 'jumps', r.jumps, 'fastest_kmh', r.top_kmh, 'last_at', r.last_at));
    n := n + 1; if fid is not null then fresh := fresh || fid; end if;
  end loop;
  found := found || jsonb_build_object('gps_spoofing', n);

  -- 6. deliveries marked done away from the pin, again and again
  n := 0;
  for r in
    select e.actor_id rider, rd.city_id city, count(*)::int cnt,
           jsonb_agg(jsonb_build_object('tracking_number', o.tracking_number, 'metres', round(st_distance(e.location, o.dropoff_location)), 'at', e.created_at) order by e.created_at desc) items
    from public.order_events e join public.orders o on o.id = e.order_id join public.riders rd on rd.id = e.actor_id
    where e.to_status = 'DELIVERED' and e.created_at > now() - interval '7 days' and e.location is not null
      and st_distance(e.location, o.dropoff_location) > far_m
    group by e.actor_id, rd.city_id having count(*) >= far_n
  loop
    fid := public._flag('far_deliveries', 'rider', r.rider, r.rider::text, r.city, 'medium',
      format('%s deliveries marked done more than %s m from the drop-off pin in 7 days', r.cnt, far_m),
      jsonb_build_object('orders', r.items));
    n := n + 1; if fid is not null then fresh := fresh || fid; end if;
  end loop;
  found := found || jsonb_build_object('far_deliveries', n);

  -- 7. cancellations by the person who booked (not by Ops, not unpaid bookings expiring)
  n := 0;
  for r in
    with booked as (
      select coalesce(o.vendor_id, o.customer_id) who, (o.vendor_id is not null) is_vendor, o.city_id, o.id, o.created_at
      from public.orders o
      where o.created_at > now() - interval '7 days' and o.status not in ('DRAFT', 'PENDING_PAYMENT') and coalesce(o.vendor_id, o.customer_id) is not null),
    cancelled as (
      select b.who, e.created_at, e.from_status from booked b join public.order_events e on e.order_id = b.id
      where e.to_status = 'CANCELLED' and e.actor_id is not null
        and not exists (select 1 from public.user_roles ur where ur.user_id = e.actor_id and ur.role = any (staff)))
    select b.who, bool_or(b.is_vendor) is_vendor, (array_agg(b.city_id))[1] city, count(distinct b.id)::int bookings,
           (select count(*) from cancelled c where c.who = b.who)::int c7,
           (select count(*) from cancelled c where c.who = b.who and c.created_at > now() - interval '24 hours')::int c24,
           (select count(*) from cancelled c where c.who = b.who and c.from_status in ('ASSIGNED', 'RIDER_AT_PICKUP'))::int after_rider
    from booked b group by b.who
  loop
    continue when not (r.c24 >= can_day or (r.bookings >= can_min and 100 * r.c7 >= can_pct * r.bookings));
    fid := public._flag('cancellations', case when r.is_vendor then 'vendor' else 'customer' end, r.who, r.who::text, r.city,
      case when r.after_rider >= can_day then 'high' else 'medium' end,
      format('%s of %s bookings cancelled in 7 days (%s in the last 24 hours, %s after a rider was on the way)', r.c7, r.bookings, r.c24, r.after_rider),
      jsonb_build_object('bookings', r.bookings, 'cancelled_7d', r.c7, 'cancelled_24h', r.c24, 'after_rider', r.after_rider));
    n := n + 1; if fid is not null then fresh := fresh || fid; end if;
  end loop;
  found := found || jsonb_build_object('cancellations', n);

  -- one email per admin about NEW high-priority flags (Super Admins: all; City Admins: their city)
  for r in
    select ur.user_id, count(*)::int cnt, string_agg('• ' || f.summary, E'\n' order by f.first_seen) summary
    from public.fraud_flags f
    join public.user_roles ur on ur.role = 'super_admin' or (ur.role = 'city_admin' and ur.city_id = f.city_id)
    where f.id = any (fresh) and f.severity = 'high'
    group by ur.user_id
  loop
    perform public._enqueue(r.user_id, null, null, 'fraud_alert', jsonb_build_object('count', r.cnt, 'summary', r.summary,
      'link', rtrim(public._setting('ops_dashboard_url', '"https://ops.qcsghana.com"') #>> '{}', '/') || '/fraud'));
  end loop;

  return found || jsonb_build_object('new', coalesce(array_length(fresh, 1), 0));
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fraud-scan', '23 * * * *', 'select public.fraud_scan()');   -- every hour at :23
  end if;
end $$;

-- ---------- 5. Reading and reviewing (Ops dashboard) ----------
create or replace function public.fraud_list(p_status text default 'open', p_kind text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'kind', f.kind, 'subject_type', f.subject_type, 'subject_id', f.subject_id, 'subject_key', f.subject_key,
      'subject_name', case f.subject_type
          when 'rider' then (select full_name from public.profiles where id = f.subject_id)
          when 'customer' then (select coalesce(full_name, phone) from public.profiles where id = f.subject_id)
          when 'vendor' then (select business_name from public.vendors where id = f.subject_id)
          else f.subject_key end,
      'city', (select name from public.cities where id = f.city_id), 'severity', f.severity, 'summary', f.summary, 'evidence', f.evidence,
      'status', f.status, 'times_seen', f.times_seen, 'first_seen', f.first_seen, 'last_seen', f.last_seen,
      'reviewed_by', (select coalesce(full_name, email, phone) from public.profiles where id = f.reviewed_by), 'reviewed_at', f.reviewed_at, 'review_note', f.review_note,
      'can_review', public.has_role(array['super_admin', 'city_admin']::public.app_role[], f.city_id))
    order by case f.severity when 'high' then 0 when 'medium' then 1 else 2 end, f.last_seen desc), '[]'::jsonb)
  from (select * from public.fraud_flags
        where status = coalesce(p_status, status) and kind = coalesce(p_kind, kind)
          and public.has_role(array['super_admin', 'city_admin', 'dispatcher', 'finance', 'support']::public.app_role[], city_id)
        order by last_seen desc limit 300) f;
$$;

create or replace function public.review_fraud_flag(p_flag uuid, p_decision text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare f public.fraud_flags;
begin
  select * into f from public.fraud_flags where id = p_flag for update;
  perform public._need(found, 'Flag not found');
  perform public._need(public.has_role(array['super_admin', 'city_admin']::public.app_role[], f.city_id), 'Only a Super Admin or the City Admin can review fraud flags');
  perform public._need(p_decision in ('dismissed', 'confirmed'), 'Choose dismiss or confirm');
  perform public._need(length(trim(coalesce(p_note, ''))) >= 3, 'Write a short note: what you checked and what you decided');
  perform public._need(f.status = 'open', 'This flag was already reviewed');
  perform set_config('qcs.audit_reason', trim(p_note), true);
  update public.fraud_flags set status = p_decision, reviewed_by = auth.uid(), reviewed_at = now(), review_note = trim(p_note) where id = p_flag;
end $$;

revoke execute on function public._flag(text, text, uuid, text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fraud_scan() from public, anon, authenticated;
grant execute on function public.fraud_scan() to service_role;
