-- =====================================================================
-- QCS Unified — Phase 5: proof of delivery, COD at the door, offline-safe rider actions, WhatsApp backup
-- =====================================================================

-- ---------- delivery codes (CLAUDE.md §8) ----------
-- A 4-digit code is created when the parcel is picked up and sent to the recipient by SMS/WhatsApp.
-- Only a hash is kept on the order. After 5 wrong tries the rider must ask for an override.
alter table public.orders
  add column pod_otp_attempts   smallint not null default 0,
  add column pod_method         text check (pod_method in ('app', 'whatsapp', 'override')),
  add column pod_flagged        text,              -- set when a delivery needs a second look (e.g. WhatsApp backup, far from drop-off)
  add column pickup_verified_at timestamptz;       -- high-value: pickup code checked

alter table public.order_events add column occurred_at timestamptz;   -- the time on the rider's phone (offline updates sync later)

-- rider_action() passes the phone's time for the event it is about to write.
create or replace function public.event_occurred_at() returns trigger language plpgsql as $$
begin
  new.occurred_at := coalesce(new.occurred_at, nullif(current_setting('qcs.occurred_at', true), '')::timestamptz);
  return new;
end $$;
create trigger order_events_occurred_at before insert on public.order_events for each row execute function public.event_occurred_at();

create or replace function public.make_delivery_code() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare code text;
begin
  if new.status = 'PICKED_UP' and old.status is distinct from 'PICKED_UP' and new.delivery_otp_hash is null then
    code := lpad((floor(random() * 10000))::int::text, 4, '0');
    perform public._sys(1);
    update public.orders set delivery_otp_hash = crypt(code, gen_salt('bf', 6)) where id = new.id;
    perform public._sys(-1);
    -- the code itself only travels in the message to the recipient (cleared once sent by the notification sender)
    insert into public.notifications (to_address, order_id, channel, template, payload)
    values (new.recipient_phone, new.id, 'sms', 'delivery_code',
            jsonb_build_object('code', code, 'tracking_number', new.tracking_number, 'sender',
                               coalesce((select business_name from public.vendors where id = new.vendor_id), new.pickup_contact_name)));
  end if;
  return new;
end $$;
create trigger orders_delivery_code after update of status on public.orders for each row execute function public.make_delivery_code();

