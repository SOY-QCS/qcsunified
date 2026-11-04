-- =====================================================================
-- QCS Unified — 003: business rules enforced by the database itself
-- (role checks, audit log, ledger, order status machine, trip limits)
-- =====================================================================

-- ---------- who is calling? ----------
-- "Trusted" = our own server code (service-role key, Edge Functions, scheduled jobs, migrations).
create or replace function public.is_trusted() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'trusted')
         in ('service_role', 'trusted');
$$;

-- Does the current user hold one of these roles (optionally for a given city)?
-- A role row with city_id NULL covers every city.
create or replace function public.has_role(p_roles public.app_role[], p_city uuid default null)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = any (p_roles)
      and (p_city is null or ur.city_id is null or ur.city_id = p_city)
  );
$$;

-- Ops staff who may look at data in a city (includes read-only analysts).
create or replace function public.is_ops(p_city uuid default null) returns boolean
language sql stable as $$
  select public.has_role(array['super_admin','city_admin','dispatcher','hub_manager','finance','support','analyst']::public.app_role[], p_city);
$$;

-- Ops staff who may change things in a city (everyone except analysts).
create or replace function public.is_ops_writer(p_city uuid default null) returns boolean
language sql stable as $$
  select public.has_role(array['super_admin','city_admin','dispatcher','hub_manager','finance','support']::public.app_role[], p_city);
$$;

create or replace function public.is_admin(p_city uuid default null) returns boolean
language sql stable as $$
  select public.has_role(array['super_admin']::public.app_role[]) or public.has_role(array['city_admin']::public.app_role[], p_city);
$$;

create or replace function public.is_finance() returns boolean
language sql stable as $$
  select public.has_role(array['super_admin','finance']::public.app_role[]);
$$;

-- Vendors the current user owns or works for (optionally needing a permission, e.g. 'wallet').
create or replace function public.my_vendor_ids(p_permission text default null)
returns setof uuid language sql stable security definer set search_path = public, extensions as $$
  select v.id from public.vendors v where v.owner_id = auth.uid()
  union
  select s.vendor_id from public.vendor_staff s
  where s.user_id = auth.uid() and s.is_active and (p_permission is null or p_permission = any (s.permissions));
$$;

-- Hubs the current user works at (hub handler / hub manager). A city-wide role covers all hubs in that city.
create or replace function public.my_hub_ids()
returns setof uuid language sql stable security definer set search_path = public, extensions as $$
  select h.id from public.hubs h
  join public.user_roles ur on ur.user_id = auth.uid() and ur.role in ('hub_handler','hub_manager')
  where ur.hub_id = h.id or (ur.hub_id is null and (ur.city_id is null or ur.city_id = h.city_id));
$$;

-- Admin-editable settings: city value wins over the default (city_id NULL).
create or replace function public.get_setting(p_key text, p_city uuid default null)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select value from public.app_settings
  where key = p_key and (city_id = p_city or city_id is null)
  order by city_id nulls last limit 1;
$$;

-- ---------- audit log ----------
-- Records who changed what, before and after, and when (CLAUDE.md §4).
-- An optional reason can be passed with: select set_config('qcs.audit_reason', 'text', true);
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
begin
  insert into public.audit_log (actor_id, action, table_name, record_id, before, after, reason)
  values (auth.uid(), tg_op, tg_table_name,
          coalesce(a ->> 'id', b ->> 'id', a ->> 'key', b ->> 'key'),
          b, a, nullif(current_setting('qcs.audit_reason', true), ''));
  return coalesce(new, old);
end $$;

