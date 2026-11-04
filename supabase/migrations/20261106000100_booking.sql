-- =====================================================================
-- QCS Unified — Phase 3: quotes and bookings
--   • quotes: the price we showed, locked for 15 minutes (CLAUDE.md §5: always quote first)
--   • create_booking(): turns a quote into orders (+ a bulk trip with stops)
--   • pricing settings that admins can edit (surge, night window, cut-off)
-- Prices are calculated by packages/pricing on the server, never by the database or the app.
-- =====================================================================

-- ---------- order details captured at booking ----------
alter table public.orders
  add column package_size          text check (package_size in ('small', 'medium', 'large', 'xl')),
  add column pickup_address_text   text,
  add column pickup_contact_name   text,
  add column pickup_contact_phone  text,
  add column pickup_instructions   text,
  add column dropoff_address_text  text,
  add column dropoff_landmark      text,
  add column dropoff_ghana_post_gps text,
  add column delivery_instructions text,
  add column pickup_date           date,           -- e-commerce: the day it will be collected (after cut-off → next day)
  add column quote_id              uuid;
create index orders_pickup_date_idx on public.orders (city_id, pickup_date) where pickup_date is not null;

-- ---------- quotes ----------
create table public.quotes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  vendor_id   uuid references public.vendors(id),
  service_type public.service_type not null,
  city_id     uuid not null references public.cities(id),
  request     jsonb not null,          -- the checked booking details
  price       jsonb not null,          -- per-stop prices and lines from packages/pricing
  zones       jsonb not null,          -- drop-off zone id per stop
  promo_code_id uuid references public.promo_codes(id),
  total       bigint not null check (total >= 0),
  expires_at  timestamptz not null default now() + interval '15 minutes',
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index quotes_user_idx on public.quotes (user_id, created_at desc);
alter table public.quotes enable row level security;
create policy quotes_read_own on public.quotes for select to authenticated
  using (user_id = (select auth.uid()) or public.is_ops(city_id));
-- Quotes are written by the booking server only (service role).

alter table public.orders add constraint orders_quote_fk foreign key (quote_id) references public.quotes(id);

-- ---------- where is this point? ----------
create or replace function public.zone_for_point(p_lng double precision, p_lat double precision)
returns table (zone_id uuid, zone_code text, zone_name text, city_id uuid, city_code text)
language sql stable security definer set search_path = public, extensions as $$
  select z.id, z.code, z.name, c.id, c.code
  from public.zones z join public.cities c on c.id = z.city_id
  where z.is_active and c.is_active
    and st_intersects(z.area, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography)
  order by st_area(z.area) asc   -- smallest zone wins where zones overlap
  limit 1;
$$;
grant execute on function public.zone_for_point(double precision, double precision) to anon, authenticated, service_role;

-- ---------- promo codes ----------
-- Returns the promo if this user may use it now, or raises a plain-language reason.
create or replace function public.check_promo(p_code text, p_user uuid, p_service public.service_type, p_city uuid)
returns public.promo_codes language plpgsql stable security definer set search_path = public, extensions as $$
declare p public.promo_codes; used int;
begin
  select * into p from public.promo_codes where code = upper(trim(p_code));
  if not found or not p.is_active then raise exception 'That promo code isn''t valid'; end if;
  if p.valid_from > now() or (p.valid_to is not null and p.valid_to < now()) then raise exception 'That promo code has expired'; end if;
  if p.city_id is not null and p.city_id <> p_city then raise exception 'That promo code isn''t valid in this city'; end if;
  if p.service_type is not null and p.service_type <> p_service then raise exception 'That promo code is for % deliveries', p.service_type; end if;
  if p.max_uses is not null and p.used_count >= p.max_uses then raise exception 'That promo code has been fully used'; end if;
  select count(distinct quote_id) into used from public.orders where promo_code_id = p.id and customer_id = p_user;
  if used >= p.per_user_limit then raise exception 'You have already used that promo code'; end if;
  return p;
end $$;
revoke execute on function public.check_promo(text, uuid, public.service_type, uuid) from public, anon, authenticated;