-- Ops can resend (a new code replaces the old one).
create or replace function public.resend_delivery_code(p_order uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; code text := lpad((floor(random() * 10000))::int::text, 4, '0');
begin
  select * into o from public.orders where id = p_order for update;
  if not (public.is_trusted() or public.is_ops_writer(o.city_id) or o.rider_id = auth.uid()) then raise exception 'Not allowed'; end if;
  perform public._sys(1);
  update public.orders set delivery_otp_hash = crypt(code, gen_salt('bf', 6)), pod_otp_attempts = 0 where id = o.id;
  perform public._sys(-1);
  insert into public.notifications (to_address, order_id, channel, template, payload)
  values (o.recipient_phone, o.id, 'sms', 'delivery_code', jsonb_build_object('code', code, 'tracking_number', o.tracking_number, 'resent', true));
end $$;

create or replace function public._check_delivery_code(o public.orders, p_code text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if o.pod_otp_verified_at is not null then return true; end if;
  if o.pod_otp_attempts >= 5 then raise exception 'Too many wrong codes. Ask dispatch for an override.'; end if;
  if o.delivery_otp_hash is null or crypt(trim(p_code), o.delivery_otp_hash) <> o.delivery_otp_hash then
    perform public._sys(1);
    update public.orders set pod_otp_attempts = pod_otp_attempts + 1 where id = o.id;
    perform public._sys(-1);
    return false;
  end if;
  perform public._sys(1);
  update public.orders set pod_otp_verified_at = now() where id = o.id;
  perform public._sys(-1);
  return true;
end $$;
revoke execute on function public._check_delivery_code(public.orders, text) from public, anon, authenticated;

-- ---------- photos and signatures (private bucket "pod": pod/<order id>/<file>) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pod', 'pod', false, 3145728, array['image/jpeg', 'image/png', 'image/svg+xml'])
on conflict (id) do nothing;

create or replace function public.can_see_order(p_order uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.orders o where o.id = p_order and (
    o.rider_id = auth.uid() or o.customer_id = auth.uid() or o.vendor_id in (select public.my_vendor_ids()) or public.is_ops(o.city_id)));
$$;
create policy pod_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'pod' and exists (select 1 from public.orders o where o.id::text = (storage.foldername(name))[1] and o.rider_id = (select auth.uid()))
);
create policy pod_read on storage.objects for select to authenticated using (
  bucket_id = 'pod' and public.can_see_order(((storage.foldername(name))[1])::uuid)
);

-- ---------- overrides when the recipient can't give the code ----------
create table public.pod_overrides (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id),
  rider_id     uuid not null references public.riders(id),
  reason       text not null,
  photo_path   text not null,
  status       public.review_status not null default 'pending',
  decided_by   uuid references public.profiles(id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create unique index pod_overrides_one_pending on public.pod_overrides (order_id) where status = 'pending';
alter table public.pod_overrides enable row level security;
create policy overrides_read on public.pod_overrides for select to authenticated using (
  rider_id = (select auth.uid()) or exists (select 1 from public.orders o where o.id = pod_overrides.order_id and public.is_ops(o.city_id))
);
create trigger audit_pod_overrides after insert or update on public.pod_overrides for each row execute function public.audit_row();

create or replace function public.decide_pod_override(p_override uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ov public.pod_overrides; o public.orders;
begin
  select * into ov from public.pod_overrides where id = p_override for update;
  select * into o from public.orders where id = ov.order_id;
  if not (public.is_trusted() or public.has_role(array['super_admin','city_admin','dispatcher','support']::public.app_role[], o.city_id)) then
    raise exception 'Only Support or a Dispatcher can approve an override';
  end if;
  if ov.status <> 'pending' then raise exception 'Already decided'; end if;
  update public.pod_overrides set status = case when p_approve then 'approved' else 'rejected' end::public.review_status, decided_by = auth.uid(), decided_at = now() where id = ov.id;
  if p_approve then
    perform public._sys(1);
    update public.orders set pod_override_by = auth.uid(), pod_override_note = ov.reason, pod_photo_path = ov.photo_path, pod_method = 'override' where id = o.id;
    perform public._sys(-1);
  end if;
  insert into public.notifications (user_id, channel, template, payload)
  values (ov.rider_id, 'push', case when p_approve then 'override_approved' else 'override_rejected' end, jsonb_build_object('order_id', o.id));
end $$;

-- ---------- COD must be recorded before a COD parcel is delivered ----------
create or replace function public.require_cod_before_delivery() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status in ('DELIVERED', 'COLLECTED') and old.status is distinct from new.status and new.cod_amount > 0
     and not exists (select 1 from public.cod_collections where order_id = new.id) then
    raise exception 'Record the GHS % cash collected before completing this delivery', to_char(new.cod_amount / 100.0, 'FM999,990.00');
  end if;
  return new;
end $$;
create trigger orders_require_cod before update of status on public.orders for each row execute function public.require_cod_before_delivery();

-- ---------- every rider action goes through one offline-safe door ----------
-- The phone gives each action a unique key. If the phone was offline and sends it twice,
-- the second time just returns the first result — nothing happens twice.
create table public.rider_action_log (
  key         uuid primary key,
  rider_id    uuid not null references public.riders(id),
  action      jsonb not null,
  result      jsonb,
  occurred_at timestamptz,
  received_at timestamptz not null default now()
);
create index rider_action_log_rider_idx on public.rider_action_log (rider_id, received_at desc);
alter table public.rider_action_log enable row level security;
create policy rider_log_read on public.rider_action_log for select to authenticated using (rider_id = (select auth.uid()) or public.is_ops());

-- p_action examples:
--   {"type":"status","order_id":"…","to":"PICKED_UP","lng":-0.2,"lat":5.6,"note":"…"}
--   {"type":"status","order_id":"…","to":"FAILED_ATTEMPT","reason":"recipient_unreachable"}
--   {"type":"code","order_id":"…","code":"4821"}                 -- delivery code
--   {"type":"pickup_code","order_id":"…","code":"…"}             -- high-value pickup (tracking number scan or code)
--   {"type":"pod","order_id":"…","signature_path":"…","photo_path":"…"}
--   {"type":"cod","order_id":"…","amount":35000,"method":"cash"}
--   {"type":"override","order_id":"…","reason":"…","photo_path":"…"}
create or replace function public.rider_action(p_key uuid, p_action jsonb, p_occurred_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); prior jsonb; o public.orders; res jsonb; t text := p_action ->> 'type'; ok boolean; due timestamptz;
begin
  if me is null or not exists (select 1 from public.riders where id = me and status = 'active') then raise exception 'Active riders only'; end if;
  select result into prior from public.rider_action_log where key = p_key and rider_id = me;
  if found then return coalesce(prior, '{}'::jsonb) || '{"replayed": true}'; end if;

  select * into o from public.orders where id = (p_action ->> 'order_id')::uuid for update;
  if not found or o.rider_id is distinct from me then raise exception 'This parcel is not on your job'; end if;

  if t = 'status' then
    if o.status = (p_action ->> 'to')::public.order_status then
      res := jsonb_build_object('ok', true, 'status', o.status, 'note', 'already done');
    else
      -- the phone's time can't be later than now, or more than 2 days old
      perform set_config('qcs.occurred_at', coalesce(least(greatest(p_occurred_at, now() - interval '2 days'), now())::text, ''), true);
      perform public.transition_order(o.id, (p_action ->> 'to')::public.order_status,
        nullif(p_action ->> 'lng', '')::float8, nullif(p_action ->> 'lat', '')::float8,
        p_action ->> 'note', p_action ->> 'photo_path', p_action ->> 'reason');
      perform set_config('qcs.occurred_at', '', true);
      res := jsonb_build_object('ok', true, 'status', p_action ->> 'to');
    end if;

  elsif t = 'code' then
    ok := public._check_delivery_code(o, p_action ->> 'code');
    res := jsonb_build_object('ok', ok, 'attempts_left', greatest(0, 5 - (select pod_otp_attempts from public.orders where id = o.id)));

  elsif t = 'pickup_code' then
    ok := upper(trim(p_action ->> 'code')) = o.tracking_number;
    if ok then
      perform public._sys(1);
      update public.orders set pickup_verified_at = now() where id = o.id;
      perform public._sys(-1);
    end if;
    res := jsonb_build_object('ok', ok);

  elsif t = 'pod' then
    if coalesce(p_action ->> 'signature_path', p_action ->> 'photo_path') is null then raise exception 'Nothing to save'; end if;
    perform public._sys(1);
    update public.orders set pod_signature_path = coalesce(p_action ->> 'signature_path', pod_signature_path),
                             pod_photo_path = coalesce(p_action ->> 'photo_path', pod_photo_path), pod_method = coalesce(pod_method, 'app')
     where id = o.id;
    perform public._sys(-1);
    res := jsonb_build_object('ok', true);

  elsif t = 'cod' then
    if o.cod_amount = 0 then raise exception 'This parcel has no cash to collect'; end if;
    if (p_action ->> 'amount')::bigint <> o.cod_amount then
      raise exception 'Collect exactly GHS % (or report a failed attempt: "no cash")', to_char(o.cod_amount / 100.0, 'FM999,990.00');
    end if;
    due := ((now() at time zone 'Africa/Accra')::date + 1)::timestamp at time zone 'Africa/Accra' - interval '1 minute';   -- end of today, Accra
    perform public._sys(1);   -- the COD float on the rider is updated by the system
    insert into public.cod_collections (order_id, rider_id, vendor_id, city_id, amount, remit_due_by)
    values (o.id, me, o.vendor_id, o.city_id, o.cod_amount, due) on conflict (order_id) do nothing;
    perform public._sys(-1);
    res := jsonb_build_object('ok', true, 'remit_by', due);

  elsif t = 'override' then
    if coalesce(trim(p_action ->> 'reason'), '') = '' or coalesce(p_action ->> 'photo_path', '') = '' then
      raise exception 'An override needs a reason and a photo';
    end if;
    insert into public.pod_overrides (order_id, rider_id, reason, photo_path) values (o.id, me, p_action ->> 'reason', p_action ->> 'photo_path')
    on conflict do nothing;
    insert into public.notifications (user_id, channel, template, payload)
    select distinct ur.user_id, 'push'::public.notification_channel, 'override_requested', jsonb_build_object('order_id', o.id, 'tracking_number', o.tracking_number)
    from public.user_roles ur where ur.role in ('dispatcher', 'support') and (ur.city_id = o.city_id or ur.city_id is null);
    res := jsonb_build_object('ok', true, 'status', 'override_requested');

  else
    raise exception 'Unknown action %', t;
  end if;

  insert into public.rider_action_log (key, rider_id, action, result, occurred_at) values (p_key, me, p_action, res, p_occurred_at);
  return res;
end $$;
revoke execute on function public.rider_action(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.rider_action(uuid, jsonb, timestamptz) to authenticated;

-- ---------- WhatsApp backup: "DELIVERED <tracking no> <code>" ----------
-- Called by the whatsapp-webhook function after it has checked Meta's signature.
-- The rider is recognised by their WhatsApp number. No signature can be captured on WhatsApp,
-- so these deliveries are flagged for review (CLAUDE.md §8 asks for code + signature).
create or replace function public.whatsapp_rider_command(p_phone text, p_text text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  parts text[] := regexp_split_to_array(upper(trim(regexp_replace(p_text, '\s+', ' ', 'g'))), ' ');
  cmd text := parts[1]; tn text := parts[2]; code text := parts[3];
  rid uuid; o public.orders; far boolean; r public.riders;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select rd.* into r from public.riders rd join public.profiles p on p.id = rd.id
   where p.phone = '+' || regexp_replace(p_phone, '\D', '', 'g') and rd.status = 'active';
  if r.id is null then return 'This number is not registered as an active QCS rider.'; end if;
  if cmd not in ('DELIVERED', 'HELP') or (cmd = 'DELIVERED' and (tn is null or code is null)) then
    return 'Send: DELIVERED <tracking number> <4-digit code>   e.g. DELIVERED ACC-202611041301-KUM 4821';
  end if;
  if cmd = 'HELP' then return 'Send: DELIVERED <tracking number> <4-digit code>. Use the app whenever you have data.'; end if;

  select * into o from public.orders where tracking_number = tn for update;
  if not found or o.rider_id is distinct from r.id then return format('Parcel %s is not on your job.', tn); end if;
  if o.status = 'DELIVERED' then return format('%s is already delivered ✓', tn); end if;
  if o.status not in ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ARRIVED_AT_DROPOFF') then return format('%s can''t be delivered from status %s.', tn, o.status); end if;

  if not public._check_delivery_code(o, code) then
    return format('Wrong code for %s. %s tries left.', tn, greatest(0, 5 - (select pod_otp_attempts from public.orders where id = o.id)));
  end if;

  far := r.last_location is null or r.last_location_at < now() - interval '10 minutes'
         or st_distance(r.last_location, o.dropoff_location) > coalesce((public.get_setting('geofence_radius_m', o.city_id))::numeric, 3000);
  perform public._sys(1);
  update public.orders set pod_method = 'whatsapp',
         pod_flagged = 'Delivered by WhatsApp backup: no signature' || case when far then '; rider location unknown or far from drop-off' else '' end,
         pod_override_by = r.id, pod_override_note = 'WhatsApp backup', pod_photo_path = coalesce(pod_photo_path, 'whatsapp-backup')
   where id = o.id;
  if o.cod_amount > 0 then
    insert into public.cod_collections (order_id, rider_id, vendor_id, city_id, amount, remit_due_by)
    values (o.id, r.id, o.vendor_id, o.city_id, o.cod_amount, ((now() at time zone 'Africa/Accra')::date + 1)::timestamp at time zone 'Africa/Accra' - interval '1 minute')
    on conflict (order_id) do nothing;
  end if;
  if o.status <> 'ARRIVED_AT_DROPOFF' then
    perform public.transition_order(o.id, 'ARRIVED_AT_DROPOFF', null, null, 'WhatsApp backup', null, null);
  end if;
  perform public.transition_order(o.id, 'DELIVERED', null, null, 'Delivered via WhatsApp backup', null, null);
  perform public._sys(-1);
  return format('%s delivered ✓%s', tn, case when o.cod_amount > 0 then format(' Cash GHS %s recorded — remit by end of day.', to_char(o.cod_amount / 100.0, 'FM999,990.00')) else '' end);
end $$;
revoke execute on function public.whatsapp_rider_command(text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_rider_command(text, text) to service_role;

revoke execute on function public.decide_pod_override(uuid, boolean), public.resend_delivery_code(uuid) from public, anon;
grant execute on function public.decide_pod_override(uuid, boolean), public.resend_delivery_code(uuid) to authenticated;
