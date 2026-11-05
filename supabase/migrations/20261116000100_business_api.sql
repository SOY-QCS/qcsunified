-- =====================================================================
-- Phase 11 — Business API & integrations
--   1. API keys (test + live; shown once, stored as a SHA-256 hash), request log, rate limit, idempotency
--   2. The delivery object every API answer and webhook uses
--   3. Get / list / cancel for the API (service server only)
--   4. Test mode: practice deliveries that never reach dispatch, riders or money
--   5. Webhooks: endpoints (test/live), signed deliveries with retries, auto-disable after repeated failures
--   6. Shopify shops connected to vendors (tokens in a table no app can read)
-- =====================================================================

insert into public.app_settings (key, value, description) values
  ('api_rate_per_minute',   '120', 'Business API: requests per minute per API key'),
  ('api_max_keys',          '10',  'Business API: active keys per business'),
  ('webhook_disable_after', '10',  'Webhooks: turn an endpoint off after this many messages in a row failed every retry')
on conflict do nothing;

-- orders: where the booking came from (app, portal, api, woocommerce, shopify)
alter table public.orders add column source text;

-- ---------- 1. API keys ----------
alter table public.api_keys add column mode text not null default 'live' check (mode in ('live', 'test'));
create index api_keys_vendor_idx on public.api_keys (vendor_id) where revoked_at is null;
-- keys are made and revoked through the functions below only
drop policy if exists api_keys_vendor_revoke on public.api_keys;

