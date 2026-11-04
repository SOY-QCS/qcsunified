-- =====================================================================
-- QCS Unified — tracking numbers, insurance, terms acceptance
--   • Tracking number = pickup city code - booking time (Accra, to the minute) - destination city code
--       e.g. ACC-202611041301-KUM. If another parcel on the same route was booked in the same minute,
--       a counter is added: ACC-202611041301-KUM-02, -03 ...
--   • Insurance: for items declared at GHS 1,000+ (editable), the client can add 5% of the declared value
--     as a premium. Insured parcels are refunded in full if damaged or missing (per the T&C).
--   • Clients accept the Terms & Conditions when signing up.
-- =====================================================================

-- ---------- city codes used in tracking numbers (first 3 letters of the name; editable for clashes) ----------
alter table public.cities add column tracking_code text;
update public.cities set tracking_code = upper(left(regexp_replace(name, '[^A-Za-z]', '', 'g'), 3));
alter table public.cities alter column tracking_code set not null;
alter table public.cities add constraint cities_tracking_code_format check (tracking_code ~ '^[A-Z]{2,4}$');
create unique index cities_tracking_code_key on public.cities (tracking_code);

create or replace function public.default_city_tracking_code() returns trigger language plpgsql as $$
begin
  if new.tracking_code is null then new.tracking_code := upper(left(regexp_replace(new.name, '[^A-Za-z]', '', 'g'), 3)); end if;
  return new;
end $$;
create trigger cities_tracking_code before insert on public.cities for each row execute function public.default_city_tracking_code();

-- ---------- tracking number generator ----------
create or replace function public.next_tracking_number(p_from_city uuid, p_to_city uuid, p_at timestamptz default now())
returns text language plpgsql security definer set search_path = public, extensions as $$
declare base text; candidate text; n int := 1;
begin
  base := (select tracking_code from public.cities where id = p_from_city) || '-'
       || to_char(p_at at time zone 'Africa/Accra', 'YYYYMMDDHH24MI') || '-'
       || (select tracking_code from public.cities where id = coalesce(p_to_city, p_from_city));
  -- one booking at a time per route-minute, so two people can't get the same number
  perform pg_advisory_xact_lock(hashtext(base));
  candidate := base;
  while exists (select 1 from public.orders where tracking_number = candidate) loop
    n := n + 1;
    candidate := base || '-' || lpad(n::text, 2, '0');
  end loop;
  return candidate;
end $$;

-- Destination city: the inter-city destination hub's city, otherwise the drop-off zone's city, otherwise the pickup city.
create or replace function public.set_tracking_number() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare dest uuid;
begin
  if new.tracking_number is not null and new.tracking_number <> '' then return new; end if;
  dest := coalesce(
    (select h.city_id from public.hubs h where h.id = new.dest_hub_id),
    (select z.city_id from public.zones z where z.id = new.dropoff_zone_id),
    new.city_id);
  new.tracking_number := public.next_tracking_number(new.city_id, dest, coalesce(new.created_at, now()));
  return new;
end $$;
alter table public.orders alter column tracking_number drop default;
create trigger orders_tracking_number before insert on public.orders for each row execute function public.set_tracking_number();
drop sequence if exists public.tracking_seq;

-- ---------- insurance ----------
alter table public.orders
  add column is_insured        boolean not null default false,
  add column insurance_premium bigint  not null default 0 check (insurance_premium >= 0);   -- pesewas
alter table public.orders add constraint insured_has_premium check (not is_insured or insurance_premium > 0);

insert into public.app_settings (key, value, description) values
  ('high_value_threshold', '100000', 'Declared value (pesewas) from which an item is high value: pickup code + insurance offered'),
  ('insurance_rate', '0.05', 'Insurance premium as a share of the declared value (0.05 = 5%)'),
  ('terms_version', '"2026-11"', 'Current client Terms & Conditions version'),
  ('terms_url', '"https://qcsghana.com/terms"', 'Where clients read the Terms & Conditions (replace with the real page)')