-- Tables where every change touches money, status or permissions:
create trigger audit_user_roles      after insert or update or delete on public.user_roles      for each row execute function public.audit_row();
create trigger audit_riders          after insert or update of status, rider_type, commission_rate_bp, cod_float_limit, cod_blocked, rating, score or delete on public.riders for each row execute function public.audit_row();
create trigger audit_rider_documents after update of status on public.rider_documents for each row execute function public.audit_row();
create trigger audit_vendors         after insert or update of owner_id, account_type, booking_blocked, cod_payout_on_hold, cod_payout_schedule, payout_momo_number or delete on public.vendors for each row execute function public.audit_row();
create trigger audit_vendor_staff    after insert or update or delete on public.vendor_staff    for each row execute function public.audit_row();
create trigger audit_orders_money    after update of quoted_fee, extra_fee, failed_fee, cod_amount, payer, payment_method, payment_status, rider_id, pod_override_by on public.orders for each row execute function public.audit_row();
create trigger audit_pricing_rules   after insert or update or delete on public.pricing_rules   for each row execute function public.audit_row();
create trigger audit_app_settings    after insert or update or delete on public.app_settings    for each row execute function public.audit_row();
create trigger audit_payouts         after insert or update or delete on public.payouts         for each row execute function public.audit_row();
create trigger audit_cod             after insert or update or delete on public.cod_collections for each row execute function public.audit_row();
create trigger audit_promo_codes     after insert or update or delete on public.promo_codes     for each row execute function public.audit_row();
create trigger audit_api_keys        after insert or update or delete on public.api_keys        for each row execute function public.audit_row();
create trigger audit_webhooks        after insert or update or delete on public.webhooks        for each row execute function public.audit_row();
-- Order status changes are recorded one-per-row in order_events (who, from, to, where, when).
-- Ledger entries are append-only, so the ledger is its own audit trail.

-- The audit log itself can never be edited or deleted.
create or replace function public.block_change() returns trigger language plpgsql as $$
begin raise exception '% is append-only', tg_table_name; end $$;
create trigger audit_log_append_only before update or delete on public.audit_log for each row execute function public.block_change();
create trigger order_events_append_only before update or delete on public.order_events for each row execute function public.block_change();

-- ---------- protected columns ----------
-- Vendors may edit their own profile, but not money controls or CRM fields.
create or replace function public.protect_vendor_columns() returns trigger language plpgsql as $$
begin
  if public.is_trusted() or public.is_ops_writer(old.city_id) then return new; end if;
  if (new.owner_id, new.account_type, new.booking_blocked, new.booking_block_reason, new.cod_payout_on_hold,
      new.crm_stage, new.account_manager_id, new.tags, new.notes, new.cs_service_enabled, new.fulfilment_enabled)
     is distinct from
     (old.owner_id, old.account_type, old.booking_blocked, old.booking_block_reason, old.cod_payout_on_hold,
      old.crm_stage, old.account_manager_id, old.tags, old.notes, old.cs_service_enabled, old.fulfilment_enabled) then
    raise exception 'Only QCS staff can change account controls on a vendor';
  end if;
  return new;
end $$;
create trigger vendors_protect before update on public.vendors for each row execute function public.protect_vendor_columns();

-- Riders may go online/offline, update location and payout number — nothing else.
create or replace function public.protect_rider_columns() returns trigger language plpgsql as $$
begin
  if public.is_trusted() or public.is_ops_writer(old.city_id) then return new; end if;
  if (new.rider_type, new.status, new.city_id, new.vehicle_id, new.commission_rate_bp, new.cod_float_limit,
      new.cod_float_balance, new.cod_blocked, new.rating, new.score, new.offers_received, new.offers_accepted)
     is distinct from
     (old.rider_type, old.status, old.city_id, old.vehicle_id, old.commission_rate_bp, old.cod_float_limit,
      old.cod_float_balance, old.cod_blocked, old.rating, old.score, old.offers_received, old.offers_accepted) then
    raise exception 'Only QCS staff can change rider status, pay, score or COD settings';
  end if;
  if new.is_online and old.status <> 'active' then
    raise exception 'Rider account is not active';
  end if;
  return new;
end $$;
create trigger riders_protect before update on public.riders for each row execute function public.protect_rider_columns();

-- Fees and payment fields on an order: Finance/Super Admin or our server only.
create or replace function public.protect_order_money() returns trigger language plpgsql as $$
begin
  if public.is_trusted() or public.is_finance() then return new; end if;
  if (new.quoted_fee, new.extra_fee, new.failed_fee, new.cod_amount, new.payer, new.payment_method, new.payment_status, new.price_breakdown)
     is distinct from
     (old.quoted_fee, old.extra_fee, old.failed_fee, old.cod_amount, old.payer, old.payment_method, old.payment_status, old.price_breakdown) then
    raise exception 'Only Finance can change prices or payment details on an order';
  end if;
  return new;
end $$;
create trigger orders_protect_money before update on public.orders for each row execute function public.protect_order_money();

-- ---------- ledger (double-entry money) ----------
-- Entries are append-only; a wallet balance only changes when an entry is posted.
create trigger ledger_entries_append_only before update or delete on public.ledger_entries for each row execute function public.block_change();
create trigger ledger_tx_append_only before update or delete on public.ledger_transactions for each row execute function public.block_change();

