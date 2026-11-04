-- =====================================================================
-- Phase 9b — Fulfilment (vendor stock stored at QCS hubs) + switching on inter-city & stock bookings
--   SKUs per vendor · stock per hub and shelf/bin · every movement recorded · stock reserved at booking
--   · pick (scan each product) → pack → ships like any parcel · low-stock alerts · monthly storage fee
--   · pick-pack fee per order (both billed to the vendor wallet; rates per hub)
-- =====================================================================

alter table public.hubs
  add column pick_pack_fee        bigint not null default 300 check (pick_pack_fee >= 0),      -- pesewas per order packed
  add column storage_fee_per_unit bigint not null default 50  check (storage_fee_per_unit >= 0); -- pesewas per unit per month

create table public.skus (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors(id),
  sku          text not null,                      -- the vendor's product code
  name         text not null,
  barcode      text,                               -- printed on the product (scanned at the hub)
  weight_g     integer not null default 500 check (weight_g > 0),
  unit_value   bigint not null default 0 check (unit_value >= 0),
  low_stock_at integer not null default 5 check (low_stock_at >= 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (vendor_id, sku)
);
create unique index skus_barcode_per_vendor on public.skus (vendor_id, barcode) where barcode is not null;

create table public.stock (
  hub_id    uuid not null references public.hubs(id),
  sku_id    uuid not null references public.skus(id),
  vendor_id uuid not null references public.vendors(id),
  location  text not null default 'RECEIVING',     -- shelf / bin, e.g. A-03-2
  on_hand   integer not null default 0 check (on_hand >= 0),
  low_alerted boolean not null default false,
  primary key (hub_id, sku_id, location)
);
create table public.stock_movements (
  id         bigint generated always as identity primary key,
  hub_id     uuid not null references public.hubs(id),
  sku_id     uuid not null references public.skus(id),
  vendor_id  uuid not null references public.vendors(id),
  location   text not null,
  change     integer not null check (change <> 0),
  kind       text not null check (kind in ('receive', 'pick', 'adjust', 'return', 'move')),
  order_id   uuid references public.orders(id),
  reference  text,
  moved_by   uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index stock_movements_vendor_idx on public.stock_movements (vendor_id, created_at desc);
create trigger stock_movements_append_only before update or delete on public.stock_movements for each row execute function public.block_change();

create table public.order_items (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  sku_id   uuid not null references public.skus(id),
  qty      integer not null check (qty > 0),
  picked   integer not null default 0 check (picked >= 0),
  released boolean not null default false,          -- cancelled before shipping: reservation given back
  check (picked <= qty)
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_sku_idx on public.order_items (sku_id) where not released;

create table public.fulfilment_charges (
  id        uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id),
  hub_id    uuid not null references public.hubs(id),
  kind      text not null check (kind in ('storage', 'pick_pack')),
  period    date,                                    -- storage: the month
  order_id  uuid references public.orders(id),
  units     integer not null,
  amount    bigint not null,
  ledger_tx uuid references public.ledger_transactions(id),
  created_at timestamptz not null default now()
);
create unique index fulfilment_storage_once on public.fulfilment_charges (vendor_id, hub_id, period) where kind = 'storage';
create unique index fulfilment_pickpack_once on public.fulfilment_charges (order_id) where kind = 'pick_pack';

-- available = on the shelves − reserved for orders not yet picked
create view public.stock_levels with (security_invoker = true) as
select s.vendor_id, s.hub_id, s.sku_id, k.sku, k.name, k.barcode, k.low_stock_at,
       sum(s.on_hand)::int as on_hand,
       coalesce((select sum(i.qty - i.picked) from public.order_items i join public.orders o on o.id = i.order_id
                 where i.sku_id = s.sku_id and o.fulfilment_hub_id = s.hub_id and not i.released and o.fulfilment_state = 'to_pick'), 0)::int as reserved,
       (sum(s.on_hand) - coalesce((select sum(i.qty - i.picked) from public.order_items i join public.orders o on o.id = i.order_id
                 where i.sku_id = s.sku_id and o.fulfilment_hub_id = s.hub_id and not i.released and o.fulfilment_state = 'to_pick'), 0))::int as available,
       jsonb_object_agg(s.location, s.on_hand) filter (where s.on_hand > 0) as locations
from public.stock s join public.skus k on k.id = s.sku_id
group by s.vendor_id, s.hub_id, s.sku_id, k.sku, k.name, k.barcode, k.low_stock_at;
grant select on public.stock_levels to authenticated, service_role;

alter table public.skus enable row level security;
alter table public.stock enable row level security;
alter table public.stock_movements enable row level security;
alter table public.order_items enable row level security;
alter table public.fulfilment_charges enable row level security;
create policy skus_read on public.skus for select to authenticated using (vendor_id in (select public.my_vendor_ids()) or public.is_ops() or public.has_role(array['hub_handler']::public.app_role[]));
create policy stock_read on public.stock for select to authenticated using (vendor_id in (select public.my_vendor_ids()) or public._hub_staff(hub_id) or public.is_ops((select city_id from public.hubs where id = hub_id)));
create policy moves_read on public.stock_movements for select to authenticated using (vendor_id in (select public.my_vendor_ids()) or public._hub_staff(hub_id) or public.is_ops((select city_id from public.hubs where id = hub_id)));
create policy items_read on public.order_items for select to authenticated using (exists (select 1 from public.orders o where o.id = order_id));   -- orders RLS decides
create policy charges_read on public.fulfilment_charges for select to authenticated using (vendor_id in (select public.my_vendor_ids('wallet')) or public.is_finance() or public._hub_staff(hub_id));
create trigger audit_stock_adjust after insert on public.stock_movements for each row when (new.kind = 'adjust') execute function public.audit_row();

-- ---------- products ----------
create or replace function public.save_sku(p_id uuid, p_vendor uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare id uuid := p_id;
begin
  perform public._need(p_vendor in (select public.my_vendor_ids()) or public.is_ops_writer() or exists (select 1 from public.my_hub_ids()), 'Not allowed');
  perform public._need(exists (select 1 from public.vendors where vendors.id = p_vendor and fulfilment_enabled), 'Fulfilment is not switched on for this vendor — ask QCS');
  perform public._need(length(trim(coalesce(p ->> 'sku', ''))) between 1 and 60 and length(trim(coalesce(p ->> 'name', ''))) >= 2, 'Product code and name are needed');
  if id is null then
    insert into public.skus (vendor_id, sku, name, barcode, weight_g, unit_value, low_stock_at)
    values (p_vendor, upper(trim(p ->> 'sku')), trim(p ->> 'name'), nullif(trim(p ->> 'barcode'), ''), coalesce((p ->> 'weight_g')::int, 500),
            coalesce((p ->> 'unit_value')::bigint, 0), coalesce((p ->> 'low_stock_at')::int, 5)) returning skus.id into id;
  else
    update public.skus set sku = upper(trim(p ->> 'sku')), name = trim(p ->> 'name'), barcode = nullif(trim(p ->> 'barcode'), ''),
           weight_g = coalesce((p ->> 'weight_g')::int, weight_g), unit_value = coalesce((p ->> 'unit_value')::bigint, unit_value),
           low_stock_at = coalesce((p ->> 'low_stock_at')::int, low_stock_at), is_active = coalesce((p ->> 'is_active')::boolean, is_active)
     where skus.id = p_id and vendor_id = p_vendor;
    perform public._need(found, 'Product not found');
  end if;
  return id;
exception when unique_violation then raise exception 'That product code or barcode is already used';
end $$;

create or replace function public._sku_by_code(p_vendor uuid, p_code text) returns public.skus
language sql stable security definer set search_path = public, extensions as $$
  select * from public.skus where vendor_id = p_vendor and is_active and (sku = upper(trim(p_code)) or barcode = trim(p_code)) limit 1;
$$;

-- ---------- stock movements (one place that changes stock) ----------
create or replace function public._move_stock(p_hub uuid, k public.skus, p_location text, p_change int, p_kind text, p_order uuid, p_ref text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare avail int;
begin
  insert into public.stock (hub_id, sku_id, vendor_id, location, on_hand) values (p_hub, k.id, k.vendor_id, upper(trim(p_location)), 0) on conflict do nothing;
  update public.stock set on_hand = on_hand + p_change where hub_id = p_hub and sku_id = k.id and location = upper(trim(p_location));
  insert into public.stock_movements (hub_id, sku_id, vendor_id, location, change, kind, order_id, reference, moved_by)
  values (p_hub, k.id, k.vendor_id, upper(trim(p_location)), p_change, p_kind, p_order, p_ref, auth.uid());
  -- low-stock alert once when it drops to the threshold; reset when restocked
  select available into avail from public.stock_levels where hub_id = p_hub and sku_id = k.id;
  if avail <= k.low_stock_at and not exists (select 1 from public.stock where hub_id = p_hub and sku_id = k.id and low_alerted) then
    update public.stock set low_alerted = true where hub_id = p_hub and sku_id = k.id;
    perform public._enqueue(v.owner_id, null, null, 'low_stock', jsonb_build_object('sku', k.sku, 'name', k.name, 'available', avail,
            'hub_name', (select name from public.hubs where id = p_hub)))
    from public.vendors v where v.id = k.vendor_id and v.owner_id is not null;
  elsif avail > k.low_stock_at then
    update public.stock set low_alerted = false where hub_id = p_hub and sku_id = k.id and low_alerted;
  end if;
exception when check_violation then
  raise exception 'Not enough % on shelf % (that would go below zero)', k.sku, upper(trim(p_location));
end $$;

/** Receiving and picking scans (called from hub_scan so they work offline and are logged). */
create or replace function public._stock_scan(p_hub uuid, p_type text, a jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k public.skus; o public.orders; it public.order_items; loc text; v_qty int := greatest(1, coalesce((a ->> 'qty')::int, 1)); left_ int;
begin
  if p_type = 'receive' then
    k := public._sku_by_code((a ->> 'vendor_id')::uuid, a ->> 'code');
    perform public._need(k.id is not null, 'Unknown product ' || coalesce(a ->> 'code', '') || ' for this vendor — add it first');
    perform public._need(v_qty <= 10000, 'That quantity looks wrong');
    loc := coalesce(nullif(trim(a ->> 'location'), ''), 'RECEIVING');
    perform public._move_stock(p_hub, k, loc, v_qty, 'receive', null, a ->> 'reference');
    return jsonb_build_object('ok', true, 'sku', k.sku, 'name', k.name, 'received', v_qty, 'location', upper(loc),
                              'on_hand', (select on_hand from public.stock_levels where hub_id = p_hub and sku_id = k.id));
  end if;
  -- pick: scan a product for an order; it comes off the shelf
  select * into o from public.orders where id = (a ->> 'order_id')::uuid for update;
  perform public._need(o.id is not null and o.fulfilment_hub_id = p_hub and o.fulfilment_state = 'to_pick', 'This order is not waiting to be picked here');
  k := public._sku_by_code(o.vendor_id, a ->> 'code');
  select * into it from public.order_items oi where oi.order_id = o.id and oi.sku_id = k.id and oi.picked < oi.qty and not oi.released limit 1;
  perform public._need(k.id is not null and it.id is not null, coalesce(a ->> 'code', '') || ' is not on this order (or already picked)');
  v_qty := least(v_qty, it.qty - it.picked);
  loc := coalesce(nullif(upper(trim(a ->> 'location')), ''),
                  (select location from public.stock where hub_id = p_hub and sku_id = k.id and on_hand >= v_qty order by on_hand desc limit 1));
  perform public._need(loc is not null, 'No ' || k.sku || ' on the shelves — check the stock');
  perform public._move_stock(p_hub, k, loc, -v_qty, 'pick', o.id, o.tracking_number);
  update public.order_items set picked = picked + v_qty where id = it.id;
  select coalesce(sum(oi.qty - oi.picked), 0) into left_ from public.order_items oi where oi.order_id = o.id and not oi.released;
  return jsonb_build_object('ok', true, 'sku', k.sku, 'name', k.name, 'from', loc, 'left_to_pick', left_);
end $$;

create or replace function public.adjust_stock(p_hub uuid, p_sku uuid, p_location text, p_change int, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k public.skus; c uuid := (select city_id from public.hubs where id = p_hub);
begin
  perform public._need(public.has_role(array['super_admin','city_admin','hub_manager']::public.app_role[], c), 'Only the hub manager can correct stock');
  perform public._need(coalesce(length(trim(p_reason)), 0) >= 5 and p_change <> 0, 'Give the change and a reason (stock count, damage…)');
  select * into k from public.skus where id = p_sku;
  perform set_config('qcs.audit_reason', trim(p_reason), true);
  perform public._move_stock(p_hub, k, p_location, p_change, 'adjust', null, trim(p_reason));
end $$;

create or replace function public.move_stock(p_hub uuid, p_sku uuid, p_from text, p_to text, p_qty int) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k public.skus;
begin
  perform public._need(public._hub_staff(p_hub), 'Hub staff only');
  perform public._need(p_qty > 0 and upper(trim(p_from)) <> upper(trim(p_to)), 'Choose the quantity and a different shelf');
  select * into k from public.skus where id = p_sku;
  perform public._move_stock(p_hub, k, p_from, -p_qty, 'move', null, 'to ' || upper(trim(p_to)));
  perform public._move_stock(p_hub, k, p_to, p_qty, 'move', null, 'from ' || upper(trim(p_from)));
end $$;

-- ---------- orders from stock ----------
create or replace function public._attach_items(p_order uuid, p_hub uuid, p_items jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare it jsonb; k public.skus; avail int; v uuid := (select vendor_id from public.orders where id = p_order);
begin
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    select * into k from public.skus where id = (it ->> 'sku_id')::uuid and vendor_id = v and is_active for update;   -- locks the product: no double selling
    perform public._need(k.id is not null, 'Unknown product on this order');
    select coalesce(available, 0) into avail from public.stock_levels where hub_id = p_hub and sku_id = k.id;
    perform public._need(coalesce(avail, 0) >= (it ->> 'qty')::int, format('Not enough %s at the hub (%s available)', k.name, coalesce(avail, 0)));
    insert into public.order_items (order_id, sku_id, qty) values (p_order, k.id, (it ->> 'qty')::int);
  end loop;
end $$;

/** All products picked → packed. Charges the pick-pack fee; inter-city parcels go straight into the hub flow. */
create or replace function public.pack_order(p_order uuid, p_weight_g int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; h public.hubs; tx uuid;
begin
  select * into o from public.orders where id = p_order for update;
  perform public._need(o.id is not null and o.fulfilment_state = 'to_pick' and public._hub_staff(o.fulfilment_hub_id), 'This order is not waiting to be packed here');
  perform public._need(not exists (select 1 from public.order_items where order_id = o.id and not released and picked < qty), 'Pick every product first');
  select * into h from public.hubs where id = o.fulfilment_hub_id;
  perform public._sys(1);
  update public.orders set fulfilment_state = 'packed', weight_g = coalesce(p_weight_g, weight_g) where id = o.id;
  if h.pick_pack_fee > 0 then
    tx := public._ledger('fulfilment_fee', 'Pick & pack ' || o.tracking_number, jsonb_build_array(
      jsonb_build_object('wallet_id', public.wallet_for('vendor', o.vendor_id), 'amount', -h.pick_pack_fee),
      jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', h.pick_pack_fee)), o.id);
    insert into public.fulfilment_charges (vendor_id, hub_id, kind, order_id, units, amount, ledger_tx)
    values (o.vendor_id, h.id, 'pick_pack', o.id, (select sum(qty) from public.order_items where order_id = o.id), h.pick_pack_fee, tx);
  end if;
  if o.service_type = 'intercity' and o.status = 'CONFIRMED' then
    perform public.transition_order(o.id, 'AT_HUB', null, null, 'Packed at hub', null, null);
    update public.orders set current_hub_id = h.id where id = o.id;
  end if;
  perform public._sys(-1);
  return jsonb_build_object('ok', true, 'next', case when o.service_type = 'intercity' then 'print_label' else 'ready_for_rider' end);
end $$;

-- cancelled before shipping: picked products go back on a returns shelf; reservations end
create or replace function public.release_items_on_cancel() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare it record; k public.skus;
begin
  if new.status = 'CANCELLED' and old.status <> 'CANCELLED' and new.fulfilment_hub_id is not null then
    for it in select * from public.order_items where order_id = new.id and not released loop
      if it.picked > 0 then
        select * into k from public.skus where id = it.sku_id;
        perform public._move_stock(new.fulfilment_hub_id, k, 'RETURNS', it.picked, 'return', new.id, 'cancelled order');
      end if;
    end loop;
    update public.order_items set released = true where order_id = new.id;
  end if;
  return new;
end $$;
create trigger orders_release_items after update of status on public.orders for each row execute function public.release_items_on_cancel();

create or replace function public.pick_list(p_hub uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'tracking_number', o.tracking_number, 'vendor', v.business_name, 'service', o.service_type,
    'recipient', o.recipient_name, 'booked', o.created_at,
    'items', (select jsonb_agg(jsonb_build_object('sku', k.sku, 'name', k.name, 'barcode', k.barcode, 'qty', i.qty, 'picked', i.picked,
               'locations', (select jsonb_object_agg(s.location, s.on_hand) from public.stock s where s.hub_id = p_hub and s.sku_id = k.id and s.on_hand > 0)))
              from public.order_items i join public.skus k on k.id = i.sku_id where i.order_id = o.id and not i.released)) order by o.created_at), '[]'::jsonb)
  from public.orders o join public.vendors v on v.id = o.vendor_id
  where o.fulfilment_hub_id = p_hub and o.fulfilment_state = 'to_pick' and o.status not in ('CANCELLED', 'DRAFT', 'PENDING_PAYMENT') and public._hub_staff(p_hub);
$$;

/** Monthly storage fee: units on the shelves × the hub's rate, once per vendor per hub per month. */
create or replace function public.bill_storage(p_month date default null) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare m date := date_trunc('month', coalesce(p_month, (now() at time zone 'Africa/Accra')::date - 1))::date; r record; n int := 0; tx uuid;
begin
  perform public._need(public.is_trusted() or public.is_finance(), 'Finance only');
  for r in select s.vendor_id, s.hub_id, sum(s.on_hand)::int units, h.storage_fee_per_unit rate
           from public.stock s join public.hubs h on h.id = s.hub_id group by s.vendor_id, s.hub_id, h.storage_fee_per_unit having sum(s.on_hand) > 0 loop
    continue when r.rate = 0 or exists (select 1 from public.fulfilment_charges where vendor_id = r.vendor_id and hub_id = r.hub_id and kind = 'storage' and period = m);
    tx := public._ledger('storage_fee', format('Storage %s: %s units', to_char(m, 'Mon YYYY'), r.units), jsonb_build_array(
      jsonb_build_object('wallet_id', public.wallet_for('vendor', r.vendor_id), 'amount', -(r.units * r.rate)),
      jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', r.units * r.rate)));
    insert into public.fulfilment_charges (vendor_id, hub_id, kind, period, units, amount, ledger_tx) values (r.vendor_id, r.hub_id, 'storage', m, r.units, r.units * r.rate, tx);
    n := n + 1;
  end loop;
  return n;
end $$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('bill-storage', '0 5 1 * *', 'select public.bill_storage()');   -- 1st of the month, for the month before
  end if;
end $$;

insert into public.notification_templates (key, channel, audience, subject, body, essential, description) values
  ('low_stock', 'push',  'sender', 'Low stock', '{{name}} ({{sku}}) is low at {{hub_name}}: {{available}} left.', false, 'Stock at or below the alert level'),
  ('low_stock', 'email', 'sender', 'Low stock: {{name}}', 'Hello,\n\n{{name}} ({{sku}}) is low at {{hub_name}}: {{available}} left.\nSend more stock to the hub to keep orders going.\n\nQCS Fulfilment', false, 'Stock at or below the alert level')
on conflict do nothing;

grant execute on function public.save_sku(uuid, uuid, jsonb), public.adjust_stock(uuid, uuid, text, int, text), public.move_stock(uuid, uuid, text, text, int),
  public.pack_order(uuid, int), public.pick_list(uuid), public.bill_storage(date) to authenticated;
revoke all on function public._move_stock(uuid, public.skus, text, int, text, uuid, text), public._stock_scan(uuid, text, jsonb),
  public._attach_items(uuid, uuid, jsonb), public._sku_by_code(uuid, text) from public, anon, authenticated;

-- hub rates are edited with the hub (Ops → Hubs)
create or replace function public.set_hub_fulfilment_rates(p_hub uuid, p_pick_pack bigint, p_storage bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._need(public.is_finance() or public.is_admin((select city_id from public.hubs where id = p_hub)), 'Only an Admin or Finance can change rates');
  perform public._need(p_pick_pack >= 0 and p_storage >= 0, 'Rates can''t be negative');
  update public.hubs set pick_pack_fee = p_pick_pack, storage_fee_per_unit = p_storage where id = p_hub;
end $$;
grant execute on function public.set_hub_fulfilment_rates(uuid, bigint, bigint) to authenticated;

-- An inter-city parcel pays the first-mile rider (at the hub) and the last-mile rider (at the door):
-- "paid once" is per parcel per rider.
drop index public.rider_earnings_once_per_order;
create unique index rider_earnings_once_per_order on public.rider_earnings (order_id, kind, rider_id) where kind in ('delivery', 'commission');

-- ---------- switching on inter-city and stock bookings in the booking function ----------
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

  -- stock orders start at the hub (no pickup trip); inter-city always gets a first-mile trip to the hub
  if req ->> 'fulfilment_hub_id' is null and ((q.service_type = 'ecommerce' and n > 1) or q.service_type = 'intercity') then
    insert into public.trips (trip_type, status, city_id, vendor_id, created_by)
    values (case when q.service_type = 'intercity' then 'intercity_first_mile' else 'bulk' end::public.trip_type, 'PLANNED', q.city_id, q.vendor_id, p_user) returning id into v_trip;
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
      scheduled_pickup_at, pickup_date, trip_id, quote_id, origin_hub_id, dest_hub_id, intercity_option, fulfilment_hub_id, fulfilment_state
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
      nullif(req ->> 'scheduled_at', '')::timestamptz, nullif(q.price ->> 'pickupDate', '')::date, v_trip, q.id,
      nullif(q.price -> 'stops' -> i ->> 'originHubId', '')::uuid, nullif(q.price -> 'stops' -> i ->> 'destHubId', '')::uuid,
      case when q.service_type = 'intercity' then (req ->> 'intercity_option')::public.intercity_option end,
      nullif(req ->> 'fulfilment_hub_id', '')::uuid, case when req ->> 'fulfilment_hub_id' is not null then 'to_pick' end
    ) returning id into o_id;

    if req ->> 'fulfilment_hub_id' is not null then
      perform public._attach_items(o_id, (req ->> 'fulfilment_hub_id')::uuid, d -> 'items');   -- reserves the stock
    end if;

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

  perform public._charge_booking(q.id);   -- wallet payments and vendor insurance premiums
  update public.quotes set used_at = now() where id = q.id;
  return jsonb_build_object('trip_id', v_trip, 'needs_payment', upfront, 'total', q.total, 'orders', out,
                            'paid_from_wallet', (req ->> 'payer') = 'sender' and (req ->> 'payment_method') = 'wallet');
end $$;

-- last-mile riders collecting at a hub get the pickup fee too
create or replace function public.rider_pay_on_status() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare r public.riders; pay jsonb; actor uuid; rate int;
begin
  if new.status = old.status then return new; end if;
  -- whoever did the step gets paid: the rider on the order at that moment
  actor := new.rider_id;
  if actor is null then return new; end if;
  select * into r from public.riders where id = actor;
  if not found then return new; end if;
  pay := coalesce(public.get_setting('rider_pay', new.city_id), '{}');
  perform public._sys(1);
  if (new.status = 'PICKED_UP' or (new.status = 'OUT_FOR_DELIVERY' and old.status in ('ARRIVED_DEST_HUB', 'AT_HUB'))) and r.rider_type = 'fleet' then
    perform public._earn(actor, 'pickup', case when new.trip_id is null then 0 else coalesce((pay ->> 'fleet_pickup_fee')::bigint, 0) end, null, new.trip_id,
                         'Pickup ' || coalesce((select coalesce(v.business_name, '') from public.vendors v where v.id = new.vendor_id), '') || ' ' || new.tracking_number);
  elsif new.status in ('DELIVERED', 'COLLECTED') or (new.status = 'AT_HUB' and old.status in ('PICKED_UP', 'IN_TRANSIT')) then
    if r.rider_type = 'fleet' or new.status = 'AT_HUB' then
      -- inter-city first mile (dropped at the hub) pays the stop fee to fleet and independent riders alike
      perform public._earn(actor, 'delivery', coalesce((pay ->> 'fleet_delivery_fee')::bigint, 0), new.id, new.trip_id,
                           case when new.status = 'AT_HUB' then 'Dropped at hub ' else 'Delivered ' end || new.tracking_number);
    else
      rate := coalesce(r.commission_rate_bp, (pay ->> 'default_commission_bp')::int, 0);
      perform public._earn(actor, 'commission', round((new.quoted_fee + new.extra_fee) * rate / 10000.0)::bigint, new.id, new.trip_id,
                           format('Delivered %s — %s%% of GHS %s', new.tracking_number, rate / 100.0, to_char((new.quoted_fee + new.extra_fee) / 100.0, 'FM999990.00')));
    end if;
  end if;
  perform public._sys(-1);
  return new;
end $$;

-- stock orders can only go on a trip once they are packed
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
     and o.status = 'CONFIRMED' and o.service_type = 'ecommerce' and coalesce(o.fulfilment_state, 'packed') = 'packed' and st_dwithin(o.pickup_location, first.pickup_location, 300);
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
  where o.rider_id is null and o.status in ('CONFIRMED','SEARCHING_RIDER') and coalesce(o.fulfilment_state, 'packed') = 'packed'
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

-- hub staff choose the vendor when receiving stock (they can't browse the vendor list otherwise)
create or replace function public.hub_vendors(p_hub uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.business_name) order by v.business_name), '[]'::jsonb)
  from public.vendors v where v.fulfilment_enabled and public._hub_staff(p_hub)
    and (v.city_id = (select city_id from public.hubs where id = p_hub) or exists (select 1 from public.stock s where s.vendor_id = v.id and s.hub_id = p_hub));
$$;
grant execute on function public.hub_vendors(uuid) to authenticated;