on conflict do nothing;

-- Finance may edit the insurance settings; Super Admin manages the T&C settings.
drop policy settings_pricing_write on public.app_settings;
create policy settings_pricing_write on public.app_settings for all to authenticated
  using ((key in ('night_window', 'surge_multiplier') and (public.is_finance() or (city_id is not null and public.is_admin(city_id))))
         or (key in ('insurance_rate', 'high_value_threshold') and city_id is null and public.is_finance()))
  with check ((key in ('night_window', 'surge_multiplier') and (public.is_finance() or (city_id is not null and public.is_admin(city_id))))
         or (key in ('insurance_rate', 'high_value_threshold') and city_id is null and public.is_finance()));

-- ---------- Terms & Conditions acceptance ----------
alter table public.profiles
  add column terms_version     text,
  add column terms_accepted_at timestamptz;


-- People can't fake their own acceptance time/version; only accept_terms() sets them.
create or replace function public.protect_terms() returns trigger language plpgsql as $$
begin
  if (new.terms_version, new.terms_accepted_at) is distinct from (old.terms_version, old.terms_accepted_at)
     and current_setting('qcs.terms', true) is distinct from 'on' and not public.is_trusted() then
    raise exception 'Use accept_terms() to accept the Terms & Conditions';
  end if;
  return new;
end $$;
create trigger profiles_protect_terms before update on public.profiles for each row execute function public.protect_terms();
create or replace function public.accept_terms() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v text := (select value #>> '{}' from public.app_settings where key = 'terms_version' and city_id is null);
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  perform set_config('qcs.terms', 'on', true);
  update public.profiles set terms_version = v, terms_accepted_at = now() where id = auth.uid();
  perform set_config('qcs.terms', 'off', true);
  return v;
end $$;

revoke execute on function public.accept_terms() from public, anon;
grant execute on function public.accept_terms() to authenticated;

-- Vendor sign-up requires accepted terms.
create or replace function public.require_terms_for_vendor() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.owner_id is not null and not public.is_trusted() and not public.is_ops_writer(new.city_id)
     and (select terms_accepted_at from public.profiles where id = new.owner_id) is null then
    raise exception 'Please accept the Terms & Conditions first';
  end if;
  return new;
end $$;
create trigger vendors_require_terms before insert on public.vendors for each row execute function public.require_terms_for_vendor();

-- my_account() now tells the apps whether terms are accepted (profile includes the two new columns automatically).

-- ---------- create_booking now saves insurance and uses the editable high-value threshold ----------
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
  threshold bigint := coalesce((select (value #>> '{}')::bigint from public.app_settings where key = 'high_value_threshold' and city_id is null), 100000);
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
      item_description, weight_g, package_size, is_fragile, is_high_value, item_value, cod_amount, is_insured, insurance_premium,
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
      coalesce((d ->> 'item_value')::bigint, 0) >= threshold,         -- high value: pickup code + insurance offered
      coalesce((d ->> 'item_value')::bigint, 0), coalesce((d ->> 'cod_amount')::bigint, 0),
      coalesce((q.price -> 'stops' -> i ->> 'insurancePesewas')::bigint, 0) > 0, coalesce((q.price -> 'stops' -> i ->> 'insurancePesewas')::bigint, 0),
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
                                     'status', (select status from public.orders where id = o_id), 'fee', (q.price -> 'stops' -> i ->> 'netPesewas')::bigint,
                                     'insurance', coalesce((q.price -> 'stops' -> i ->> 'insurancePesewas')::bigint, 0));
    i := i + 1;
  end loop;

  update public.quotes set used_at = now() where id = q.id;
  return jsonb_build_object('trip_id', v_trip, 'needs_payment', upfront, 'total', q.total, 'orders', out);
end $$;