create or replace function public.apply_ledger_entry() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare w public.wallets;
begin
  perform set_config('qcs.ledger_write', 'on', true);
  update public.wallets set balance = balance + new.amount where id = new.wallet_id returning * into w;
  perform set_config('qcs.ledger_write', 'off', true);
  if w.owner_type = 'customer' and w.balance < 0 then
    raise exception 'Insufficient wallet balance';
  end if;
  return new;
end $$;
create trigger ledger_apply after insert on public.ledger_entries for each row execute function public.apply_ledger_entry();

-- Every transaction must balance to zero (checked at commit, so all its entries can be inserted first).
create or replace function public.check_ledger_balanced() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare total bigint; n int;
begin
  select coalesce(sum(amount), 0), count(*) into total, n from public.ledger_entries where transaction_id = new.transaction_id;
  if total <> 0 or n < 2 then
    raise exception 'Ledger transaction % does not balance (sum %, % entries)', new.transaction_id, total, n;
  end if;
  return null;
end $$;
create constraint trigger ledger_balanced after insert on public.ledger_entries
  deferrable initially deferred for each row execute function public.check_ledger_balanced();

-- Nobody edits a balance directly.
create or replace function public.protect_wallet_balance() returns trigger language plpgsql as $$
begin
  if new.balance is distinct from old.balance and coalesce(current_setting('qcs.ledger_write', true), '') <> 'on' then
    raise exception 'Wallet balances can only change through the ledger';
  end if;
  return new;
end $$;
create trigger wallets_protect before update on public.wallets for each row execute function public.protect_wallet_balance();

