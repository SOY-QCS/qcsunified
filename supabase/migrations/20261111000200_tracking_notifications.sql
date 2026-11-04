-- =====================================================================
-- Phase 6 — Live tracking, notifications, address confirmation, ratings
--   1. Templates (editable in admin) + per-user channel preferences + push tokens
--   2. Order events fan out to the sender and the recipient automatically
--   3. A sender worker (Edge Function) claims queued messages, sends, and reports back
--   4. Public tracking: status for anyone; map/rider/address only with the last 4 phone digits
--   5. Recipient address confirmation link (no login)
--   6. Ratings: client rates rider, rider rates pickup
-- =====================================================================

-- ---------- 1a. templates ----------
create table public.notification_templates (
  key         text not null,
  channel     public.notification_channel not null,
  audience    text not null check (audience in ('sender', 'recipient', 'rider', 'staff', 'any')),
  subject     text not null default '',           -- push title / email subject
  body        text not null,                      -- {{placeholders}} are filled from the message data
  wa_template text,                               -- WhatsApp: the Meta-approved template name; {{placeholders}} become its parameters, in order
  essential   boolean not null default false,     -- sent even if the person switched that channel off (e.g. delivery codes)
  enabled     boolean not null default true,
  description text not null default '',
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now(),
  primary key (key, channel)
);
alter table public.notification_templates enable row level security;
create policy templates_read on public.notification_templates for select to authenticated using (public.is_ops());
create policy templates_write on public.notification_templates for update to authenticated
  using (public.has_role(array['super_admin']::public.app_role[])) with check (public.has_role(array['super_admin']::public.app_role[]));
create trigger audit_notification_templates after update on public.notification_templates for each row execute function public.audit_row();

create or replace function public.touch_template() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger notification_templates_touch before update on public.notification_templates for each row execute function public.touch_template();

