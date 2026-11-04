-- =====================================================================
-- Phase 9a — Inter-city booking, hub scanning, bags, manifests, line-haul, last mile, hub collection
--
-- A parcel's journey between cities:
--   pickup (first-mile rider) → AT_HUB (scan in, label printed) → sorted into a bag for its destination hub
--   → bags loaded on a manifest (bus, driver, waybill, seal) → DEPARTED_HUB → bus → manifest arrives
--   → ARRIVED_DEST_HUB (scan bag or parcel) → READY_FOR_COLLECTION (recipient brings code) → COLLECTED
--                                           → or last-mile trip → handed to rider → OUT_FOR_DELIVERY → DELIVERED
-- Every scan is recorded (who, what, where, when) for the Hub Manager.
-- =====================================================================

alter table public.orders
  add column current_hub_id    uuid references public.hubs(id),
  add column label_printed_at  timestamptz,
  add column fulfilment_hub_id uuid references public.hubs(id),
  add column fulfilment_state  text check (fulfilment_state in ('to_pick', 'packed'));
create index orders_current_hub_idx on public.orders (current_hub_id, status) where current_hub_id is not null;
create index orders_dest_hub_idx on public.orders (dest_hub_id, status) where dest_hub_id is not null;

-- vendors may walk parcels into a hub; packed stock parcels start at the hub
insert into public.order_status_transitions (from_status, to_status) values ('CONFIRMED', 'AT_HUB'), ('SEARCHING_RIDER', 'AT_HUB'), ('ASSIGNED', 'AT_HUB')
on conflict do nothing;

insert into public.app_settings (key, value, description) values
  ('hub_stuck_hours',       '24', 'Hub board: a parcel sitting in a hub longer than this is flagged'),
  ('linehaul_expected_hours', '12', 'Hub board: a bus manifest not arrived after this many hours is flagged')
on conflict do nothing;