-- ---------- booking ----------
-- Turns a quote into orders. Called by the booking server (service role) after it has checked who the user is.
create or replace function public.create_booking(p_user uuid, p_quote uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  q public.quotes;
  req jsonb;
  pk jsonb;
  d jsonb;
  i int := 0;
  n int;
  v_trip uuid;
  pickup_addr uuid;
  drop_addr uuid;
  o_id uuid;
  upfront boolean;
  out jsonb := '[]'::jsonb;
  pt_pick geography;
  dup text;
begin
  if not public.is_trusted() then raise exception 'Bookings are created by the QCS booking server'; end if;

  select * into q from public.quotes where id = p_quote for update;
  if not found or q.user_id <> p_user then raise exception 'Quote not found'; end if;
  if q.used_at is not null then raise exception 'This quote has already been booked'; end if;
  if q.expires_at < now() then raise exception 'This quote has expired. Please get a new price.'; end if;

  if q.vendor_id is not null and not exists (
    select 1 from public.vendors v where v.id = q.vendor_id and v.owner_id = p_user
    union all
    select 1 from public.vendor_staff s where s.vendor_id = q.vendor_id and s.user_id = p_user and s.is_active and 'book' = any (s.permissions)
  ) then
    raise exception 'You are not allowed to book for this business';
  end if;

  if q.vendor_id is not null and (select booking_blocked from public.vendors where id = q.vendor_id) then
    raise exception 'Bookings are on hold for this account: %', coalesce((select booking_block_reason from public.vendors where id = q.vendor_id), 'unpaid invoices');
  end if;

  -- The vendor's own order numbers must not repeat (stops double bookings from the same upload).
  select string_agg(distinct d2 ->> 'external_ref', ', ') into dup
    from jsonb_array_elements(q.request -> 'dropoffs') d2
   where d2 ->> 'external_ref' is not null and q.vendor_id is not null
     and exists (select 1 from public.orders o where o.vendor_id = q.vendor_id and o.external_ref = d2 ->> 'external_ref');
  if dup is not null then raise exception 'Already booked: order number(s) %', dup; end if;

  if q.promo_code_id is not null then
    perform public.check_promo((select code from public.promo_codes where id = q.promo_code_id), p_user, q.service_type, q.city_id);
    update public.promo_codes set used_count = used_count + 1 where id = q.promo_code_id;
  end if;

  req := q.request;
  pk := req -> 'pickup';
  n := jsonb_array_length(req -> 'dropoffs');
  upfront := (req ->> 'payer') = 'sender' and (req ->> 'payment_method') in ('card', 'momo');
  pt_pick := st_setsrid(st_makepoint((pk ->> 'lng')::float8, (pk ->> 'lat')::float8), 4326)::geography;

  -- pickup address: reuse a saved one, otherwise save it to the address book
  pickup_addr := nullif(pk ->> 'address_id', '')::uuid;
  if pickup_addr is not null and not exists (
    select 1 from public.addresses a where a.id = pickup_addr and (a.user_id = p_user or a.vendor_id = q.vendor_id)) then
    pickup_addr := null;
  end if;
  if pickup_addr is null then
    insert into public.addresses (user_id, vendor_id, label, contact_name, contact_phone, formatted_address, google_place_id, ghana_post_gps, landmark, location, city_id,
                                  zone_id)
    values (case when q.vendor_id is null then p_user end, q.vendor_id, 'Pickup', pk ->> 'contact_name', pk ->> 'contact_phone', pk ->> 'formatted_address',
            pk ->> 'google_place_id', pk ->> 'ghana_post_gps', pk ->> 'landmark', pt_pick, q.city_id,
            (select zone_id from public.zone_for_point((pk ->> 'lng')::float8, (pk ->> 'lat')::float8)))
    returning id into pickup_addr;
  end if;

  if q.service_type = 'ecommerce' and n > 1 then
    insert into public.trips (trip_type, status, city_id, vendor_id, created_by)
    values ('bulk', 'PLANNED', q.city_id, q.vendor_id, p_user) returning id into v_trip;
  end if;

  for d in select * from jsonb_array_elements(req -> 'dropoffs') loop
    -- every recipient goes into the address book (repeat customers, CLAUDE.md §10)
    drop_addr := nullif(d ->> 'address_id', '')::uuid;
    if drop_addr is not null and not exists (
      select 1 from public.addresses a where a.id = drop_addr and (a.user_id = p_user or a.vendor_id = q.vendor_id)) then
      drop_addr := null;
    end if;
    if drop_addr is null then
      insert into public.addresses (user_id, vendor_id, label, contact_name, contact_phone, formatted_address, google_place_id, ghana_post_gps, landmark, location, city_id, zone_id)
      values (case when q.vendor_id is null then p_user end, q.vendor_id, d ->> 'contact_name', d ->> 'contact_name', d ->> 'contact_phone', d ->> 'formatted_address',
              d ->> 'google_place_id', d ->> 'ghana_post_gps', d ->> 'landmark',
              st_setsrid(st_makepoint((d ->> 'lng')::float8, (d ->> 'lat')::float8), 4326)::geography,
              q.city_id, nullif(q.zones ->> i, '')::uuid)
      returning id into drop_addr;
    end if;

    insert into public.orders (
      service_type, city_id, customer_id, vendor_id, external_ref,
      pickup_address_id, dropoff_address_id, pickup_location, dropoff_location, dropoff_zone_id,
      pickup_address_text, pickup_contact_name, pickup_contact_phone, pickup_instructions,
      dropoff_address_text, dropoff_landmark, dropoff_ghana_post_gps, delivery_instructions,
      recipient_name, recipient_phone, address_confirmation,
      item_description, weight_g, package_size, is_fragile, is_high_value, item_value, cod_amount,
      quoted_fee, price_breakdown, promo_code_id, payer, payment_method,
      scheduled_pickup_at, pickup_date, trip_id, quote_id
    ) values (
      q.service_type, q.city_id, p_user, q.vendor_id, d ->> 'external_ref',
      pickup_addr, drop_addr, pt_pick, st_setsrid(st_makepoint((d ->> 'lng')::float8, (d ->> 'lat')::float8), 4326)::geography,
      nullif(q.zones ->> i, '')::uuid,
      pk ->> 'formatted_address', pk ->> 'contact_name', pk ->> 'contact_phone', pk ->> 'instructions',
      d ->> 'formatted_address', d ->> 'landmark', d ->> 'ghana_post_gps', d ->> 'instructions',
      d ->> 'contact_name', d ->> 'contact_phone', 'pending',
      d ->> 'item_description', (d ->> 'weight_g')::int, d ->> 'size', coalesce((d ->> 'fragile')::boolean, false),
      coalesce((d ->> 'item_value')::bigint, 0) >= 100000,            -- GHS 1,000+ = high value (pickup code)
      coalesce((d ->> 'item_value')::bigint, 0), coalesce((d ->> 'cod_amount')::bigint, 0),
      (q.price -> 'stops' -> i ->> 'netPesewas')::bigint, q.price -> 'stops' -> i -> 'lines', q.promo_code_id,
      (req ->> 'payer')::public.payer_type, (req ->> 'payment_method')::public.payment_method,
      nullif(req ->> 'scheduled_at', '')::timestamptz, nullif(q.price ->> 'pickupDate', '')::date, v_trip, q.id
    ) returning id into o_id;

    if v_trip is not null then
      insert into public.order_stops (trip_id, order_id, kind, location, suggested_seq)
      values (v_trip, o_id, 'pickup', pt_pick, 0),
             (v_trip, o_id, 'dropoff', st_setsrid(st_makepoint((d ->> 'lng')::float8, (d ->> 'lat')::float8), 4326)::geography, i + 1);
    end if;

    perform public.transition_order(o_id, case when upfront then 'PENDING_PAYMENT' else 'CONFIRMED' end::public.order_status,
                                    null, null, 'Booked', null, null);

    out := out || jsonb_build_object('id', o_id, 'tracking_number', (select tracking_number from public.orders where id = o_id),
                                     'status', (select status from public.orders where id = o_id), 'fee', (q.price -> 'stops' -> i ->> 'netPesewas')::bigint);
    i := i + 1;
  end loop;

  update public.quotes set used_at = now() where id = q.id;
  return jsonb_build_object('trip_id', v_trip, 'needs_payment', upfront, 'total', q.total, 'orders', out);
end $$;
revoke execute on function public.create_booking(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_booking(uuid, uuid) to service_role;

-- ---------- pricing settings admins can edit ----------
insert into public.app_settings (key, value, description) values
  ('night_window', '{"start":"20:00","end":"06:00"}', 'Express night surcharge applies between these times (Accra time)'),
  ('surge_multiplier', '1', 'Busy-time multiplier on Express distance and time (1 = off)')
on conflict do nothing;

-- Finance and City Admins may change the price settings (not other settings) for their city.
create policy settings_pricing_write on public.app_settings for all to authenticated
  using (key in ('night_window', 'surge_multiplier') and (public.is_finance() or (city_id is not null and public.is_admin(city_id))))
  with check (key in ('night_window', 'surge_multiplier') and (public.is_finance() or (city_id is not null and public.is_admin(city_id))));

-- Same-day cut-off per city (Super Admin, that city's admin, or Finance).
create or replace function public.set_city_cutoff(p_city uuid, p_cutoff time) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not (public.is_trusted() or public.is_admin(p_city) or public.is_finance()) then
    raise exception 'Only an admin for this city or Finance can change the cut-off';
  end if;
  perform set_config('qcs.audit_reason', 'same-day cut-off changed', true);
  update public.cities set same_day_cutoff = p_cutoff where id = p_city;
end $$;
revoke execute on function public.set_city_cutoff(uuid, time) from public, anon;
grant execute on function public.set_city_cutoff(uuid, time) to authenticated;
create trigger audit_cities after update on public.cities for each row execute function public.audit_row();