insert into public.notification_templates (key, channel, audience, subject, body, wa_template, essential, description) values
  -- sender (the person or business who booked)
  ('order_confirmed', 'push',     'sender', 'Booking confirmed', 'Your delivery {{tracking_number}} to {{recipient_name}} is booked. We''re finding a rider.', null, false, 'Order confirmed'),
  ('rider_assigned',  'push',     'sender', 'Rider on the way', '{{rider_name}} ({{rider_plate}}) is coming to pick up {{tracking_number}}.', null, false, 'Rider accepted the job'),
  ('rider_assigned',  'whatsapp', 'sender', '', 'QCS: {{rider_name}} ({{rider_plate}}) is coming to pick up {{tracking_number}}. Track: {{track_url}}', 'qcs_rider_assigned', false, 'Rider accepted the job'),
  ('picked_up',       'push',     'sender', 'Picked up', '{{tracking_number}} has been picked up and is on its way to {{recipient_name}}.', null, false, 'Parcel picked up'),
  ('hub_update',      'push',     'sender', 'Parcel update', '{{tracking_number}}: {{status_text}}.', null, false, 'Inter-city hub scans'),
  ('delivered',       'push',     'sender', 'Delivered ✓', '{{tracking_number}} was delivered to {{recipient_name}}. Tap to rate your rider.', null, false, 'Delivered (with rating prompt)'),
  ('delivered',       'whatsapp', 'sender', '', 'QCS: {{tracking_number}} was delivered to {{recipient_name}}. Rate your rider: {{track_url}}', 'qcs_delivered', false, 'Delivered (with rating prompt)'),
  ('delivered',       'sms',      'sender', '', 'QCS: {{tracking_number}} was delivered to {{recipient_name}}. Rate your rider: {{track_url}}', null, false, 'Delivered (with rating prompt)'),
  ('delivered',       'email',    'sender', 'Your QCS delivery {{tracking_number}} was delivered', 'Hello,\n\n{{tracking_number}} was delivered to {{recipient_name}}.\n\nRate your rider: {{track_url}}\n\nThank you for using QCS.', null, false, 'Delivered (with rating prompt)'),
  ('failed_attempt',  'push',     'sender', 'Delivery attempt failed', '{{tracking_number}} could not be delivered: {{reason}}. We''ll be in touch.', null, false, 'Failed attempt'),
  ('failed_attempt',  'whatsapp', 'sender', '', 'QCS: {{tracking_number}} could not be delivered ({{reason}}). Details: {{track_url}}', 'qcs_failed_attempt', false, 'Failed attempt'),
  ('failed_attempt',  'sms',      'sender', '', 'QCS: {{tracking_number}} could not be delivered ({{reason}}). Details: {{track_url}}', null, false, 'Failed attempt'),
  ('returned',        'push',     'sender', 'Parcel returned', '{{tracking_number}} has been returned to you.', null, false, 'Returned to sender'),
  ('cancelled',       'push',     'sender', 'Booking cancelled', '{{tracking_number}} was cancelled.', null, false, 'Cancelled'),
  ('price_changed',   'push',     'sender', 'Delivery price updated', '{{recipient_name}} moved the drop-off pin by {{moved_km}} km. Extra GHS {{extra_ghs}} is due on delivery for {{tracking_number}}.', null, true, 'Recipient moved the pin more than 1 km'),
  ('price_changed',   'sms',      'sender', '', 'QCS: {{recipient_name}} moved the drop-off for {{tracking_number}} by {{moved_km}} km. Extra GHS {{extra_ghs}} is due on delivery.', null, true, 'Recipient moved the pin more than 1 km'),
  -- recipient (usually has no account: SMS or WhatsApp to their phone)
  ('address_confirm', 'sms',      'recipient', '', 'QCS: {{sender}} is sending you a parcel ({{tracking_number}}). Please confirm your location: {{confirm_url}}', null, false, 'Confirm-your-address link'),
  ('address_confirm', 'whatsapp', 'recipient', '', 'QCS: {{sender}} is sending you a parcel ({{tracking_number}}). Please confirm your location: {{confirm_url}}', 'qcs_address_confirm', false, 'Confirm-your-address link'),
  ('on_the_way',      'sms',      'recipient', '', 'QCS: your parcel from {{sender}} is on the way with {{rider_name}}. Track it: {{track_url}}', null, false, 'Out for delivery'),
  ('on_the_way',      'whatsapp', 'recipient', '', 'QCS: your parcel from {{sender}} is on the way with {{rider_name}}. Track it: {{track_url}}', 'qcs_on_the_way', false, 'Out for delivery'),
  ('rider_arrived',   'sms',      'recipient', '', 'QCS: {{rider_name}} has arrived with your parcel. Please have your 4-digit delivery code ready.', null, false, 'Rider at the door'),
  ('ready_for_collection', 'sms', 'recipient', '', 'QCS: your parcel {{tracking_number}} is ready for collection at {{hub_name}}. Bring your delivery code.', null, false, 'Ready at the hub'),
  ('failed_attempt_recipient', 'sms', 'recipient', '', 'QCS: we could not deliver your parcel {{tracking_number}} ({{reason}}). We will contact you to arrange another time.', null, false, 'Failed attempt (recipient)'),
  ('delivery_code',   'sms',      'recipient', '', 'QCS: your delivery code for {{tracking_number}} from {{sender}} is {{code}}. Give it to the rider only when you receive your parcel.', null, true, 'Delivery code (always sent)'),
  -- riders
  ('job_offer',          'push', 'rider', 'New job', 'New job near you — open the app to accept within {{expires_in}} seconds.', null, true, 'Job offer'),
  ('route_changed',      'push', 'rider', 'Drop-off moved', 'The recipient moved the drop-off pin for {{tracking_number}}. Your navigation has the new location.', null, true, 'Recipient corrected the pin'),
  ('override_approved',  'push', 'rider', 'Override approved', 'You can now mark the parcel delivered.', null, true, 'Delivery without code approved'),
  ('override_rejected',  'push', 'rider', 'Override refused', 'Get the code from the recipient or report a failed attempt.', null, true, 'Delivery without code refused'),
  ('rider_approved',     'sms',  'rider', '', 'QCS: your rider application is approved. Open the QCS Rider app and go online to receive jobs. {{note}}', null, true, 'Rider application approved'),
  ('rider_rejected',     'sms',  'rider', '', 'QCS: your rider application was not approved. {{note}}', null, true, 'Rider application not approved'),
  -- staff
  ('dispatch_escalated', 'push', 'staff', 'Job needs a dispatcher', 'No rider took a job: {{reason}}', null, true, 'Escalated job'),
  ('override_requested', 'push', 'staff', 'Override request', 'A rider asks to deliver {{tracking_number}} without the code.', null, true, 'Rider asks for an override'),
  ('low_rating',         'push', 'staff', 'Low rating', '{{tracking_number}} was rated {{score}}/5: {{comment}}', null, true, 'Client gave 1 or 2 stars'),
  ('referral_reward',    'push', 'any',   'Referral reward', 'You earned GHS {{amount_ghs}} in delivery credit. Thank you!', null, false, 'Referral credit');