/** Make a key. The full key is returned ONCE; only its hash is kept. Live keys need a verified business (ID check). */
create or replace function public.create_api_key(p_vendor uuid, p_name text, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v public.vendors; k text; kid uuid;
begin
  select * into v from public.vendors where id = p_vendor;
  perform public._need(found and p_vendor in (select public.my_vendor_ids('api')), 'You don''t have API access for this business');
  perform public._need(p_mode in ('live', 'test'), 'Choose test or live');
  perform public._need(length(coalesce(trim(p_name), '')) between 2 and 60, 'Give the key a name (e.g. "My shop website")');
  perform public._need(p_mode = 'test' or v.kyc_status = 'approved', 'Live keys are available once QCS has verified your business ID. Use a test key meanwhile.');
  perform public._need((select count(*) from public.api_keys where vendor_id = p_vendor and revoked_at is null) < public.setting_int('api_max_keys', 10),
                       'You have too many active keys. Revoke one you no longer use.');
  k := 'qcs_' || p_mode || '_' || encode(gen_random_bytes(24), 'hex');
  insert into public.api_keys (vendor_id, name, key_prefix, key_hash, mode, created_by)
  values (p_vendor, trim(p_name), left(k, 14), encode(digest(k, 'sha256'), 'hex'), p_mode, auth.uid()) returning id into kid;
  return jsonb_build_object('id', kid, 'key', k, 'prefix', left(k, 14), 'mode', p_mode);
end $$;

create or replace function public.revoke_api_key(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.api_keys set revoked_at = now()
   where id = p_id and revoked_at is null and vendor_id in (select public.my_vendor_ids('api'));
  perform public._need(found, 'Key not found (or already revoked)');
end $$;

-- Request log (the portal's "API logs"), kept 30 days.
create table public.api_requests (
  id              bigint generated always as identity primary key,
  key_id          uuid references public.api_keys(id) on delete set null,
  vendor_id       uuid references public.vendors(id) on delete cascade,
  mode            text,
  method          text not null,
  path            text not null,
  status          smallint,
  duration_ms     integer,
  error           text,
  reference       text,               -- tracking number or the vendor's order number, when there is one
  ip              text,
  created_at      timestamptz not null default now()
);
create index api_requests_vendor_idx on public.api_requests (vendor_id, created_at desc);
create index api_requests_key_recent_idx on public.api_requests (key_id, created_at);
alter table public.api_requests enable row level security;
create policy api_requests_vendor on public.api_requests for select to authenticated
  using (vendor_id in (select public.my_vendor_ids('api')) or public.has_role(array['super_admin']::public.app_role[]));

/**
 * Start of every API call (booking server only): checks the key, the rate limit, logs the request.
 * Returns {ok, key_id, vendor_id, mode, owner_id, log_id} or {ok:false, status, error}.
 */
create or replace function public.api_begin(p_hash text, p_method text, p_path text, p_ip text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k public.api_keys; v public.vendors; n int; lid bigint; lim int := public.setting_int('api_rate_per_minute', 120);
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select * into k from public.api_keys where key_hash = p_hash;
  if not found or k.revoked_at is not null then
    return jsonb_build_object('ok', false, 'status', 401, 'error', case when found then 'This API key was revoked' else 'Invalid API key' end);
  end if;
  select * into v from public.vendors where id = k.vendor_id;
  select count(*) into n from public.api_requests where key_id = k.id and created_at > now() - interval '1 minute';
  insert into public.api_requests (key_id, vendor_id, mode, method, path, ip, status, error)
  values (k.id, k.vendor_id, k.mode, left(p_method, 10), left(p_path, 200), left(p_ip, 64),
          case when n >= lim then 429 end, case when n >= lim then 'rate limited' end)
  returning id into lid;
  update public.api_keys set last_used_at = now() where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  if n >= lim then
    return jsonb_build_object('ok', false, 'status', 429, 'error', format('Too many requests: %s per minute per key. Slow down and retry.', lim));
  end if;
  return jsonb_build_object('ok', true, 'key_id', k.id, 'vendor_id', k.vendor_id, 'mode', k.mode, 'owner_id', v.owner_id,
                            'account_type', v.account_type, 'log_id', lid, 'default_pickup_address_id', v.default_pickup_address_id,
                            'business_name', v.business_name);
end $$;

create or replace function public.api_end(p_log bigint, p_status int, p_ms int, p_error text default null, p_reference text default null) returns void
language sql security definer set search_path = public, extensions as $$
  update public.api_requests set status = coalesce(status, p_status), duration_ms = p_ms, error = coalesce(error, left(p_error, 500)),
         reference = left(p_reference, 80)
   where id = p_log and public.is_trusted();
$$;

-- Idempotency: the same Idempotency-Key within 24 h returns the first answer instead of booking twice.
create table public.api_idempotency (
  vendor_id    uuid not null references public.vendors(id) on delete cascade,
  mode         text not null,
  idem_key     text not null,
  request_hash text not null,
  status_code  smallint,
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (vendor_id, mode, idem_key)
);
alter table public.api_idempotency enable row level security;   -- server only (no policies)

/** Claim an idempotency key. Returns null = go ahead; {status, response} = replay; {conflict} = same key, different request. */
create or replace function public.api_idem_claim(p_vendor uuid, p_mode text, p_key text, p_hash text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r public.api_idempotency;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  delete from public.api_idempotency where vendor_id = p_vendor and mode = p_mode and idem_key = p_key and created_at < now() - interval '24 hours';
  insert into public.api_idempotency (vendor_id, mode, idem_key, request_hash) values (p_vendor, p_mode, left(p_key, 200), p_hash)
  on conflict do nothing;
  if found then return null; end if;
  select * into r from public.api_idempotency where vendor_id = p_vendor and mode = p_mode and idem_key = left(p_key, 200);
  if r.request_hash <> p_hash then return jsonb_build_object('conflict', true); end if;
  if r.status_code is null then return jsonb_build_object('in_progress', true); end if;
  return jsonb_build_object('status', r.status_code, 'response', r.response);
end $$;

create or replace function public.api_idem_save(p_vendor uuid, p_mode text, p_key text, p_status int, p_response jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  if p_status >= 400 then   -- not booked (bad details, server trouble): the caller may fix it and retry with the same key.
                            -- Doubles are still impossible: the order number (reference) is unique per business.
    delete from public.api_idempotency where vendor_id = p_vendor and mode = p_mode and idem_key = left(p_key, 200);
  else
    update public.api_idempotency set status_code = p_status, response = p_response where vendor_id = p_vendor and mode = p_mode and idem_key = left(p_key, 200);
  end if;
end $$;

-- ---------- 2. the delivery object ----------
create or replace function public._status_text(s text) returns text language sql immutable as $$
  select case s
    when 'DRAFT' then 'Draft' when 'PENDING_PAYMENT' then 'Waiting for payment' when 'CONFIRMED' then 'Booked'
    when 'SEARCHING_RIDER' then 'Finding a rider' when 'ASSIGNED' then 'Rider assigned' when 'RIDER_AT_PICKUP' then 'Rider at pickup'
    when 'PICKED_UP' then 'Picked up' when 'IN_TRANSIT' then 'On the way' when 'AT_HUB' then 'At QCS hub'
    when 'DEPARTED_HUB' then 'On the bus to the destination city' when 'ARRIVED_DEST_HUB' then 'Arrived at destination hub'
    when 'READY_FOR_COLLECTION' then 'Ready for collection' when 'COLLECTED' then 'Collected' when 'OUT_FOR_DELIVERY' then 'Out for delivery'
    when 'ARRIVED_AT_DROPOFF' then 'Rider has arrived' when 'DELIVERED' then 'Delivered' when 'CANCELLED' then 'Cancelled'
    when 'FAILED_ATTEMPT' then 'Delivery attempt failed' when 'RESCHEDULED' then 'Rescheduled' when 'RETURNING_TO_SENDER' then 'Returning to sender'
    when 'RETURNED' then 'Returned to sender' when 'LOST' then 'Lost' when 'DAMAGED' then 'Damaged' else s end;
$$;

/** What the API and webhooks say about one delivery. Never includes delivery codes or internal notes. */
create or replace function public.api_delivery(p_order uuid, p_events boolean default false) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'tracking_number', o.tracking_number,
    'reference', o.external_ref,
    'livemode', true,
    'service', o.service_type,
    'intercity_option', o.intercity_option,
    'status', o.status,
    'status_text', public._status_text(o.status::text),
    'fee', jsonb_build_object('amount', o.quoted_fee + coalesce(o.extra_fee, 0) + coalesce(o.insurance_premium, 0), 'currency', 'GHS'),
    'cod_amount', o.cod_amount,
    'payer', o.payer,
    'pickup', jsonb_build_object('address', o.pickup_address_text, 'contact_name', o.pickup_contact_name, 'contact_phone', o.pickup_contact_phone),
    'dropoff', jsonb_build_object('address', o.dropoff_address_text, 'landmark', o.dropoff_landmark, 'ghana_post_gps', o.dropoff_ghana_post_gps,
                                  'contact_name', o.recipient_name, 'contact_phone', o.recipient_phone,
                                  'lat', round(st_y(o.dropoff_location::geometry)::numeric, 6), 'lng', round(st_x(o.dropoff_location::geometry)::numeric, 6)),
    'weight_g', o.weight_g,
    'address_confirmed', o.address_confirmation = 'confirmed',
    'rider', (select jsonb_build_object('first_name', split_part(p.full_name, ' ', 1), 'phone', p.phone)
                from public.profiles p where p.id = o.rider_id
                 and o.status in ('ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','ARRIVED_AT_DROPOFF')),
    'tracking_url', rtrim(public._setting('public_site_url', '"https://qcsghana.com"') #>> '{}', '/') || '/track/' || o.tracking_number,
    'source', o.source,
    'created_at', o.created_at,
    'delivered_at', o.delivered_at,
    'events', case when p_events then (select coalesce(jsonb_agg(jsonb_build_object('status', e.to_status, 'status_text', public._status_text(e.to_status::text),
                     'at', coalesce(e.occurred_at, e.created_at), 'reason', e.reason) order by e.id), '[]'::jsonb)
                from public.order_events e where e.order_id = o.id and e.to_status <> 'DRAFT') end)
  from public.orders o where o.id = p_order;
$$;

-- ---------- 3. get / list / cancel (booking server only; it already checked the key) ----------
create or replace function public.api_get_delivery(p_vendor uuid, p_tracking text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare oid uuid;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select id into oid from public.orders where vendor_id = p_vendor and tracking_number = upper(trim(p_tracking)) and status <> 'DRAFT';
  if oid is null then   -- also accept the vendor's own order number
    select id into oid from public.orders where vendor_id = p_vendor and external_ref = trim(p_tracking) and status <> 'DRAFT' order by created_at desc limit 1;
  end if;
  return case when oid is null then null else public.api_delivery(oid, true) end;
end $$;

/** Newest first, paged with `before` (the created_at of the last item of the previous page). */
create or replace function public.api_list_deliveries(p_vendor uuid, p_status text default null, p_from timestamptz default null, p_to timestamptz default null,
                                                     p_reference text default null, p_limit int default 50, p_before timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare lim int := least(greatest(coalesce(p_limit, 50), 1), 100); rows jsonb;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select coalesce(jsonb_agg(public.api_delivery(x.id) order by x.created_at desc), '[]'::jsonb) into rows
  from (select id, created_at from public.orders
         where vendor_id = p_vendor and status <> 'DRAFT'
           and (p_status is null or status::text = any (string_to_array(upper(p_status), ',')))
           and (p_from is null or created_at >= p_from) and (p_to is null or created_at < p_to)
           and (p_reference is null or external_ref = p_reference)
           and (p_before is null or created_at < p_before)
         order by created_at desc limit lim + 1) x;
  return jsonb_build_object('data', (select coalesce(jsonb_agg(e), '[]') from (select e from jsonb_array_elements(rows) e limit lim) y),
                            'has_more', jsonb_array_length(rows) > lim,
                            'next_before', case when jsonb_array_length(rows) > lim then rows -> (lim - 1) ->> 'created_at' end);
end $$;

/** Cancel through the API: the same rule as in the app (before the rider has the parcel). Refunds follow automatically. */
create or replace function public.api_cancel_delivery(p_vendor uuid, p_tracking text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select * into o from public.orders where vendor_id = p_vendor and (tracking_number = upper(trim(p_tracking)) or external_ref = trim(p_tracking))
   and status <> 'DRAFT' order by created_at desc limit 1;
  perform public._need(found, 'Delivery not found');
  perform public._need(o.status in ('PENDING_PAYMENT', 'CONFIRMED', 'SEARCHING_RIDER', 'ASSIGNED'),
    format('Can''t cancel: the delivery is already "%s". Contact QCS support if it must be stopped.', public._status_text(o.status::text)));
  perform public.transition_order(o.id, 'CANCELLED', null, null, left('Cancelled via API' || coalesce(': ' || nullif(trim(p_reason), ''), ''), 300), null, 'api_cancel');
  return public.api_delivery(o.id, true);
end $$;

/** After create_booking: remember where the booking came from. */
create or replace function public.api_mark_source(p_quote uuid, p_source text) returns void
language sql security definer set search_path = public, extensions as $$
  update public.orders set source = p_source where quote_id = p_quote and public.is_trusted()
    and p_source in ('api', 'woocommerce', 'shopify');
$$;

-- ---------- 4. test mode ----------
create table public.api_test_deliveries (
  id              uuid primary key default gen_random_uuid(),
  vendor_id       uuid not null references public.vendors(id) on delete cascade,
  tracking_number text not null unique,
  reference       text,
  status          text not null default 'CONFIRMED',
  data            jsonb not null,         -- the delivery object (same shape as live)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index api_test_vendor_idx on public.api_test_deliveries (vendor_id, created_at desc);
alter table public.api_test_deliveries enable row level security;
create policy api_test_vendor on public.api_test_deliveries for select to authenticated using (vendor_id in (select public.my_vendor_ids('api')));

/** Store a practice delivery. p_data is the delivery object the server built from the (real) price. */
create or replace function public.api_test_create(p_vendor uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare tn text; d jsonb; t timestamptz := now();
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  if nullif(p_data ->> 'reference', '') is not null and exists (select 1 from public.api_test_deliveries where vendor_id = p_vendor and reference = p_data ->> 'reference') then
    raise exception 'Order number(s) already booked: %', p_data ->> 'reference';
  end if;
  tn := 'TEST-' || upper(encode(gen_random_bytes(5), 'hex'));
  d := p_data || jsonb_build_object('tracking_number', tn, 'livemode', false, 'status', 'CONFIRMED', 'status_text', 'Booked', 'created_at', t,
         'delivered_at', null, 'rider', null, 'address_confirmed', false,
         'tracking_url', rtrim(public._setting('public_site_url', '"https://qcsghana.com"') #>> '{}', '/') || '/track/' || tn,
         'events', jsonb_build_array(jsonb_build_object('status', 'CONFIRMED', 'status_text', 'Booked', 'at', t, 'reason', null)));
  insert into public.api_test_deliveries (vendor_id, tracking_number, reference, data) values (p_vendor, tn, nullif(p_data ->> 'reference', ''), d);
  perform public._webhook_event(p_vendor, 'test', 'delivery.created', d);
  return d;
end $$;

create or replace function public.api_test_get(p_vendor uuid, p_tracking text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select data from public.api_test_deliveries
   where public.is_trusted() and vendor_id = p_vendor and (tracking_number = upper(trim(p_tracking)) or reference = trim(p_tracking))
   order by created_at desc limit 1;
$$;

create or replace function public.api_test_list(p_vendor uuid, p_status text default null, p_reference text default null, p_limit int default 50, p_before timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare lim int := least(greatest(coalesce(p_limit, 50), 1), 100); rows jsonb;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select coalesce(jsonb_agg(x.data - 'events' order by x.created_at desc), '[]'::jsonb) into rows
  from (select data, created_at from public.api_test_deliveries
         where vendor_id = p_vendor and (p_status is null or status = any (string_to_array(upper(p_status), ',')))
           and (p_reference is null or reference = p_reference) and (p_before is null or created_at < p_before)
         order by created_at desc limit lim + 1) x;
  return jsonb_build_object('data', (select coalesce(jsonb_agg(e), '[]') from (select e from jsonb_array_elements(rows) e limit lim) y),
                            'has_more', jsonb_array_length(rows) > lim,
                            'next_before', case when jsonb_array_length(rows) > lim then rows -> (lim - 1) ->> 'created_at' end);
end $$;

/** Move a practice delivery to another status (any order is allowed) and send the webhook — to try your integration. */
create or replace function public.api_test_transition(p_vendor uuid, p_tracking text, p_to text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t public.api_test_deliveries; d jsonb; at timestamptz := now(); prev text;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select * into t from public.api_test_deliveries where vendor_id = p_vendor and (tracking_number = upper(trim(p_tracking)) or reference = trim(p_tracking))
   order by created_at desc limit 1 for update;
  perform public._need(found, 'Delivery not found');
  perform public._need(upper(p_to) in (select unnest(enum_range(null::public.order_status))::text) and upper(p_to) not in ('DRAFT', 'PENDING_PAYMENT'), 'Unknown status');
  perform public._need(t.status not in ('DELIVERED', 'COLLECTED', 'CANCELLED', 'RETURNED'), 'This practice delivery is finished. Create a new one.');
  perform public._need(upper(p_to) <> 'FAILED_ATTEMPT' or coalesce(trim(p_reason), '') <> '', 'A failed attempt needs a reason (e.g. recipient_unreachable)');
  prev := t.status;
  d := t.data || jsonb_build_object('status', upper(p_to), 'status_text', public._status_text(upper(p_to)),
         'delivered_at', case when upper(p_to) in ('DELIVERED', 'COLLECTED') then to_jsonb(at) else t.data -> 'delivered_at' end,
         'rider', case when upper(p_to) in ('ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','ARRIVED_AT_DROPOFF')
                       then '{"first_name":"Test","phone":"+233200000000"}'::jsonb end,
         'events', coalesce(t.data -> 'events', '[]') || jsonb_build_array(jsonb_build_object('status', upper(p_to), 'status_text', public._status_text(upper(p_to)), 'at', at, 'reason', p_reason)));
  update public.api_test_deliveries set status = upper(p_to), data = d, updated_at = at where id = t.id;
  perform public._webhook_event(p_vendor, 'test', 'delivery.status_changed', (d - 'events') || jsonb_build_object('previous_status', prev, 'reason', p_reason));
  return d;
end $$;

create or replace function public.api_test_cancel(p_vendor uuid, p_tracking text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare st text;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select status into st from public.api_test_deliveries where vendor_id = p_vendor and (tracking_number = upper(trim(p_tracking)) or reference = trim(p_tracking))
   order by created_at desc limit 1;
  perform public._need(st is not null, 'Delivery not found');
  perform public._need(st in ('CONFIRMED', 'SEARCHING_RIDER', 'ASSIGNED'), format('Can''t cancel: the delivery is already "%s". Contact QCS support if it must be stopped.', public._status_text(st)));
  return public.api_test_transition(p_vendor, p_tracking, 'CANCELLED', coalesce(nullif(trim(p_reason), ''), 'api_cancel'));
end $$;

-- ---------- 5. webhooks ----------
alter table public.webhooks
  add column mode            text not null default 'live' check (mode in ('live', 'test')),
  add column description     text,
  add column failure_streak  integer not null default 0,
  add column disabled_reason text,
  add column last_success_at timestamptz,
  add column updated_at      timestamptz not null default now();
alter table public.webhooks alter column secret set default 'whsec_' || encode(gen_random_bytes(24), 'hex');
alter table public.webhooks alter column events set default '{*}';
update public.webhooks set secret = 'whsec_' || secret where secret not like 'whsec_%';

/** Webhook addresses must be public https URLs (never our own servers or private networks). */
create or replace function public.check_webhook() returns trigger language plpgsql as $$
declare host text := lower(substring(new.url from '^https://([^/:?#]+)'));
begin
  if host is null or length(new.url) > 500 then raise exception 'The webhook URL must start with https://'; end if;
  if host in ('localhost') or host like '%.local' or host like '%.internal' or host like '%.localhost'
     or host ~ '^\d+\.\d+\.\d+\.\d+$' or host like '[%' or host like '%supabase.co' or host like '%.qcsghana.com' then
    raise exception 'Use your public website address (a domain name), not an IP address or internal host';
  end if;
  if not new.events <@ array['*', 'delivery.created', 'delivery.status_changed'] or cardinality(new.events) = 0 then
    raise exception 'Unknown webhook event. Use delivery.created, delivery.status_changed or *';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.webhooks where vendor_id = new.vendor_id) >= 5 then
    raise exception 'At most 5 webhook endpoints per business';
  end if;
  if tg_op = 'UPDATE' and new.is_active and not old.is_active then new.failure_streak := 0; new.disabled_reason := null; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger webhooks_check before insert or update on public.webhooks for each row execute function public.check_webhook();

create or replace function public.rotate_webhook_secret(p_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s text := 'whsec_' || encode(gen_random_bytes(24), 'hex');
begin
  update public.webhooks set secret = s where id = p_id and vendor_id in (select public.my_vendor_ids('api'));
  perform public._need(found, 'Webhook not found');
  return s;
end $$;

create table public.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  webhook_id       uuid not null references public.webhooks(id) on delete cascade,
  vendor_id        uuid not null references public.vendors(id) on delete cascade,
  mode             text not null,
  event_type       text not null,
  payload          jsonb not null,
  status           text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts         smallint not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_status_code smallint,
  last_error       text,
  last_response    text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at) where status in ('queued', 'sending');
create index webhook_deliveries_vendor_idx on public.webhook_deliveries (vendor_id, created_at desc);
alter table public.webhook_deliveries enable row level security;
create policy webhook_deliveries_vendor on public.webhook_deliveries for select to authenticated
  using (vendor_id in (select public.my_vendor_ids('api')) or public.has_role(array['super_admin']::public.app_role[]));

/** Queue one event for every active endpoint of this business (in this mode) that wants it. */
create or replace function public._webhook_event(p_vendor uuid, p_mode text, p_type text, p_data jsonb) returns void
language sql security definer set search_path = public, extensions as $$
  insert into public.webhook_deliveries (webhook_id, vendor_id, mode, event_type, payload)
  select w.id, w.vendor_id, w.mode, p_type,
         jsonb_build_object('id', 'evt_' || replace(gen_random_uuid()::text, '-', ''), 'type', p_type, 'created_at', now(),
                            'livemode', p_mode = 'live', 'data', p_data)
  from public.webhooks w
  where w.vendor_id = p_vendor and w.mode = p_mode and w.is_active and ('*' = any (w.events) or p_type = any (w.events));
$$;

/** Every status change of a business's delivery goes to its live webhooks (§7). */
create or replace function public.webhook_on_event() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid; d jsonb;
begin
  select vendor_id into v from public.orders where id = new.order_id;
  if v is null or not exists (select 1 from public.webhooks where vendor_id = v and mode = 'live' and is_active) then return null; end if;
  if new.to_status = 'DRAFT' then return null; end if;
  d := public.api_delivery(new.order_id);
  if new.from_status is null or new.from_status = 'DRAFT' then
    perform public._webhook_event(v, 'live', 'delivery.created', d);
  end if;
  perform public._webhook_event(v, 'live', 'delivery.status_changed',
    d || jsonb_build_object('status', new.to_status, 'status_text', public._status_text(new.to_status::text),
                            'previous_status', nullif(new.from_status, 'DRAFT'), 'reason', new.reason, 'changed_at', coalesce(new.occurred_at, new.created_at)));
  return null;
end $$;
create trigger order_events_webhooks after insert on public.order_events for each row execute function public.webhook_on_event();

/** The sender (Edge Function) takes due messages with their endpoint URL and secret. */
create or replace function public.claim_webhooks(p_limit int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare d record;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  for d in
    select wd.*, w.url, w.secret, w.is_active from public.webhook_deliveries wd join public.webhooks w on w.id = wd.webhook_id
     where (wd.status = 'queued' and wd.next_attempt_at <= now()) or (wd.status = 'sending' and wd.next_attempt_at < now() - interval '2 minutes')
     order by wd.next_attempt_at limit p_limit for update of wd skip locked
  loop
    if not d.is_active then
      update public.webhook_deliveries set status = 'failed', last_error = 'endpoint turned off' where id = d.id; continue;
    end if;
    update public.webhook_deliveries set status = 'sending', attempts = attempts + 1, next_attempt_at = now() where id = d.id;
    return next jsonb_build_object('id', d.id, 'url', d.url, 'secret', d.secret, 'event_type', d.event_type, 'payload', d.payload, 'attempt', d.attempts + 1);
  end loop;
end $$;

/**
 * Result of one attempt. Failures retry after 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, 24 h (≈ 2 days in all).
 * After `webhook_disable_after` messages in a row fail every retry, the endpoint is turned off and the business is told.
 */
create or replace function public.finish_webhook(p_id uuid, p_ok boolean, p_status int default null, p_error text default null, p_response text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare d public.webhook_deliveries; w public.webhooks; delays int[] := array[1, 5, 15, 60, 180, 360, 720, 1440]; owner uuid;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select * into d from public.webhook_deliveries where id = p_id for update;
  if not found then return; end if;
  if p_ok then
    update public.webhook_deliveries set status = 'sent', sent_at = now(), last_status_code = p_status, last_error = null, last_response = left(p_response, 500) where id = p_id;
    update public.webhooks set failure_streak = 0, last_success_at = now() where id = d.webhook_id;
    return;
  end if;
  if d.attempts <= array_length(delays, 1) then
    update public.webhook_deliveries set status = 'queued', next_attempt_at = now() + make_interval(mins => delays[d.attempts]),
           last_status_code = p_status, last_error = left(p_error, 300), last_response = left(p_response, 500) where id = p_id;
    return;
  end if;
  update public.webhook_deliveries set status = 'failed', last_status_code = p_status, last_error = left(p_error, 300), last_response = left(p_response, 500) where id = p_id;
  update public.webhooks set failure_streak = failure_streak + 1 where id = d.webhook_id returning * into w;
  if w.is_active and w.failure_streak >= public.setting_int('webhook_disable_after', 10) then
    update public.webhooks set is_active = false, disabled_reason = format('%s messages in a row could not be delivered (last error: %s)', w.failure_streak, coalesce(left(p_error, 120), 'HTTP ' || p_status))
     where id = w.id;
    select owner_id into owner from public.vendors where id = w.vendor_id;
    perform public._enqueue(owner, null, null, 'webhook_disabled', jsonb_build_object('url', w.url, 'mode', w.mode, 'error', coalesce(left(p_error, 120), 'HTTP ' || p_status)));
  end if;
end $$;

/** Portal: send a message again (e.g. after fixing the endpoint). */
create or replace function public.resend_webhook(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.webhook_deliveries set status = 'queued', next_attempt_at = now(), attempts = 0
   where id = p_id and vendor_id in (select public.my_vendor_ids('api')) and status in ('sent', 'failed');
  perform public._need(found, 'Message not found');
end $$;

/** Portal "Send test event": a ping to one endpoint, through the normal queue. */
create or replace function public.ping_webhook(p_id uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare w public.webhooks; nid uuid;
begin
  select * into w from public.webhooks where id = p_id and vendor_id in (select public.my_vendor_ids('api'));
  perform public._need(found, 'Webhook not found');
  insert into public.webhook_deliveries (webhook_id, vendor_id, mode, event_type, payload)
  values (w.id, w.vendor_id, w.mode, 'ping', jsonb_build_object('id', 'evt_' || replace(gen_random_uuid()::text, '-', ''), 'type', 'ping',
          'created_at', now(), 'livemode', w.mode = 'live', 'data', jsonb_build_object('message', 'Hello from QCS. Your webhook works.')))
  returning id into nid;
  return nid;
end $$;

insert into public.notification_templates (key, channel, audience, subject, body, wa_template, essential, description) values
  ('webhook_disabled', 'email', 'any', 'QCS: your webhook was turned off',
   'Hello,\n\nWe could not deliver delivery updates to {{url}} ({{mode}} mode) for a long time, so we turned this webhook off.\nLast error: {{error}}\n\nFix the address, then turn it back on in the QCS business portal (Developers → Webhooks). Messages from the last 2 days can be re-sent from there.\n\nQCS', null, true, 'Business API: webhook turned off after repeated failures'),
  ('webhook_disabled', 'push', 'any', 'Webhook turned off', 'We could not reach {{url}}. Fix it in Developers → Webhooks.', null, true, 'Business API: webhook turned off')
on conflict do nothing;

-- ---------- 6. Shopify ----------
create table public.shopify_shops (
  shop          text primary key check (shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  vendor_id     uuid not null references public.vendors(id) on delete cascade,
  rates_token   text not null unique default encode(gen_random_bytes(16), 'hex'),   -- identifies the shop in Shopify's rate calls
  service       text not null default 'ecommerce' check (service in ('ecommerce', 'express')),
  auto_create   boolean not null default true,
  carrier_service_id bigint,
  scopes        text,
  connected_by  uuid references public.profiles(id),
  installed_at  timestamptz not null default now(),
  uninstalled_at timestamptz,
  last_error    text
);
create index shopify_shops_vendor_idx on public.shopify_shops (vendor_id);
alter table public.shopify_shops enable row level security;
create policy shopify_vendor_read on public.shopify_shops for select to authenticated using (vendor_id in (select public.my_vendor_ids('api')));
create policy shopify_vendor_update on public.shopify_shops for update to authenticated
  using (vendor_id in (select public.my_vendor_ids('api'))) with check (vendor_id in (select public.my_vendor_ids('api')));
create trigger audit_shopify_shops after insert or update or delete on public.shopify_shops for each row execute function public.audit_row();
-- vendors may only change the settings, not the shop/vendor/token
create or replace function public.protect_shopify_shop() returns trigger language plpgsql as $$
begin
  if public.is_trusted() then return new; end if;
  if (new.shop, new.vendor_id, new.rates_token, new.carrier_service_id, new.scopes, new.installed_at, new.uninstalled_at)
     is distinct from (old.shop, old.vendor_id, old.rates_token, old.carrier_service_id, old.scopes, old.installed_at, old.uninstalled_at) then
    raise exception 'Only the service and automatic booking settings can be changed';
  end if;
  return new;
end $$;
create trigger shopify_shops_protect before update on public.shopify_shops for each row execute function public.protect_shopify_shop();

-- Shopify access tokens: no policies at all, so only the server (service role) can read them.
create table public.shopify_tokens (
  shop         text primary key references public.shopify_shops(shop) on delete cascade,
  access_token text not null,
  updated_at   timestamptz not null default now()
);
alter table public.shopify_tokens enable row level security;

-- One-time state for the "Connect Shopify" sign-in (stops someone else's shop being linked to your account).
create table public.shopify_oauth_states (
  state      text primary key,
  vendor_id  uuid not null references public.vendors(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  shop       text not null,
  created_at timestamptz not null default now()
);
alter table public.shopify_oauth_states enable row level security;

/** Portal "Connect Shopify": remember who started it; the server checks it when Shopify sends the person back. */
create or replace function public.start_shopify_connect(p_vendor uuid, p_shop text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s text := encode(gen_random_bytes(16), 'hex'); v_shop text := lower(trim(p_shop));
begin
  perform public._need(p_vendor in (select public.my_vendor_ids('api')), 'You don''t have API access for this business');
  v_shop := regexp_replace(regexp_replace(v_shop, '^https?://', ''), '/.*$', '');
  if v_shop !~ '\.myshopify\.com$' then v_shop := v_shop || '.myshopify.com'; end if;
  perform public._need(v_shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$', 'Enter your Shopify store address, e.g. my-shop.myshopify.com');
  perform public._need(not exists (select 1 from public.shopify_shops where shopify_shops.shop = v_shop and vendor_id <> p_vendor and uninstalled_at is null),
                       'That Shopify store is already connected to another QCS account');
  delete from public.shopify_oauth_states where created_at < now() - interval '1 hour';
  insert into public.shopify_oauth_states (state, vendor_id, user_id, shop) values (s, p_vendor, auth.uid(), v_shop);
  return s || ':' || v_shop;
end $$;

-- ---------- housekeeping ----------
create or replace function public.purge_api_data() returns void
language sql security definer set search_path = public, extensions as $$
  delete from public.api_requests where created_at < now() - interval '30 days';
  delete from public.api_idempotency where created_at < now() - interval '24 hours';
  delete from public.webhook_deliveries where created_at < now() - interval '30 days' and status in ('sent', 'failed');
  delete from public.api_test_deliveries where created_at < now() - interval '90 days';
$$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-api-data', '50 2 * * *', 'select public.purge_api_data()');
  end if;
end $$;

-- ---------- who may call what ----------
revoke execute on function public.api_begin(text, text, text, text), public.api_end(bigint, int, int, text, text),
  public.api_idem_claim(uuid, text, text, text), public.api_idem_save(uuid, text, text, int, jsonb),
  public.api_delivery(uuid, boolean), public.api_get_delivery(uuid, text),
  public.api_list_deliveries(uuid, text, timestamptz, timestamptz, text, int, timestamptz), public.api_cancel_delivery(uuid, text, text),
  public.api_mark_source(uuid, text), public.api_test_create(uuid, jsonb), public.api_test_get(uuid, text),
  public.api_test_list(uuid, text, text, int, timestamptz), public.api_test_transition(uuid, text, text, text), public.api_test_cancel(uuid, text, text),
  public._webhook_event(uuid, text, text, jsonb), public.webhook_on_event(), public.claim_webhooks(int),
  public.finish_webhook(uuid, boolean, int, text, text), public.purge_api_data()
  from public, anon, authenticated;
grant execute on function public.api_begin(text, text, text, text), public.api_end(bigint, int, int, text, text),
  public.api_idem_claim(uuid, text, text, text), public.api_idem_save(uuid, text, text, int, jsonb),
  public.api_delivery(uuid, boolean), public.api_get_delivery(uuid, text),
  public.api_list_deliveries(uuid, text, timestamptz, timestamptz, text, int, timestamptz), public.api_cancel_delivery(uuid, text, text),
  public.api_mark_source(uuid, text), public.api_test_create(uuid, jsonb), public.api_test_get(uuid, text),
  public.api_test_list(uuid, text, text, int, timestamptz), public.api_test_transition(uuid, text, text, text), public.api_test_cancel(uuid, text, text),
  public.claim_webhooks(int), public.finish_webhook(uuid, boolean, int, text, text), public.purge_api_data()
  to service_role;
revoke execute on function public.create_api_key(uuid, text, text), public.revoke_api_key(uuid), public.rotate_webhook_secret(uuid),
  public.resend_webhook(uuid), public.ping_webhook(uuid), public.start_shopify_connect(uuid, text) from public, anon;
grant execute on function public.create_api_key(uuid, text, text), public.revoke_api_key(uuid), public.rotate_webhook_secret(uuid),
  public.resend_webhook(uuid), public.ping_webhook(uuid), public.start_shopify_connect(uuid, text) to authenticated;