-- ---------- helpers ----------
create or replace function public._hub_staff(p_hub uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select public.is_trusted() or p_hub in (select public.my_hub_ids())
      or public.is_admin((select city_id from public.hubs where id = p_hub));
$$;

/** The active hub in a city nearest to a point (where an inter-city parcel enters or leaves the network). */
create or replace function public.nearest_hub(p_city uuid, p_lng double precision, p_lat double precision) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select id from public.hubs where city_id = p_city and is_active
  order by location <-> st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography limit 1;
$$;
create or replace function public.hub_point(p_hub uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('id', id, 'city_id', city_id, 'name', name, 'address', address, 'phone', phone,
                            'lat', st_y(location::geometry), 'lng', st_x(location::geometry))
  from public.hubs where id = p_hub and is_active;
$$;
grant execute on function public.nearest_hub(uuid, double precision, double precision), public.hub_point(uuid) to authenticated, service_role;

-- a parcel's code: the tracking number on the label (or typed in)
create or replace function public._order_by_code(p_code text) returns public.orders
language sql stable security definer set search_path = public, extensions as $$
  select * from public.orders where tracking_number = upper(trim(p_code));
$$;

-- ---------- delivery codes also for parcels that start at a hub (walk-in, stock) ----------
create or replace function public.make_delivery_code() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare code text;
begin
  if new.status in ('PICKED_UP', 'AT_HUB') and old.status is distinct from new.status and new.delivery_otp_hash is null then
    code := lpad((floor(random() * 10000))::int::text, 4, '0');
    perform public._sys(1);
    update public.orders set delivery_otp_hash = crypt(code, gen_salt('bf', 6)) where id = new.id;
    perform public._sys(-1);
    insert into public.notifications (to_address, order_id, channel, template, payload)
    values (new.recipient_phone, new.id, 'sms', 'delivery_code',
            jsonb_build_object('code', code, 'tracking_number', new.tracking_number, 'sender',
                               coalesce((select business_name from public.vendors where id = new.vendor_id), new.pickup_contact_name)));
  end if;
  return new;
end $$;

-- ---------- bags, manifests, scans ----------
create table public.hub_bags (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,                          -- printed as a QR on the bag tag
  hub_id      uuid not null references public.hubs(id),      -- where it is packed
  dest_hub_id uuid not null references public.hubs(id),
  status      text not null default 'open' check (status in ('open', 'sealed', 'in_transit', 'arrived', 'emptied')),
  seal_no     text,
  manifest_id uuid,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create table public.bag_items (
  bag_id     uuid not null references public.hub_bags(id),
  order_id   uuid not null references public.orders(id),
  added_by   uuid references public.profiles(id),
  added_at   timestamptz not null default now(),
  removed_at timestamptz,
  arrived_at timestamptz
);
create unique index bag_items_one_open on public.bag_items (order_id) where removed_at is null and arrived_at is null;
create index bag_items_bag_idx on public.bag_items (bag_id);

create table public.manifests (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  origin_hub_id  uuid not null references public.hubs(id),
  dest_hub_id    uuid not null references public.hubs(id),
  status         text not null default 'loading' check (status in ('loading', 'departed', 'arrived', 'closed')),
  -- line-haul by VIP / mini bus (CLAUDE.md §11)
  bus_company    text, bus_station text, driver_name text, driver_phone text, vehicle_reg text, waybill_no text, seal_no text,
  departed_at    timestamptz, arrived_at timestamptz, closed_at timestamptz,
  parcels_sent   int not null default 0, parcels_received int not null default 0,
  created_by     uuid references public.profiles(id), dispatched_by uuid references public.profiles(id), received_by uuid references public.profiles(id),
  note           text,
  created_at     timestamptz not null default now()
);
alter table public.hub_bags add constraint hub_bags_manifest_fk foreign key (manifest_id) references public.manifests(id);

create table public.hub_scans (
  id          bigint generated always as identity primary key,
  key         uuid unique,                              -- from the phone: a re-sent scan is ignored
  hub_id      uuid references public.hubs(id),
  kind        text not null,                            -- in, bag, unbag, arrive_bag, handover, collect, receive, pick, label
  code        text,
  order_id    uuid references public.orders(id),
  bag_id      uuid references public.hub_bags(id),
  manifest_id uuid references public.manifests(id),
  ok          boolean not null,
  result      jsonb,
  scanned_by  uuid references public.profiles(id),
  occurred_at timestamptz,                              -- phone time (scans made offline sync later)
  created_at  timestamptz not null default now()
);
create index hub_scans_hub_idx on public.hub_scans (hub_id, created_at desc);
create index hub_scans_order_idx on public.hub_scans (order_id);
create trigger hub_scans_append_only before update or delete on public.hub_scans for each row execute function public.block_change();

alter table public.hub_bags enable row level security;
alter table public.bag_items enable row level security;
alter table public.manifests enable row level security;
alter table public.hub_scans enable row level security;
create policy bags_read on public.hub_bags for select to authenticated using (public._hub_staff(hub_id) or public._hub_staff(dest_hub_id) or public.is_ops((select city_id from public.hubs where id = hub_id)));
create policy bag_items_read on public.bag_items for select to authenticated using (exists (select 1 from public.hub_bags b where b.id = bag_id));
create policy manifests_read on public.manifests for select to authenticated using (public._hub_staff(origin_hub_id) or public._hub_staff(dest_hub_id)
  or public.is_ops((select city_id from public.hubs where id = origin_hub_id)) or public.is_ops((select city_id from public.hubs where id = dest_hub_id)));
create policy scans_read on public.hub_scans for select to authenticated using (public._hub_staff(hub_id) or public.is_ops((select city_id from public.hubs where id = hub_id)));
create trigger audit_manifests after insert or update of status on public.manifests for each row execute function public.audit_row();

-- hub staff can upload the recipient's signature when they collect at the hub
create policy pod_upload_hub on storage.objects for insert to authenticated with check (
  bucket_id = 'pod' and exists (select 1 from public.orders o where o.id::text = (storage.foldername(name))[1] and o.dest_hub_id in (select public.my_hub_ids())));

-- ---------- bags ----------
create or replace function public.open_bag(p_hub uuid, p_dest_hub uuid) returns public.hub_bags
language plpgsql security definer set search_path = public, extensions as $$
declare b public.hub_bags; o text; d text;
begin
  perform public._need(public._hub_staff(p_hub), 'Hub staff only');
  perform public._need(p_hub <> p_dest_hub, 'A bag goes to another hub');
  select code into o from public.hubs where id = p_hub; select code into d from public.hubs where id = p_dest_hub;
  perform public._need(d is not null, 'Destination hub not found');
  insert into public.hub_bags (code, hub_id, dest_hub_id, created_by)
  values ('BAG-' || replace(o, '-HUB', '') || '-' || replace(d, '-HUB', '') || '-' || to_char(now() at time zone 'Africa/Accra', 'YYMMDD') || '-' ||
          lpad((select count(*) + 1 from public.hub_bags where hub_id = p_hub and created_at > date_trunc('day', now()))::text, 3, '0'),
          p_hub, p_dest_hub, auth.uid())
  returning * into b;
  return b;
end $$;

create or replace function public.seal_bag(p_bag uuid, p_seal text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare b public.hub_bags;
begin
  select * into b from public.hub_bags where id = p_bag for update;
  perform public._need(found and public._hub_staff(b.hub_id), 'Hub staff only');
  perform public._need(b.status = 'open', 'This bag is already sealed');
  perform public._need(exists (select 1 from public.bag_items where bag_id = p_bag and removed_at is null), 'The bag is empty');
  update public.hub_bags set status = 'sealed', seal_no = nullif(trim(p_seal), '') where id = p_bag;
end $$;

-- ---------- the scan endpoint (offline-safe, like rider_action) ----------
create or replace function public.hub_scan(p_key uuid, p_action jsonb, p_occurred_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  prev jsonb; hub uuid := (p_action ->> 'hub_id')::uuid; t text := p_action ->> 'type'; v_code text := upper(trim(coalesce(p_action ->> 'code', '')));
  o public.orders; b public.hub_bags; res jsonb; dest text; n int; tr public.trips;
begin
  select result into prev from public.hub_scans where key = p_key;
  if found then return prev; end if;                      -- the phone re-sent it: same answer
  perform public._need(public._hub_staff(hub), 'You are not staff at this hub');
  perform set_config('qcs.occurred_at', coalesce(least(greatest(p_occurred_at, now() - interval '2 days'), now())::text, ''), true);

  begin
    if t in ('in', 'bag', 'unbag', 'handover', 'collect') then
      o := public._order_by_code(v_code);
      if o.id is null then raise exception 'Unknown parcel %', v_code; end if;
      select h2.code into dest from public.hubs h2 where h2.id = o.dest_hub_id;
    end if;

    if t = 'in' then
      -- arriving at the origin hub (from a rider, or walked in by the vendor)
      if o.origin_hub_id = hub and o.status in ('CONFIRMED', 'SEARCHING_RIDER', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT') then
        perform public._sys(1);
        perform public.transition_order(o.id, 'AT_HUB', null, null, 'Scanned in at hub', null, null);
        update public.orders set current_hub_id = hub where id = o.id;
        perform public._sys(-1);
        res := jsonb_build_object('ok', true, 'status', 'AT_HUB', 'next', case when o.label_printed_at is null then 'print_label' else 'bag' end, 'dest', dest);
      -- arriving at the destination hub off the bus
      elsif o.dest_hub_id = hub and o.status = 'DEPARTED_HUB' then
        res := public._arrive_parcel(o, hub);
      -- a failed delivery or a return coming back in
      elsif o.status in ('FAILED_ATTEMPT', 'RETURNING_TO_SENDER') then
        perform public._sys(1);
        perform public.transition_order(o.id, 'AT_HUB', null, null, 'Brought back to hub', null, null);
        update public.orders set current_hub_id = hub where id = o.id;
        perform public._sys(-1);
        res := jsonb_build_object('ok', true, 'status', 'AT_HUB', 'next', 'call_dispatch');
      elsif o.current_hub_id = hub then
        res := jsonb_build_object('ok', true, 'status', o.status, 'already', true, 'next', case when o.status = 'AT_HUB' then 'bag' else 'shelf' end, 'dest', dest);
      else
        raise exception '% is not for this hub (status: %, destination: %)', o.tracking_number, lower(o.status::text), coalesce(dest, 'local delivery');
      end if;

    elsif t = 'bag' then
      select * into b from public.hub_bags where id = (p_action ->> 'bag_id')::uuid for update;
      perform public._need(b.id is not null and b.hub_id = hub, 'Choose a bag at this hub');
      perform public._need(b.status = 'open', 'This bag is sealed');
      perform public._need(o.status = 'AT_HUB' and o.current_hub_id = hub, o.tracking_number || ' is not in this hub — scan it in first');
      perform public._need(o.label_printed_at is not null, 'Print and stick the label on ' || o.tracking_number || ' first');
      perform public._need(o.dest_hub_id = b.dest_hub_id, format('Wrong bag: %s goes to %s', o.tracking_number, dest));
      update public.bag_items set removed_at = now() where order_id = o.id and removed_at is null and arrived_at is null and bag_id <> b.id;
      insert into public.bag_items (bag_id, order_id, added_by)
      select b.id, o.id, auth.uid() where not exists (select 1 from public.bag_items where bag_id = b.id and order_id = o.id and removed_at is null);
      select count(*) into n from public.bag_items where bag_id = b.id and removed_at is null;
      res := jsonb_build_object('ok', true, 'bag', b.code, 'in_bag', n);

    elsif t = 'unbag' then
      update public.bag_items i set removed_at = now() from public.hub_bags hb
       where i.bag_id = hb.id and hb.hub_id = hub and hb.status = 'open' and i.order_id = o.id and i.removed_at is null;
      res := jsonb_build_object('ok', true, 'removed', found);

    elsif t = 'arrive_bag' then
      -- destination hub scans a bag tag: everything inside arrives at once (fast)
      select * into b from public.hub_bags hb where hb.code = v_code for update;
      perform public._need(b.id is not null, 'Unknown bag ' || v_code);
      perform public._need(b.dest_hub_id = hub, 'This bag is for another hub');
      perform public._need(b.status = 'in_transit', 'This bag has already been received');
      n := 0;
      for o in select ord.* from public.orders ord join public.bag_items i on i.order_id = ord.id
               where i.bag_id = b.id and i.removed_at is null and i.arrived_at is null and ord.status = 'DEPARTED_HUB' loop
        perform public._arrive_parcel(o, hub); n := n + 1;
      end loop;
      update public.hub_bags set status = 'arrived' where id = b.id;
      res := jsonb_build_object('ok', true, 'bag', b.code, 'arrived', n);

    elsif t = 'handover' then
      -- last mile: give the parcel to the rider whose trip it is on
      perform public._need(o.status in ('ARRIVED_DEST_HUB', 'AT_HUB') and o.current_hub_id = hub, o.tracking_number || ' is not waiting in this hub');
      select * into tr from public.trips where id = o.trip_id;
      perform public._need(tr.rider_id is not null and tr.status in ('ASSIGNED', 'IN_PROGRESS') and tr.hub_id = hub,
                           'Plan a delivery trip for ' || o.tracking_number || ' and assign a rider first');
      perform public._need(p_action ->> 'rider_id' is null or (p_action ->> 'rider_id')::uuid = tr.rider_id,
                           o.tracking_number || ' is on another rider''s trip');
      perform public._sys(1);
      perform public.transition_order(o.id, 'OUT_FOR_DELIVERY', null, null, 'Handed to rider at hub', null, null);
      update public.orders set current_hub_id = null, rider_id = tr.rider_id where id = o.id;
      update public.trips set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()) where id = tr.id and status = 'ASSIGNED';
      perform public._sys(-1);
      res := jsonb_build_object('ok', true, 'status', 'OUT_FOR_DELIVERY', 'rider', (select full_name from public.profiles where id = tr.rider_id));

    elsif t = 'collect' then
      -- recipient collects at the hub: 4-digit code + signature, like a doorstep delivery (CLAUDE.md §7, §8)
      perform public._need(o.status = 'READY_FOR_COLLECTION' and o.dest_hub_id = hub, o.tracking_number || ' is not ready for collection here');
      if not public._check_delivery_code(o, p_action ->> 'otp') then
        res := jsonb_build_object('ok', false, 'error', 'Wrong code', 'attempts_left', 5 - (select pod_otp_attempts from public.orders where id = o.id));
      else
        perform public._need(coalesce(p_action ->> 'signature_path', '') like o.id::text || '/%', 'Take the recipient''s signature');
        perform public._sys(1);
        update public.orders set pod_signature_path = p_action ->> 'signature_path', pod_method = 'app', current_hub_id = null where id = o.id;
        perform public.transition_order(o.id, 'COLLECTED', null, null, 'Collected at hub', null, null);
        perform public._sys(-1);
        res := jsonb_build_object('ok', true, 'status', 'COLLECTED');
      end if;

    elsif t in ('receive', 'pick') then
      res := public._stock_scan(hub, t, p_action);
    else
      raise exception 'Unknown scan type %', t;
    end if;
  exception when others then
    res := jsonb_build_object('ok', false, 'error', sqlerrm);
  end;

  insert into public.hub_scans (key, hub_id, kind, code, order_id, bag_id, ok, result, scanned_by, occurred_at)
  values (p_key, hub, t, v_code, o.id, b.id, coalesce((res ->> 'ok')::boolean, false), res, auth.uid(), p_occurred_at);
  perform set_config('qcs.occurred_at', '', true);
  return res;
end $$;

create or replace function public._arrive_parcel(o public.orders, p_hub uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._sys(1);
  perform public.transition_order(o.id, 'ARRIVED_DEST_HUB', null, null, 'Arrived at destination hub', null, null);
  update public.orders set current_hub_id = p_hub where id = o.id;
  update public.bag_items set arrived_at = now() where order_id = o.id and removed_at is null and arrived_at is null;
  update public.manifests m set parcels_received = parcels_received + 1
   where m.id = (select hb.manifest_id from public.bag_items i join public.hub_bags hb on hb.id = i.bag_id where i.order_id = o.id order by i.added_at desc limit 1);
  if o.intercity_option = 'hub_collection' then
    perform public.transition_order(o.id, 'READY_FOR_COLLECTION', null, null, 'Ready for collection', null, null);   -- recipient is told (Phase 6)
  end if;
  perform public._sys(-1);
  return jsonb_build_object('ok', true, 'status', case when o.intercity_option = 'hub_collection' then 'READY_FOR_COLLECTION' else 'ARRIVED_DEST_HUB' end,
                            'next', case when o.intercity_option = 'hub_collection' then 'shelf' else 'last_mile' end);
end $$;

-- ---------- manifests ----------
create or replace function public.create_manifest(p_hub uuid, p_dest_hub uuid) returns public.manifests
language plpgsql security definer set search_path = public, extensions as $$
declare m public.manifests; o text; d text;
begin
  perform public._need(public._hub_staff(p_hub), 'Hub staff only');
  select replace(code, '-HUB', '') into o from public.hubs where id = p_hub; select replace(code, '-HUB', '') into d from public.hubs where id = p_dest_hub;
  perform public._need(d is not null and p_hub <> p_dest_hub, 'Choose the destination hub');
  insert into public.manifests (code, origin_hub_id, dest_hub_id, created_by)
  values ('MAN-' || o || '-' || d || '-' || to_char(now() at time zone 'Africa/Accra', 'YYMMDD') || '-' ||
          lpad((select count(*) + 1 from public.manifests where origin_hub_id = p_hub and created_at > date_trunc('day', now()))::text, 2, '0'),
          p_hub, p_dest_hub, auth.uid()) returning * into m;
  return m;
end $$;

create or replace function public.add_bag_to_manifest(p_manifest uuid, p_bag_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare m public.manifests; b public.hub_bags;
begin
  select * into m from public.manifests where id = p_manifest for update;
  perform public._need(found and public._hub_staff(m.origin_hub_id), 'Hub staff only');
  perform public._need(m.status = 'loading', 'This manifest has already left');
  select * into b from public.hub_bags where code = upper(trim(p_bag_code)) for update;
  perform public._need(b.id is not null, 'Unknown bag ' || p_bag_code);
  perform public._need(b.hub_id = m.origin_hub_id and b.dest_hub_id = m.dest_hub_id, 'This bag is not for this route');
  perform public._need(b.status in ('open', 'sealed') and (b.manifest_id is null or b.manifest_id = m.id), 'This bag is on another manifest');
  perform public._need(exists (select 1 from public.bag_items where bag_id = b.id and removed_at is null), 'The bag is empty');
  update public.hub_bags set manifest_id = m.id, status = 'sealed' where id = b.id;
  return jsonb_build_object('ok', true, 'bag', b.code, 'bags', (select count(*) from public.hub_bags where manifest_id = m.id),
                            'parcels', (select count(*) from public.bag_items i join public.hub_bags hb on hb.id = i.bag_id where hb.manifest_id = m.id and i.removed_at is null));
end $$;

/** Handed to the bus: bus details are required; every parcel in the loaded bags becomes DEPARTED_HUB. */
create or replace function public.dispatch_manifest(p_manifest uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare m public.manifests; o record; n int := 0;
begin
  select * into m from public.manifests where id = p_manifest for update;
  perform public._need(found and public._hub_staff(m.origin_hub_id), 'Hub staff only');
  perform public._need(m.status = 'loading', 'This manifest has already left');
  perform public._need(length(trim(coalesce(p ->> 'bus_company', ''))) >= 2 and length(trim(coalesce(p ->> 'vehicle_reg', ''))) >= 4
                       and length(trim(coalesce(p ->> 'driver_phone', ''))) >= 9 and length(trim(coalesce(p ->> 'waybill_no', ''))) >= 2,
                       'Bus company, vehicle registration, driver phone and bus waybill number are required');
  perform public._need(exists (select 1 from public.hub_bags where manifest_id = m.id), 'Load at least one bag');
  perform set_config('qcs.audit_reason', 'line-haul ' || (p ->> 'bus_company') || ' ' || (p ->> 'vehicle_reg') || ' waybill ' || (p ->> 'waybill_no'), true);
  perform public._sys(1);
  for o in select ord.id from public.orders ord join public.bag_items i on i.order_id = ord.id join public.hub_bags b on b.id = i.bag_id
           where b.manifest_id = m.id and i.removed_at is null and ord.status = 'AT_HUB' loop
    perform public.transition_order(o.id, 'DEPARTED_HUB', null, null, 'On the bus: ' || (p ->> 'bus_company') || ', waybill ' || (p ->> 'waybill_no'), null, null);
    update public.orders set current_hub_id = null where id = o.id;
    n := n + 1;
  end loop;
  perform public._sys(-1);
  update public.hub_bags set status = 'in_transit' where manifest_id = m.id;
  update public.manifests set status = 'departed', departed_at = now(), dispatched_by = auth.uid(), parcels_sent = n,
    bus_company = trim(p ->> 'bus_company'), bus_station = nullif(trim(p ->> 'bus_station'), ''), driver_name = nullif(trim(p ->> 'driver_name'), ''),
    driver_phone = trim(p ->> 'driver_phone'), vehicle_reg = upper(trim(p ->> 'vehicle_reg')), waybill_no = trim(p ->> 'waybill_no'),
    seal_no = nullif(trim(p ->> 'seal_no'), ''), note = nullif(trim(p ->> 'note'), '')
  where id = m.id;
  -- tell the destination hub what's coming
  insert into public.notifications (user_id, channel, template, payload)
  select distinct ur.user_id, 'push'::public.notification_channel, 'manifest_departed', jsonb_build_object('code', m.code, 'parcels', n, 'bus', p ->> 'bus_company', 'vehicle', p ->> 'vehicle_reg')
  from public.user_roles ur where ur.role in ('hub_manager', 'hub_handler') and (ur.hub_id = m.dest_hub_id or (ur.hub_id is null and ur.city_id = (select city_id from public.hubs where id = m.dest_hub_id)));
  return jsonb_build_object('ok', true, 'parcels', n);
end $$;

create or replace function public.arrive_manifest(p_manifest uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare m public.manifests;
begin
  select * into m from public.manifests where id = p_manifest for update;
  perform public._need(found and public._hub_staff(m.dest_hub_id), 'Destination hub staff only');
  perform public._need(m.status = 'departed', 'This manifest is not on the road');
  update public.manifests set status = 'arrived', arrived_at = now(), received_by = auth.uid() where id = m.id;
end $$;

/** After unloading: anything on the manifest that was not scanned in is reported missing (parcel stays DEPARTED_HUB, flagged). */
create or replace function public.close_manifest(p_manifest uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare m public.manifests; missing jsonb;
begin
  select * into m from public.manifests where id = p_manifest for update;
  perform public._need(found and public._hub_staff(m.dest_hub_id), 'Destination hub staff only');
  perform public._need(m.status = 'arrived', 'Mark the bus as arrived first');
  select coalesce(jsonb_agg(o.tracking_number), '[]') into missing
  from public.orders o join public.bag_items i on i.order_id = o.id join public.hub_bags b on b.id = i.bag_id
  where b.manifest_id = m.id and i.removed_at is null and o.status = 'DEPARTED_HUB';
  perform public._need(jsonb_array_length(missing) = 0 or coalesce(length(trim(p_note)), 0) >= 5,
                       format('%s parcel(s) not received: %s. Write what happened before closing.', jsonb_array_length(missing), missing #>> '{}'));
  perform set_config('qcs.audit_reason', coalesce(nullif(trim(p_note), ''), 'all parcels received'), true);
  update public.manifests set status = 'closed', closed_at = now(), note = concat_ws(' · ', note, nullif(trim(p_note), '')) where id = m.id;
  update public.hub_bags set status = 'emptied' where manifest_id = m.id;
  return jsonb_build_object('missing', missing);
end $$;

-- ---------- labels ----------
create or replace function public.mark_labels_printed(p_orders uuid[]) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._need(not exists (select 1 from public.orders o where o.id = any (p_orders) and not public._hub_staff(coalesce(o.current_hub_id, o.origin_hub_id))),
                       'Hub staff only');
  perform public._sys(1);
  update public.orders set label_printed_at = coalesce(label_printed_at, now()) where id = any (p_orders);
  perform public._sys(-1);
  insert into public.hub_scans (hub_id, kind, code, order_id, ok, scanned_by)
  select coalesce(current_hub_id, origin_hub_id), 'label', tracking_number, id, true, auth.uid() from public.orders where id = any (p_orders);
end $$;

-- ---------- last mile ----------
/** Turn parcels waiting at a destination hub into a delivery trip (pickup = the hub) and send it to riders. */
create or replace function public.plan_last_mile(p_hub uuid, p_orders uuid[]) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare h public.hubs; nt uuid; n int;
begin
  select * into h from public.hubs where id = p_hub;
  perform public._need(public.is_trusted() or public.has_role(array['super_admin','city_admin','dispatcher','hub_manager']::public.app_role[], h.city_id),
                       'Dispatchers or the hub manager plan delivery trips');
  perform public._need(coalesce(array_length(p_orders, 1), 0) between 1 and 25, 'Choose 1 to 25 parcels');
  select count(*) into n from public.orders where id = any (p_orders) and current_hub_id = p_hub and status in ('ARRIVED_DEST_HUB', 'AT_HUB')
     and coalesce(intercity_option::text, 'doorstep') = 'doorstep' and (trip_id is null or exists (select 1 from public.trips t where t.id = trip_id and t.status in ('COMPLETED', 'CANCELLED')));
  perform public._need(n = array_length(p_orders, 1), 'Only doorstep parcels waiting in this hub (and not already on a trip) can go on a delivery trip');
  insert into public.trips (trip_type, status, city_id, hub_id, created_by, pickup_location, ready_at)
  values ('intercity_last_mile', 'PLANNED', h.city_id, p_hub, auth.uid(), h.location, now()) returning id into nt;
  perform public._sys(1);
  update public.orders set trip_id = nt where id = any (p_orders);
  perform public._sys(-1);
  insert into public.order_stops (trip_id, order_id, kind, location, suggested_seq)
  select nt, o.id, 'pickup'::public.stop_kind, h.location, 0 from public.orders o where o.id = any (p_orders)
  union all
  select nt, o.id, 'dropoff'::public.stop_kind, o.dropoff_location, (row_number() over (order by o.created_at))::int from public.orders o where o.id = any (p_orders);
  perform public.start_dispatch(nt);
  return nt;
end $$;

-- the rider's job shows where to take / collect parcels at hubs
create or replace function public.my_job() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'trip', to_jsonb(t) - 'dispatch_ranking',
    'hub', case when t.trip_type in ('intercity_first_mile', 'intercity_last_mile') then
      (select jsonb_build_object('id', h.id, 'name', h.name, 'address', h.address, 'phone', h.phone, 'lat', st_y(h.location::geometry), 'lng', st_x(h.location::geometry))
       from public.hubs h where h.id = coalesce(t.hub_id, (select o2.origin_hub_id from public.orders o2 where o2.trip_id = t.id limit 1))) end,
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

-- ---------- hub board (Hub Manager) ----------
create or replace function public.hub_board(p_hub uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare h public.hubs; stuck int; late int;
begin
  select * into h from public.hubs where id = p_hub;
  perform public._need(found and (public._hub_staff(p_hub) or public.is_ops(h.city_id)), 'Not allowed');
  stuck := public._num_setting('hub_stuck_hours', h.city_id, 24); late := public._num_setting('linehaul_expected_hours', h.city_id, 12);
  return jsonb_build_object(
    'hub', jsonb_build_object('id', h.id, 'name', h.name, 'code', h.code, 'capacity', h.capacity),
    'counts', (select jsonb_build_object(
        'coming_in', (select count(*) from public.orders where origin_hub_id = p_hub and status in ('PICKED_UP', 'IN_TRANSIT')),
        'labels_to_print', count(*) filter (where label_printed_at is null and status = 'AT_HUB'),
        'to_sort', count(*) filter (where status = 'AT_HUB' and not exists (select 1 from public.bag_items i where i.order_id = o.id and i.removed_at is null and i.arrived_at is null)),
        'in_bags', count(*) filter (where status = 'AT_HUB' and exists (select 1 from public.bag_items i where i.order_id = o.id and i.removed_at is null and i.arrived_at is null)),
        'for_last_mile', count(*) filter (where status = 'ARRIVED_DEST_HUB'),
        'for_collection', count(*) filter (where status = 'READY_FOR_COLLECTION'),
        'on_the_road_to_here', (select count(*) from public.orders where dest_hub_id = p_hub and status = 'DEPARTED_HUB'),
        'in_hub', count(*))
      from public.orders o where o.current_hub_id = p_hub),
    'stuck', coalesce((select jsonb_agg(jsonb_build_object('tracking_number', o.tracking_number, 'status', o.status, 'since', e.at, 'dest', d.code) order by e.at)
      from public.orders o left join public.hubs d on d.id = o.dest_hub_id
      cross join lateral (select max(coalesce(ev.occurred_at, ev.created_at)) at from public.order_events ev where ev.order_id = o.id) e
      where o.current_hub_id = p_hub and e.at < now() - make_interval(hours => stuck)), '[]'::jsonb),
    'manifests', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'code', m.code, 'status', m.status, 'from', oh.code, 'to', dh.code,
        'bus', m.bus_company, 'vehicle', m.vehicle_reg, 'waybill', m.waybill_no, 'driver_phone', m.driver_phone, 'departed_at', m.departed_at,
        'sent', m.parcels_sent, 'received', m.parcels_received, 'late', m.status = 'departed' and m.departed_at < now() - make_interval(hours => late),
        'bags', (select count(*) from public.hub_bags b where b.manifest_id = m.id)) order by m.created_at desc)
      from public.manifests m join public.hubs oh on oh.id = m.origin_hub_id join public.hubs dh on dh.id = m.dest_hub_id
      where (m.origin_hub_id = p_hub or m.dest_hub_id = p_hub) and (m.status <> 'closed' or m.closed_at > now() - interval '2 days')), '[]'::jsonb),
    'bags', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'status', b.status, 'to', dh.code, 'dest_hub_id', b.dest_hub_id,
        'items', (select count(*) from public.bag_items i where i.bag_id = b.id and i.removed_at is null)) order by b.created_at)
      from public.hub_bags b join public.hubs dh on dh.id = b.dest_hub_id where b.hub_id = p_hub and b.status in ('open', 'sealed') and b.manifest_id is null), '[]'::jsonb),
    'scans', coalesce((select jsonb_agg(x) from (select jsonb_build_object('at', coalesce(s.occurred_at, s.created_at), 'kind', s.kind, 'code', s.code, 'ok', s.ok,
        'by', p.full_name, 'error', s.result ->> 'error') x from public.hub_scans s left join public.profiles p on p.id = s.scanned_by
        where s.hub_id = p_hub order by s.id desc limit 50) z), '[]'::jsonb));
end $$;

/** Riders with a delivery trip from this hub, for the hand-over screen. */
create or replace function public.hub_handover_riders(p_hub uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('rider_id', t.rider_id, 'name', p.full_name, 'phone', p.phone, 'trip_id', t.id,
    'parcels', (select jsonb_agg(o.tracking_number) from public.orders o where o.trip_id = t.id and o.status in ('ARRIVED_DEST_HUB', 'AT_HUB')))), '[]'::jsonb)
  from public.trips t join public.profiles p on p.id = t.rider_id
  where t.hub_id = p_hub and t.status in ('ASSIGNED', 'IN_PROGRESS') and public._hub_staff(p_hub)
    and exists (select 1 from public.orders o where o.trip_id = t.id and o.status in ('ARRIVED_DEST_HUB', 'AT_HUB'));
$$;

insert into public.notification_templates (key, channel, audience, subject, body, essential, description) values
  ('manifest_departed', 'push', 'staff', 'Bus on the way', '{{code}}: {{parcels}} parcels on {{bus}} ({{vehicle}}).', true, 'Line-haul left for your hub')
on conflict do nothing;

grant execute on function public.open_bag(uuid, uuid), public.seal_bag(uuid, text), public.hub_scan(uuid, jsonb, timestamptz),
  public.create_manifest(uuid, uuid), public.add_bag_to_manifest(uuid, text), public.dispatch_manifest(uuid, jsonb), public.arrive_manifest(uuid),
  public.close_manifest(uuid, text), public.mark_labels_printed(uuid[]), public.plan_last_mile(uuid, uuid[]), public.hub_board(uuid),
  public.hub_handover_riders(uuid) to authenticated;
revoke all on function public._arrive_parcel(public.orders, uuid), public._order_by_code(text) from public, anon, authenticated;