-- ---------- 1b. preferences & push tokens ----------
create table public.notification_preferences (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  push       boolean not null default true,
  whatsapp   boolean not null default true,
  sms        boolean not null default false,   -- SMS costs money per message, so it is opt-in for account holders
  email      boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.notification_preferences enable row level security;
create policy prefs_own on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.push_tokens (
  token      text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  app        text not null check (app in ('client', 'rider')),
  platform   text,
  updated_at timestamptz not null default now()
);
create index push_tokens_user_idx on public.push_tokens (user_id);
alter table public.push_tokens enable row level security;
create policy push_tokens_own on public.push_tokens for select to authenticated using (user_id = (select auth.uid()));

-- One phone = one person: a token moves to whoever signed in last on that phone.
create or replace function public.register_push_token(p_token text, p_app text, p_platform text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_token !~ '^Expo(nent)?PushToken\[.+\]$' then raise exception 'Not an Expo push token'; end if;
  insert into public.push_tokens (token, user_id, app, platform) values (p_token, auth.uid(), p_app, p_platform)
  on conflict (token) do update set user_id = excluded.user_id, app = excluded.app, platform = excluded.platform, updated_at = now();
end $$;
create or replace function public.unregister_push_token(p_token text) returns void
language sql security definer set search_path = public, extensions as $$
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
$$;
grant execute on function public.register_push_token(text, text, text), public.unregister_push_token(text) to authenticated;

-- ---------- settings ----------
insert into public.app_settings (key, value, description) values
  ('public_site_url',    '"https://qcsghana.com"', 'Public website address used in tracking and confirmation links'),
  ('recipient_channels', '["sms"]',                'How recipients without an account are messaged: "sms" and/or "whatsapp"'),
  ('eta_speed_kmh',      '20',                     'Average rider speed for arrival estimates (km/h)'),
  ('rating_window_days', '14',                     'Days after delivery a client can still rate the rider')
on conflict do nothing;

create or replace function public._setting(p_key text, p_default jsonb) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select value from public.app_settings where key = p_key and city_id is null), p_default);
$$;

-- ---------- notification queue extras ----------
alter table public.notifications
  add column attempts        smallint not null default 0,
  add column next_attempt_at timestamptz not null default now();
drop index if exists public.notifications_queue_idx;
create index notifications_queue_idx on public.notifications (next_attempt_at) where status = 'queued';