-- The one way to move money: post a balanced set of entries.
-- p_entries = [{"wallet_id": "...", "amount": 1500}, {"wallet_id": "...", "amount": -1500}]
create or replace function public.post_ledger_transaction(
  p_kind text, p_description text, p_entries jsonb,
  p_order_id uuid default null, p_external_ref text default null
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare tx uuid; e jsonb;
begin
  if not (public.is_trusted() or public.is_finance()) then
    raise exception 'Only Finance or the server can post ledger transactions';
  end if;
  insert into public.ledger_transactions (kind, description, order_id, external_ref, created_by)
  values (p_kind, coalesce(p_description, ''), p_order_id, p_external_ref, auth.uid()) returning id into tx;
  for e in select * from jsonb_array_elements(p_entries) loop
    insert into public.ledger_entries (transaction_id, wallet_id, amount)
    values (tx, (e ->> 'wallet_id')::uuid, (e ->> 'amount')::bigint);
  end loop;
  return tx;
end $$;

-- ---------- automatic records for new accounts ----------
-- New login → profile + customer role + customer wallet.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.profiles (id, phone, email, full_name)
  values (new.id, nullif(new.phone, ''), new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'customer') on conflict do nothing;
  insert into public.wallets (owner_type, owner_id) values ('customer', new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.create_owner_wallet() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.wallets (owner_type, owner_id)
  values (case tg_table_name when 'vendors' then 'vendor' else 'rider' end::public.wallet_owner, new.id)
  on conflict do nothing;
  return new;
end $$;
create trigger vendors_wallet after insert on public.vendors for each row execute function public.create_owner_wallet();
create trigger riders_wallet  after insert on public.riders  for each row execute function public.create_owner_wallet();

-- ---------- order status machine (CLAUDE.md §7) ----------
-- Status may only change through transition_order(), which checks the rules and writes order_events.
create or replace function public.guard_order_status() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' and not public.is_trusted() then
      raise exception 'New orders must start as DRAFT';
    end if;
  elsif new.status is distinct from old.status and coalesce(current_setting('qcs.transition', true), '') <> 'on' then
    raise exception 'Use transition_order() to change an order status';
  end if;
  return new;
end $$;
create trigger orders_guard_status before insert or update on public.orders for each row execute function public.guard_order_status();

create or replace function public.log_order_created() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.order_events (order_id, from_status, to_status, actor_id)
  values (new.id, null, new.status, auth.uid());
  return new;
end $$;
create trigger orders_created_event after insert on public.orders for each row execute function public.log_order_created();

create or replace function public.transition_order(
  p_order_id uuid,
  p_to public.order_status,
  p_lng double precision default null,
  p_lat double precision default null,
  p_note text default null,
  p_photo_path text default null,
  p_reason text default null
) returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare
  o public.orders;
  v public.vendors;
  uid uuid := auth.uid();
  pt geography;
  is_owner boolean;
  is_rider boolean;
  is_hub boolean;
  upfront boolean;
  radius_m numeric;
  ev bigint;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.vendor_id is not null then select * into v from public.vendors where id = o.vendor_id; end if;

  if not exists (select 1 from public.order_status_transitions where from_status = o.status and to_status = p_to) then
    raise exception 'Not allowed: % → %', o.status, p_to;
  end if;

  if p_lng is not null and p_lat is not null then
    pt := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
  end if;

  is_owner := o.customer_id = uid or o.vendor_id in (select public.my_vendor_ids());
  is_rider := o.rider_id is not null and o.rider_id = uid;
  is_hub   := public.has_role(array['hub_handler','hub_manager']::public.app_role[])
              and (o.origin_hub_id in (select public.my_hub_ids()) or o.dest_hub_id in (select public.my_hub_ids()));
  upfront  := o.payer = 'sender' and o.payment_method in ('card', 'momo');

  -- 1. Who may make this move?
  if not (public.is_trusted() or public.is_ops_writer(o.city_id)) then
    if is_rider and p_to in ('RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','AT_HUB','OUT_FOR_DELIVERY',
                             'ARRIVED_AT_DROPOFF','DELIVERED','FAILED_ATTEMPT','RETURNING_TO_SENDER','RETURNED') then
      null;
    elsif is_hub and p_to in ('AT_HUB','DEPARTED_HUB','ARRIVED_DEST_HUB','READY_FOR_COLLECTION','COLLECTED','OUT_FOR_DELIVERY') then
      null;
    elsif is_owner and (
        (o.status = 'DRAFT' and p_to in ('PENDING_PAYMENT','CONFIRMED'))
        or (p_to = 'CANCELLED' and o.status in ('DRAFT','PENDING_PAYMENT','CONFIRMED','SEARCHING_RIDER','ASSIGNED'))
      ) then
      null;
    else
      raise exception 'You are not allowed to move this order to %', p_to;
    end if;
  end if;

  -- 2. Payment step: only upfront card/MoMo orders wait for payment (§7).
  if o.status = 'DRAFT' and p_to = 'PENDING_PAYMENT' and not upfront then
    raise exception 'This order does not need upfront payment; confirm it directly';
  end if;
  if o.status = 'DRAFT' and p_to = 'CONFIRMED' and upfront then
    raise exception 'Card/MoMo orders must be paid before they are confirmed';
  end if;
  if o.status = 'PENDING_PAYMENT' and p_to = 'CONFIRMED' and not (public.is_trusted() or public.is_finance()) then
    raise exception 'Payment confirmation comes from Hubtel (server) or Finance';
  end if;

  -- 3. Corporate credit limit (§4).
  if o.status = 'DRAFT' and p_to in ('PENDING_PAYMENT','CONFIRMED') and v.booking_blocked then
    raise exception 'Bookings are on hold for this account: %', coalesce(v.booking_block_reason, 'unpaid invoices');
  end if;

  -- 4. Reasons and proof.
  if p_to = 'FAILED_ATTEMPT' and coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required for a failed attempt';
  end if;
  if p_to in ('DELIVERED', 'COLLECTED') then
    if not ((o.pod_otp_verified_at is not null and o.pod_signature_path is not null)
            or (o.pod_override_by is not null and o.pod_photo_path is not null)) then
      raise exception 'Proof of delivery missing: OTP + signature (or an approved override with photo)';
    end if;
    if coalesce(v.pod_require_photo, false) and o.pod_photo_path is null and p_photo_path is null then
      raise exception 'This vendor requires a delivery photo';
    end if;
  end if;

  -- 5. Geofence: a rider must be near the drop-off to mark it delivered (§8).
  if p_to = 'DELIVERED' and is_rider and not public.is_ops_writer(o.city_id) and o.pod_override_by is null then
    if pt is null then raise exception 'Location is required to mark delivered'; end if;
    radius_m := coalesce((public.get_setting('geofence_radius_m', o.city_id))::numeric, 3000);
    if st_distance(pt, o.dropoff_location) > radius_m then
      raise exception 'You are % m from the drop-off (limit % m). Ask dispatch for an override.',
        round(st_distance(pt, o.dropoff_location)), radius_m;
    end if;
  end if;

  -- 6. Apply.
  perform set_config('qcs.transition', 'on', true);
  update public.orders
     set status = p_to,
         delivered_at = case when p_to in ('DELIVERED','COLLECTED') then now() else delivered_at end,
         pod_photo_path = coalesce(p_photo_path, pod_photo_path)
   where id = o.id;
  perform set_config('qcs.transition', 'off', true);

  insert into public.order_events (order_id, from_status, to_status, actor_id, location, photo_path, note, reason)
  values (o.id, o.status, p_to, uid, pt, p_photo_path, p_note, p_reason)
  returning id into ev;
  return ev;
end $$;

-- ---------- trips ----------
-- A bulk trip holds at most 25 orders (§5/§6); an express trip holds one.
create or replace function public.check_trip_capacity() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare t public.trips; n int;
begin
  if new.trip_id is null or new.trip_id is not distinct from (case when tg_op = 'UPDATE' then old.trip_id end) then
    return new;
  end if;
  select * into t from public.trips where id = new.trip_id for update;
  select count(*) into n from public.orders where trip_id = new.trip_id and id <> new.id;
  if t.trip_type = 'express' and n >= 1 then raise exception 'An express trip holds one order'; end if;
  if n >= 25 then raise exception 'A trip can hold at most 25 orders'; end if;
  return new;
end $$;
create trigger orders_trip_capacity before insert or update of trip_id on public.orders for each row execute function public.check_trip_capacity();

-- ---------- COD cash float (§9) ----------
create or replace function public.track_cod_float() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    update public.riders
       set cod_float_balance = cod_float_balance + new.amount,
           cod_blocked = (cod_float_balance + new.amount) >= cod_float_limit
     where id = new.rider_id;
  elsif old.status = 'collected' and new.status <> 'collected' then
    update public.riders
       set cod_float_balance = greatest(0, cod_float_balance - new.amount),
           cod_blocked = (greatest(0, cod_float_balance - new.amount)) >= cod_float_limit
                         or exists (select 1 from public.cod_collections c
                                    where c.rider_id = new.rider_id and c.status = 'collected'
                                      and c.id <> new.id and c.remit_due_by < now())
     where id = new.rider_id;
  end if;
  return new;
end $$;
create trigger cod_float after insert or update of status on public.cod_collections for each row execute function public.track_cod_float();

-- ---------- housekeeping (scheduled with pg_cron where available) ----------
create or replace function public.purge_idle_location_pings() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare n int; days int := coalesce((public.get_setting('idle_ping_retention_days'))::int, 7);
begin
  delete from public.rider_location_pings where trip_id is null and recorded_at < now() - make_interval(days => days);
  get diagnostics n = row_count;
  return n;
end $$;

-- Riders who missed the end-of-day COD deadline get no new COD jobs until they remit.
create or replace function public.block_overdue_cod_riders() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  update public.riders r set cod_blocked = true
   where not r.cod_blocked
     and exists (select 1 from public.cod_collections c where c.rider_id = r.id and c.status = 'collected' and c.remit_due_by < now());
  get diagnostics n = row_count;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('purge-idle-pings', '15 2 * * *', 'select public.purge_idle_location_pings()');
    perform cron.schedule('block-overdue-cod', '5 0 * * *', 'select public.block_overdue_cod_riders()');
  end if;
end $$;

-- ---------- sign-up safety ----------
-- A vendor owner automatically gets the vendor_owner role.
create or replace function public.grant_vendor_owner_role() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.owner_id is not null then
    insert into public.user_roles (user_id, role, city_id)
    values (new.owner_id, case when new.account_type = 'corporate' then 'corporate' else 'vendor_owner' end::public.app_role, null)
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger vendors_owner_role after insert or update of owner_id on public.vendors for each row execute function public.grant_vendor_owner_role();

-- Rider sign-up: whatever the app sends, a new rider starts as an applicant with default pay/COD settings.
create or replace function public.rider_signup_defaults() returns trigger language plpgsql as $$
begin
  if public.is_trusted() or public.is_ops_writer(new.city_id) then return new; end if;
  new.status := 'applicant';
  new.commission_rate_bp := null;
  new.cod_float_limit := 50000;
  new.cod_float_balance := 0;
  new.cod_blocked := false;
  new.rating := 5.00;
  new.score := 100;
  new.offers_received := 0;
  new.offers_accepted := 0;
  new.is_online := false;
  new.vehicle_id := null;
  return new;
end $$;
create trigger riders_signup_defaults before insert on public.riders for each row execute function public.rider_signup_defaults();