-- Queue one message for an account holder (by their preferences) or a bare phone/email.
create or replace function public._enqueue(p_user uuid, p_to text, p_order uuid, p_key text, p_payload jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare pref public.notification_preferences; chans text[];
begin
  if p_user is not null then
    select * into pref from public.notification_preferences where user_id = p_user;
    insert into public.notifications (user_id, order_id, channel, template, payload)
    select p_user, p_order, t.channel, p_key, p_payload
    from public.notification_templates t
    where t.key = p_key and t.enabled and (t.essential or case t.channel
      when 'push' then coalesce(pref.push, true) when 'whatsapp' then coalesce(pref.whatsapp, true)
      when 'sms' then coalesce(pref.sms, false) when 'email' then coalesce(pref.email, false) end);
  elsif p_to is not null then
    chans := array(select jsonb_array_elements_text(public._setting('recipient_channels', '["sms"]')));
    insert into public.notifications (to_address, order_id, channel, template, payload)
    select p_to, p_order, t.channel, p_key, p_payload
    from public.notification_templates t
    where t.key = p_key and t.enabled and t.channel::text = any (chans);
  end if;
end $$;

-- ---------- 2. order events → messages ----------
alter table public.orders add column confirm_token text unique default encode(extensions.gen_random_bytes(12), 'hex');
update public.orders set confirm_token = encode(extensions.gen_random_bytes(12), 'hex') where confirm_token is null;
alter table public.orders add column address_corrections smallint not null default 0;

create or replace function public._order_payload(o public.orders) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'tracking_number', o.tracking_number,
    'recipient_name',  o.recipient_name,
    'sender',          coalesce((select business_name from public.vendors where id = o.vendor_id), nullif(o.pickup_contact_name, ''), 'Someone'),
    'rider_name',      coalesce((select split_part(p.full_name, ' ', 1) from public.profiles p where p.id = o.rider_id), 'your rider'),
    'rider_plate',     coalesce((select v.plate_number from public.riders r join public.vehicles v on v.id = r.vehicle_id where r.id = o.rider_id), ''),
    'hub_name',        coalesce((select name from public.hubs where id = o.dest_hub_id), 'the QCS hub'),
    'track_url',       rtrim(public._setting('public_site_url', '"https://qcsghana.com"') #>> '{}', '/') || '/track/' || o.tracking_number,
    'confirm_url',     rtrim(public._setting('public_site_url', '"https://qcsghana.com"') #>> '{}', '/') || '/c/' || o.confirm_token);
$$;

create or replace function public.notify_on_event() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; pl jsonb; s text := new.to_status::text;
begin
  select * into o from public.orders where id = new.order_id;
  pl := public._order_payload(o) || jsonb_build_object('reason', coalesce(new.reason, new.note, ''),
          'status_text', lower(replace(s, '_', ' ')));
  if s = 'CONFIRMED' then
    perform public._enqueue(o.customer_id, null, o.id, 'order_confirmed', pl);
    if o.address_confirmation = 'pending' then perform public._enqueue(null, o.recipient_phone, o.id, 'address_confirm', pl); end if;
  elsif s = 'ASSIGNED' then
    perform public._enqueue(o.customer_id, null, o.id, 'rider_assigned', pl);
  elsif s = 'PICKED_UP' then
    perform public._enqueue(o.customer_id, null, o.id, 'picked_up', pl);
    if o.service_type <> 'intercity' then perform public._enqueue(null, o.recipient_phone, o.id, 'on_the_way', pl); end if;
    -- bulk / inter-city stops still unconfirmed when the parcel leaves are flagged for dispatch
    if o.address_confirmation = 'pending' then
      perform public._sys(1);
      update public.orders set address_confirmation = 'unconfirmed' where id = o.id;
      perform public._sys(-1);
    end if;
  elsif s = 'OUT_FOR_DELIVERY' then
    perform public._enqueue(null, o.recipient_phone, o.id, 'on_the_way', pl);
  elsif s in ('AT_HUB', 'DEPARTED_HUB', 'ARRIVED_DEST_HUB') then
    perform public._enqueue(o.customer_id, null, o.id, 'hub_update', pl);
  elsif s = 'ARRIVED_AT_DROPOFF' then
    perform public._enqueue(null, o.recipient_phone, o.id, 'rider_arrived', pl);
  elsif s = 'READY_FOR_COLLECTION' then
    perform public._enqueue(null, o.recipient_phone, o.id, 'ready_for_collection', pl);
  elsif s in ('DELIVERED', 'COLLECTED') then
    perform public._enqueue(o.customer_id, null, o.id, 'delivered', pl);
  elsif s = 'FAILED_ATTEMPT' then
    perform public._enqueue(o.customer_id, null, o.id, 'failed_attempt', pl);
    perform public._enqueue(null, o.recipient_phone, o.id, 'failed_attempt_recipient', pl);
  elsif s = 'RETURNED' then
    perform public._enqueue(o.customer_id, null, o.id, 'returned', pl);
  elsif s = 'CANCELLED' then
    perform public._enqueue(o.customer_id, null, o.id, 'cancelled', pl);
  end if;
  return null;
end $$;
create trigger order_events_notify after insert on public.order_events for each row execute function public.notify_on_event();

-- ---------- 3. the sender worker's side ----------
create or replace function public._render(p_text text, p_data jsonb) returns text
language plpgsql immutable as $$
declare k text; v text; out text := p_text;
begin
  for k, v in select * from jsonb_each_text(coalesce(p_data, '{}'::jsonb)) loop
    out := replace(out, '{{' || k || '}}', coalesce(v, ''));
  end loop;
  return regexp_replace(replace(out, '\n', E'\n'), '\{\{[a-z_]+\}\}', '', 'g');   -- unknown placeholders become blank
end $$;

-- Hands the worker up to p_limit messages, already worded and addressed. Messages nobody can receive are skipped.
create or replace function public.claim_notifications(p_limit int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n record; t public.notification_templates; dest jsonb; data jsonb;
begin
  for n in
    select * from public.notifications
     where (status = 'queued' and next_attempt_at <= now()) or (status = 'sending' and next_attempt_at < now() - interval '5 minutes')
     order by next_attempt_at limit p_limit for update skip locked
  loop
    select * into t from public.notification_templates where key = n.template and channel = n.channel;
    if not found or not t.enabled then
      update public.notifications set status = 'skipped', error = 'no active template' where id = n.id; continue;
    end if;
    data := n.payload || jsonb_build_object(
      'amount_ghs', to_char(coalesce((n.payload ->> 'amount')::numeric, 0) / 100, 'FM999990.00'));
    dest := case n.channel
      when 'push' then (select to_jsonb(array_agg(token)) from public.push_tokens where user_id = n.user_id)
      when 'email' then to_jsonb(coalesce(n.to_address, (select email from public.profiles where id = n.user_id)))
      else to_jsonb(coalesce(n.to_address, (select phone from public.profiles where id = n.user_id))) end;
    if dest is null or dest = 'null'::jsonb then
      update public.notifications set status = 'skipped', error = 'no ' || n.channel || ' address' where id = n.id; continue;
    end if;
    update public.notifications set status = 'sending', attempts = attempts + 1, next_attempt_at = now() where id = n.id;
    return next jsonb_build_object(
      'id', n.id, 'channel', n.channel, 'to', dest, 'key', n.template,
      'subject', public._render(t.subject, data), 'body', public._render(t.body, data),
      'wa_template', t.wa_template,
      'wa_params', (select coalesce(jsonb_agg(coalesce(data ->> m[1], '') order by ord), '[]'::jsonb)
                    from regexp_matches(t.body, '\{\{([a-z_]+)\}\}', 'g') with ordinality as x(m, ord)),
      'data', jsonb_build_object('order_id', n.order_id, 'key', n.template) || (n.payload - 'code'));
  end loop;
end $$;

-- The worker reports each result. Failures are retried up to 3 times (1, 2, then 3 minutes later).
create or replace function public.finish_notification(p_id uuid, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.notifications set
    status = case when p_ok then 'sent' when attempts >= 3 then 'failed' else 'queued' end::public.notification_status,
    sent_at = case when p_ok then now() end,
    error = case when p_ok then null else left(p_error, 500) end,
    next_attempt_at = now() + make_interval(mins => attempts),
    -- once a delivery code has gone out (or we gave up), wipe it: staff can read this table, codes stay secret
    payload = case when p_ok or attempts >= 3 then payload - 'code' else payload end
  where id = p_id and status = 'sending';
end $$;

-- Expo says a push token is dead (app uninstalled): forget it.
create or replace function public.drop_push_token(p_token text) returns void
language sql security definer set search_path = public, extensions as $$ delete from public.push_tokens where token = p_token; $$;

revoke all on function public.claim_notifications(int), public.finish_notification(uuid, boolean, text), public.drop_push_token(text),
  public._enqueue(uuid, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_notifications(int), public.finish_notification(uuid, boolean, text), public.drop_push_token(text) to service_role;

-- Keep the queue small: delete delivered messages after 90 days.
create or replace function public.purge_old_notifications() returns void
language sql security definer set search_path = public, extensions as $$
  delete from public.notifications where status in ('sent', 'skipped', 'failed') and created_at < now() - interval '90 days';
$$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-old-notifications', '40 2 * * *', 'select public.purge_old_notifications()');
  end if;
end $$;

-- ---------- 4. public tracking ----------
create table public.track_attempts (
  tracking_number text not null,
  ok              boolean not null,
  at              timestamptz not null default now()
);
create index track_attempts_idx on public.track_attempts (tracking_number, at);
alter table public.track_attempts enable row level security;   -- no policies: only the functions below use it

create or replace function public._eta_minutes(p_from geography, p_to geography) returns int
language sql stable security definer set search_path = public, extensions as $$
  -- straight line × 1.4 for real roads, at the configured average speed. Free; good enough for "about 15 min".
  select ceil(st_distance(p_from, p_to) * 1.4 / 1000 / greatest(5, (public._setting('eta_speed_kmh', '20') #>> '{}')::numeric) * 60)::int;
$$;

create or replace function public.track_order(p_tracking text, p_last4 text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; r public.riders; v_ok boolean := false; tries int; res jsonb; live boolean; eta int; prof public.profiles; veh public.vehicles;
        photo text;
begin
  select * into o from public.orders where tracking_number = upper(trim(p_tracking));
  if not found or o.status in ('DRAFT') then return jsonb_build_object('found', false); end if;

  if auth.uid() is not null and public.can_see_order(o.id) then v_ok := true;
  elsif p_last4 is not null and p_last4 <> '' then
    select count(*) into tries from public.track_attempts where tracking_number = o.tracking_number and not ok and at > now() - interval '1 hour';
    if tries >= 10 then
      return jsonb_build_object('found', true, 'locked', true, 'tracking_number', o.tracking_number, 'status', o.status);
    end if;
    v_ok := right(regexp_replace(o.recipient_phone, '\D', '', 'g'), 4) = regexp_replace(p_last4, '\D', '', 'g');
    insert into public.track_attempts (tracking_number, ok) values (o.tracking_number, v_ok);
  end if;

  res := jsonb_build_object(
    'found', true, 'verified', v_ok, 'tracking_number', o.tracking_number, 'status', o.status, 'service_type', o.service_type,
    'created_at', o.created_at, 'delivered_at', o.delivered_at,
    'timeline', coalesce((select jsonb_agg(jsonb_build_object('status', e.to_status, 'at', coalesce(e.occurred_at, e.created_at)) order by e.id)
                 from public.order_events e where e.order_id = o.id and e.to_status not in ('DRAFT', 'PENDING_PAYMENT')), '[]'::jsonb));
  if not v_ok then return res; end if;

  live := o.status in ('ASSIGNED', 'RIDER_AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ARRIVED_AT_DROPOFF');
  if o.rider_id is not null then
    select * into r from public.riders where id = o.rider_id;
    select * into prof from public.profiles where id = o.rider_id;
    select * into veh from public.vehicles where id = r.vehicle_id;
    select storage_path into photo from public.rider_documents where rider_id = o.rider_id and doc_type = 'photo' order by created_at desc limit 1;
  end if;
  if live and r.last_location is not null and r.last_location_at > now() - interval '5 minutes' then
    eta := case
      when o.status in ('ASSIGNED', 'RIDER_AT_PICKUP') then public._eta_minutes(r.last_location, o.pickup_location) + 5
                                                          + case when o.service_type = 'intercity' then 0 else public._eta_minutes(o.pickup_location, o.dropoff_location) end
      when o.status = 'ARRIVED_AT_DROPOFF' then 0
      when o.service_type = 'intercity' and o.status in ('PICKED_UP', 'IN_TRANSIT') then null   -- going to the hub, not to you
      else public._eta_minutes(r.last_location, o.dropoff_location) end;
  end if;

  return res || jsonb_build_object(
    'recipient_name', o.recipient_name,
    'dropoff', jsonb_build_object('address', o.dropoff_address_text, 'landmark', o.dropoff_landmark,
                                  'lat', st_y(o.dropoff_location::geometry), 'lng', st_x(o.dropoff_location::geometry)),
    'pickup', jsonb_build_object('lat', st_y(o.pickup_location::geometry), 'lng', st_x(o.pickup_location::geometry)),
    'eta_minutes', eta,
    'can_rate', o.status in ('DELIVERED', 'COLLECTED') and auth.uid() is not null and o.customer_id = auth.uid()
                and not exists (select 1 from public.ratings x where x.order_id = o.id and x.kind = 'client'),
    'rider', case when o.rider_id is null then null else jsonb_build_object(
      'first_name', split_part(prof.full_name, ' ', 1), 'rating', r.rating,
      'vehicle', veh.type, 'plate', veh.plate_number, 'make_model', veh.make_model,
      'photo_path', photo,
      -- the rider's number is shown only while they are on the way, never after delivery
      'phone', case when live then prof.phone end,
      'location', case when live and r.last_location_at > now() - interval '5 minutes' then jsonb_build_object(
          'lat', st_y(r.last_location::geometry), 'lng', st_x(r.last_location::geometry), 'at', r.last_location_at) end) end);
end $$;
grant execute on function public.track_order(text, text) to anon, authenticated;

-- ---------- 5. recipient confirms or corrects their pin ----------
create or replace function public.address_link(p_token text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'tracking_number', o.tracking_number, 'service_type', o.service_type, 'status', o.status,
    'recipient_name', o.recipient_name,
    'sender', coalesce((select business_name from public.vendors where id = o.vendor_id), nullif(o.pickup_contact_name, ''), 'Someone'),
    'address', o.dropoff_address_text, 'landmark', o.dropoff_landmark, 'gps', o.dropoff_ghana_post_gps,
    'lat', st_y(o.dropoff_location::geometry), 'lng', st_x(o.dropoff_location::geometry),
    'confirmation', o.address_confirmation,
    'can_change', o.status not in ('ARRIVED_AT_DROPOFF', 'DELIVERED', 'COLLECTED', 'CANCELLED', 'RETURNED', 'RETURNING_TO_SENDER', 'LOST', 'DAMAGED')
                  and o.address_corrections < 3)
  from public.orders o where o.confirm_token = p_token and length(p_token) >= 16;
$$;
grant execute on function public.address_link(text) to anon, authenticated, service_role;

create or replace function public.confirm_address(p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders;
begin
  select * into o from public.orders where confirm_token = p_token and length(p_token) >= 16 for update;
  if not found then raise exception 'This link is not valid'; end if;
  if o.address_confirmation in ('pending', 'unconfirmed') then
    perform public._sys(1);
    update public.orders set address_confirmation = 'confirmed' where id = o.id;
    perform public._sys(-1);
  end if;
end $$;
grant execute on function public.confirm_address(text) to anon, authenticated;

-- Moving the pin. The business portal calls this with the extra price worked out by the pricing engine
-- (Express, moved more than 1 km); smaller moves keep the quoted price.
create or replace function public.correct_address(p_token text, p_lng double precision, p_lat double precision,
                                                  p_landmark text, p_note text, p_extra bigint default 0) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; z record; newpt geography; moved int; pl jsonb;
begin
  select * into o from public.orders where confirm_token = p_token and length(p_token) >= 16 for update;
  if not found then raise exception 'This link is not valid'; end if;
  if not (public.address_link(p_token) ->> 'can_change')::boolean then raise exception 'This delivery can no longer be changed. Please call the rider.'; end if;
  select * into z from public.zone_for_point(p_lng, p_lat);
  if z.city_id is distinct from o.city_id then raise exception 'That location is outside the delivery area for this parcel'; end if;
  newpt := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
  moved := round(st_distance(o.dropoff_location, newpt));
  perform set_config('qcs.audit_reason', 'recipient corrected the drop-off pin by ' || moved || ' m', true);
  perform public._sys(1);
  update public.orders set dropoff_location = newpt, dropoff_zone_id = z.zone_id,
         dropoff_landmark = coalesce(nullif(trim(p_landmark), ''), dropoff_landmark),
         delivery_instructions = case when nullif(trim(p_note), '') is null then delivery_instructions
                                      else concat_ws(' · ', delivery_instructions, 'Recipient: ' || trim(p_note)) end,
         extra_fee = extra_fee + greatest(0, coalesce(p_extra, 0)),
         address_confirmation = 'corrected', address_corrections = address_corrections + 1
   where id = o.id returning * into o;
  perform public._sys(-1);
  pl := public._order_payload(o) || jsonb_build_object('moved_km', to_char(moved / 1000.0, 'FM990.0'),
        'extra_ghs', to_char(greatest(0, coalesce(p_extra, 0)) / 100.0, 'FM999990.00'));
  if coalesce(p_extra, 0) > 0 then perform public._enqueue(o.customer_id, null, o.id, 'price_changed', pl); end if;
  if o.rider_id is not null then perform public._enqueue(o.rider_id, null, o.id, 'route_changed', pl); end if;
  return jsonb_build_object('moved_m', moved, 'extra', greatest(0, coalesce(p_extra, 0)));
end $$;
revoke all on function public.correct_address(text, double precision, double precision, text, text, bigint) from public, anon, authenticated;
grant execute on function public.correct_address(text, double precision, double precision, text, text, bigint) to service_role;

-- ---------- 6. ratings ----------
create table public.ratings (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  kind       text not null check (kind in ('client', 'rider')),   -- client rates the rider; rider rates the pickup
  rater_id   uuid not null references public.profiles(id),
  rider_id   uuid not null references public.riders(id),
  vendor_id  uuid references public.vendors(id),
  score      smallint not null check (score between 1 and 5),
  tags       text[] not null default '{}',
  comment    text check (length(comment) <= 1000),
  created_at timestamptz not null default now(),
  unique (order_id, kind)
);
create index ratings_rider_idx on public.ratings (rider_id, created_at desc) where kind = 'client';
create index ratings_vendor_idx on public.ratings (vendor_id, created_at desc) where kind = 'rider';
alter table public.ratings enable row level security;
create policy ratings_read on public.ratings for select to authenticated using (
  rater_id = (select auth.uid()) or (kind = 'client' and rider_id = (select auth.uid()))
  or vendor_id in (select public.my_vendor_ids()) or public.is_ops());
create trigger ratings_append_only before update or delete on public.ratings for each row execute function public.block_change();

create or replace function public.rate_rider(p_order uuid, p_score int, p_tags text[] default '{}', p_comment text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; days int := (public._setting('rating_window_days', '14') #>> '{}')::int; pl jsonb;
begin
  select * into o from public.orders where id = p_order;
  if not found or not (o.customer_id = auth.uid() or o.vendor_id in (select public.my_vendor_ids())) then raise exception 'You can only rate your own deliveries'; end if;
  if o.status not in ('DELIVERED', 'COLLECTED') or o.rider_id is null then raise exception 'You can rate the rider once the parcel is delivered'; end if;
  if o.delivered_at < now() - make_interval(days => days) then raise exception 'Ratings close % days after delivery', days; end if;
  if exists (select 1 from public.ratings where order_id = o.id and kind = 'client') then raise exception 'This delivery has already been rated'; end if;
  insert into public.ratings (order_id, kind, rater_id, rider_id, vendor_id, score, tags, comment)
  values (o.id, 'client', auth.uid(), o.rider_id, o.vendor_id, p_score, coalesce(p_tags, '{}'), nullif(trim(p_comment), ''));
  -- rider's rating = average of their last 100 client ratings
  perform public._sys(1);
  update public.riders set rating = (select round(avg(score), 2) from (select score from public.ratings
                                       where rider_id = o.rider_id and kind = 'client' order by created_at desc limit 100) x)
   where id = o.rider_id;
  perform public._sys(-1);
  if p_score <= 2 then
    pl := jsonb_build_object('tracking_number', o.tracking_number, 'score', p_score, 'comment', coalesce(nullif(trim(p_comment), ''), 'no comment'));
    perform public._enqueue(ur.user_id, null, o.id, 'low_rating', pl)
      from (select distinct user_id from public.user_roles where role in ('support', 'city_admin') and (city_id = o.city_id or city_id is null)) ur;
  end if;
end $$;

create or replace function public.rate_pickup(p_order uuid, p_score int, p_tags text[] default '{}', p_comment text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if not found or o.rider_id is distinct from auth.uid() then raise exception 'You can only rate pickups on your own jobs'; end if;
  if o.status in ('ASSIGNED', 'RIDER_AT_PICKUP', 'CONFIRMED', 'SEARCHING_RIDER') then raise exception 'Rate the pickup after you have the parcel'; end if;
  if exists (select 1 from public.ratings where order_id = o.id and kind = 'rider') then return; end if;   -- one rating per pickup; repeats are ignored
  insert into public.ratings (order_id, kind, rater_id, rider_id, vendor_id, score, tags, comment)
  values (o.id, 'rider', auth.uid(), o.rider_id, o.vendor_id, p_score, coalesce(p_tags, '{}'), nullif(trim(p_comment), ''));
end $$;
grant execute on function public.rate_rider(uuid, int, text[], text), public.rate_pickup(uuid, int, text[], text) to authenticated;
