-- =====================================================================
-- Phase 8 — Rider earnings, COD and payouts (all through the double-entry ledger)
--
-- Money map (+ = QCS owes that wallet's owner, − = they owe QCS / QCS holds it):
--   rider            rider's earnings, paid out weekly (or instant cash-out)
--   rider_cash       COD cash a rider is carrying (negative until handed in)
--   vendor_cod       COD money owed to a vendor (separate from their fees wallet: fees never come out of COD)
--   HUB_CASH         COD cash sitting in hub offices (negative until banked)
--   BANK             QCS bank account (cash deposits)
--   RIDER_EARNINGS_EXPENSE, PAYOUTS_PENDING, HUBTEL_CLEARING, PAYOUT_FEES: as before
--
--   collected:     rider_cash −X  /  vendor_cod +X
--   handed in:     rider_cash +X  /  HUBTEL_CLEARING −X (MoMo)  or  HUB_CASH −X (cash at hub)
--   banked:        HUB_CASH +X    /  BANK −X
--   earned:        rider +E       /  RIDER_EARNINGS_EXPENSE −E
--   payout queued: owner −X       /  PAYOUTS_PENDING +X       (money can't be paid twice)
--   payout sent:   PAYOUTS_PENDING −X / HUBTEL_CLEARING +amount, PAYOUT_FEES +fee
-- =====================================================================

insert into public.wallets (owner_type, system_code) values ('system', 'HUB_CASH'), ('system', 'BANK') on conflict do nothing;

insert into public.app_settings (key, value, description) values
  ('payout_two_person_rule', 'true', 'A payout batch must be approved by a different Finance person than the one who prepared it'),
  ('payout_min',             '1000', 'Smallest rider payout (pesewas); smaller balances roll over to next week'),
  ('rider_payout_weekday',   '1',    'Day rider payout batches are prepared (1 = Monday … 7 = Sunday)'),
  ('vendor_cod_weekday',     '1',    'Day weekly vendor COD payout batches are prepared (1 = Monday … 7 = Sunday)')
on conflict do nothing;

-- ---------- 1. rider earnings ----------
create table public.rider_earnings (
  id          uuid primary key default gen_random_uuid(),
  rider_id    uuid not null references public.riders(id),
  kind        text not null check (kind in ('pickup', 'delivery', 'commission', 'bonus', 'deduction')),
  amount      bigint not null,                      -- pesewas; deductions are negative
  order_id    uuid references public.orders(id),
  trip_id     uuid references public.trips(id),
  description text not null,
  ledger_tx   uuid references public.ledger_transactions(id),
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
-- each piece of work is paid once
create unique index rider_earnings_once_per_order on public.rider_earnings (order_id, kind) where kind in ('delivery', 'commission');
create unique index rider_earnings_once_per_pickup on public.rider_earnings (trip_id, rider_id) where kind = 'pickup';
create index rider_earnings_rider_idx on public.rider_earnings (rider_id, created_at desc);
alter table public.rider_earnings enable row level security;
create policy earnings_read on public.rider_earnings for select to authenticated using (
  rider_id = (select auth.uid()) or exists (select 1 from public.riders r where r.id = rider_earnings.rider_id and public.is_ops(r.city_id)));
create trigger rider_earnings_append_only before update or delete on public.rider_earnings for each row execute function public.block_change();

create or replace function public._earn(p_rider uuid, p_kind text, p_amount bigint, p_order uuid, p_trip uuid, p_desc text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare tx uuid;
begin
  if coalesce(p_amount, 0) = 0 then return; end if;
  -- each piece of work is paid once (the unique indexes are the final guard)
  begin
    tx := public._ledger('rider_earning', p_desc, jsonb_build_array(
      jsonb_build_object('wallet_id', public.wallet_for('rider', p_rider), 'amount', p_amount),
      jsonb_build_object('wallet_id', public.sys_wallet('RIDER_EARNINGS_EXPENSE'), 'amount', -p_amount)), p_order);
    insert into public.rider_earnings (rider_id, kind, amount, order_id, trip_id, description, ledger_tx, created_by)
    values (p_rider, p_kind, p_amount, p_order, p_trip, p_desc, tx, auth.uid());
  exception when unique_violation then
    null;   -- already paid: the ledger entry above is undone with it
  end;
end $$;

/** The earnings engine. QCS fleet: pickup fee once per trip + fee per successful stop. Independent: commission % of the delivery fee. */
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
  if new.status = 'PICKED_UP' and r.rider_type = 'fleet' then
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
create trigger orders_rider_pay after update of status on public.orders for each row execute function public.rider_pay_on_status();

/** Bonus or deduction, by Finance (or a Super Admin), with a reason. */
create or replace function public.add_rider_adjustment(p_rider uuid, p_kind text, p_amount bigint, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._need(public.is_finance(), 'Only Finance can add bonuses or deductions');
  perform public._need(p_kind in ('bonus', 'deduction'), 'Choose bonus or deduction');
  perform public._need(p_amount > 0, 'Amount must be more than zero');
  perform public._need(coalesce(length(trim(p_reason)), 0) >= 5, 'Give a short reason');
  perform public._need(exists (select 1 from public.riders where id = p_rider), 'Rider not found');
  perform set_config('qcs.audit_reason', trim(p_reason), true);
  insert into public.rider_earnings (rider_id, kind, amount, description, created_by, ledger_tx)
  values (p_rider, p_kind, case when p_kind = 'bonus' then p_amount else -p_amount end, initcap(p_kind) || ': ' || trim(p_reason), auth.uid(),
    public._ledger('rider_' || p_kind, initcap(p_kind) || ': ' || trim(p_reason), jsonb_build_array(
      jsonb_build_object('wallet_id', public.wallet_for('rider', p_rider), 'amount', case when p_kind = 'bonus' then p_amount else -p_amount end),
      jsonb_build_object('wallet_id', public.sys_wallet('RIDER_EARNINGS_EXPENSE'), 'amount', case when p_kind = 'bonus' then -p_amount else p_amount end))));
end $$;
create trigger audit_rider_earnings after insert on public.rider_earnings for each row when (new.kind in ('bonus', 'deduction')) execute function public.audit_row();

-- ---------- 2. COD in the ledger ----------
alter table public.cod_collections add column remit_payment_id uuid references public.payments(id);
create index cod_open_idx on public.cod_collections (rider_id) where status = 'collected';
create index cod_vendor_idx on public.cod_collections (vendor_id, status);

create or replace function public._cod_payable(c public.cod_collections) returns uuid
language sql security definer set search_path = public, extensions as $$
  select case when c.vendor_id is not null then public.wallet_for('vendor_cod', c.vendor_id) else public.sys_wallet('COD_CASH') end;
$$;

create or replace function public.cod_ledger() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare tn text := (select tracking_number from public.orders where id = new.order_id);
begin
  if tg_op = 'INSERT' then
    perform public._ledger('cod_collected', 'COD collected ' || tn, jsonb_build_array(
      jsonb_build_object('wallet_id', public.wallet_for('rider_cash', new.rider_id), 'amount', -new.amount),
      jsonb_build_object('wallet_id', public._cod_payable(new), 'amount', new.amount)), new.order_id);
  elsif old.status = 'collected' and new.status = 'remitted' then
    perform public._ledger('cod_remitted', 'COD handed in ' || case when new.remit_method = 'momo' then 'by MoMo ' else 'at hub ' end || tn, jsonb_build_array(
      jsonb_build_object('wallet_id', public.wallet_for('rider_cash', new.rider_id), 'amount', new.amount),
      jsonb_build_object('wallet_id', case when new.remit_method = 'momo' then public.sys_wallet('HUBTEL_CLEARING') else public.sys_wallet('HUB_CASH') end, 'amount', -new.amount)),
      new.order_id);
  end if;
  return null;
end $$;
create trigger cod_collections_ledger after insert or update of status on public.cod_collections for each row execute function public.cod_ledger();

/** Hub staff / Finance record cash a rider hands in at the hub. */
create or replace function public.receive_cod_cash(p_rider uuid, p_orders uuid[], p_hub uuid, p_note text default null) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare c uuid := (select city_id from public.riders where id = p_rider); total bigint;
begin
  perform public._need(public.has_role(array['super_admin','city_admin','finance','hub_manager','hub_handler']::public.app_role[], c), 'Only hub staff or Finance can receive cash');
  perform public._need(exists (select 1 from public.hubs where id = p_hub and city_id = c), 'Choose the hub in the rider''s city');
  perform public._need(coalesce(array_length(p_orders, 1), 0) > 0, 'Choose the parcels');
  perform public._need((select count(*) from public.cod_collections where order_id = any (p_orders) and rider_id = p_rider and status = 'collected') = array_length(p_orders, 1),
                       'Some of those are not cash this rider is still holding');
  select sum(amount) into total from public.cod_collections where order_id = any (p_orders);
  perform set_config('qcs.audit_reason', 'cash received at hub' || coalesce(': ' || nullif(trim(p_note), ''), ''), true);
  perform public._sys(1);
  update public.cod_collections set status = 'remitted', remit_method = 'cash_at_hub', remit_hub_id = p_hub, received_by = auth.uid(), remitted_at = now()
   where order_id = any (p_orders);
  perform public._sys(-1);
  return total;
end $$;

/** Cash from a hub taken to the bank. */
create table public.cash_bankings (
  id         uuid primary key default gen_random_uuid(),
  hub_id     uuid not null references public.hubs(id),
  amount     bigint not null check (amount > 0),
  reference  text not null,          -- bank deposit slip number
  banked_by  uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.cash_bankings enable row level security;
create policy bankings_read on public.cash_bankings for select to authenticated using (public.is_finance() or exists (select 1 from public.hubs h where h.id = hub_id and public.is_ops(h.city_id)));
create or replace function public.bank_hub_cash(p_hub uuid, p_amount bigint, p_reference text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._need(public.is_finance(), 'Only Finance records bank deposits');
  perform public._need(p_amount > 0 and coalesce(length(trim(p_reference)), 0) >= 3, 'Amount and deposit slip number are needed');
  perform public._need(p_amount <= public.hub_cash_on_hand(p_hub), 'That is more than the cash recorded at this hub');
  insert into public.cash_bankings (hub_id, amount, reference, banked_by) values (p_hub, p_amount, trim(p_reference), auth.uid());
  perform public._ledger('cash_banked', 'Hub cash banked, slip ' || trim(p_reference), jsonb_build_array(
    jsonb_build_object('wallet_id', public.sys_wallet('HUB_CASH'), 'amount', p_amount),
    jsonb_build_object('wallet_id', public.sys_wallet('BANK'), 'amount', -p_amount)));
end $$;
create or replace function public.hub_cash_on_hand(p_hub uuid) returns bigint
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select sum(amount) from public.cod_collections where remit_hub_id = p_hub and remit_method = 'cash_at_hub' and status in ('remitted', 'paid_out')), 0)
       - coalesce((select sum(amount) from public.cash_bankings where hub_id = p_hub), 0);
$$;

-- MoMo hand-in: the server starts a Hubtel checkout for the chosen parcels' cash (see the business portal API).
create or replace function public.create_cod_remit_payment(p_rider uuid, p_orders uuid[]) returns public.payments
language plpgsql security definer set search_path = public, extensions as $$
declare pay public.payments; ref text; total bigint;
begin
  perform public._need(public.is_trusted(), 'Payments are started by the QCS server');
  perform public._need(coalesce(array_length(p_orders, 1), 0) > 0, 'Choose the cash to hand in');
  perform public._need((select count(*) from public.cod_collections where order_id = any (p_orders) and rider_id = p_rider and status = 'collected') = array_length(p_orders, 1),
                       'Some of that cash is already handed in');
  select sum(amount) into total from public.cod_collections where order_id = any (p_orders);
  ref := 'QCSR' || to_char(now() at time zone 'Africa/Accra', 'YYMMDDHH24MISS') || upper(substr(md5(gen_random_uuid()::text), 1, 8));
  -- an earlier unfinished attempt for the same cash is abandoned
  update public.payments p set state = 'cancelled', failure_reason = 'replaced by a new attempt'
   where p.state in ('initiated', 'pending') and p.purpose = 'cod_remit' and p.user_id = p_rider;
  insert into public.payments (client_reference, purpose, user_id, wallet_id, amount)
  values (ref, 'cod_remit', p_rider, public.wallet_for('rider_cash', p_rider), total) returning * into pay;
  insert into public.payment_items (payment_id, order_id, amount) select pay.id, order_id, amount from public.cod_collections where order_id = any (p_orders);
  return pay;
end $$;

-- settle_payment learns about COD hand-ins (the rest is unchanged from Phase 4).
create or replace function public._settle_cod_remit(pay public.payments, p_txn text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare it record; extra bigint := 0;
begin
  perform public._sys(1);
  for it in select i.order_id, i.amount, c.status from public.payment_items i join public.cod_collections c on c.order_id = i.order_id where i.payment_id = pay.id loop
    if it.status = 'collected' then
      update public.cod_collections set status = 'remitted', remit_method = 'momo', remitted_at = now(), remit_payment_id = pay.id where order_id = it.order_id;
    else
      extra := extra + it.amount;   -- already handed in some other way: the money goes to the rider's earnings, paid back with the next payout
    end if;
  end loop;
  if extra > 0 then
    perform public._ledger('cod_overpaid', 'COD handed in twice — credited to rider', jsonb_build_array(
      jsonb_build_object('wallet_id', public.sys_wallet('HUBTEL_CLEARING'), 'amount', -extra),
      jsonb_build_object('wallet_id', public.wallet_for('rider', pay.user_id), 'amount', extra)), null, p_txn);
  end if;
  perform public._sys(-1);
end $$;

create or replace function public.settle_payment(p_ref text, p_checkout_id text, p_amount bigint, p_txn text, p_channel text, p_phone text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare pay public.payments; it record; o public.orders; delivery bigint; cust uuid;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select * into pay from public.payments where client_reference = p_ref for update;
  if not found then raise exception 'Unknown payment %', p_ref; end if;
  if pay.state = 'paid' then return 'already_paid'; end if;
  if p_checkout_id is not null and pay.checkout_id is not null and p_checkout_id <> pay.checkout_id then
    raise exception 'Checkout id does not match payment %', p_ref;
  end if;
  if p_amount is distinct from pay.amount then
    update public.payments set failure_reason = format('amount mismatch: expected %s, got %s', pay.amount, p_amount) where id = pay.id;
    raise exception 'Amount mismatch on payment % (expected %, got %)', p_ref, pay.amount, p_amount;
  end if;

  update public.payments set state = 'paid', paid_at = now(), hubtel_transaction_id = p_txn, channel = p_channel, payer_phone = p_phone, failure_reason = null
   where id = pay.id;

  if pay.purpose = 'cod_remit' then
    perform public._settle_cod_remit(pay, p_txn);
    return 'settled';
  end if;

  if pay.purpose = 'wallet_topup' then
    perform public._ledger('topup', 'Wallet top-up via Hubtel', jsonb_build_array(
      jsonb_build_object('wallet_id', public.sys_wallet('HUBTEL_CLEARING'), 'amount', -pay.amount),
      jsonb_build_object('wallet_id', pay.wallet_id, 'amount', pay.amount)), null, p_txn);
    return 'settled';
  end if;

  perform public._sys(1);
  for it in select * from public.payment_items where payment_id = pay.id loop
    select * into o from public.orders where id = it.order_id for update;
    if o.status = 'PENDING_PAYMENT' then
      delivery := it.amount - o.insurance_premium;
      perform public._ledger('order_payment', 'Delivery paid via Hubtel ' || o.tracking_number, jsonb_build_array(
        jsonb_build_object('wallet_id', public.sys_wallet('HUBTEL_CLEARING'), 'amount', -it.amount),
        jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', delivery),
        jsonb_build_object('wallet_id', public.sys_wallet('INSURANCE_PREMIUMS'), 'amount', o.insurance_premium)), o.id, p_txn);
      update public.orders set payment_status = 'paid', paid_online = paid_online + it.amount where id = o.id;
      perform public.transition_order(o.id, 'CONFIRMED', null, null, 'Payment received (Hubtel)', null, null);
    else
      -- paid after the order was cancelled/expired: keep the money safe in the customer's wallet
      cust := public.wallet_for('customer', pay.user_id);
      perform public._ledger('late_payment', 'Paid after cancellation ' || o.tracking_number || ' — credited to wallet', jsonb_build_array(
        jsonb_build_object('wallet_id', public.sys_wallet('HUBTEL_CLEARING'), 'amount', -it.amount),
        jsonb_build_object('wallet_id', cust, 'amount', it.amount)), o.id, p_txn);
    end if;
  end loop;
  perform public._sys(-1);
  return 'settled';
end $$;

-- ---------- 3. payouts: batches with an approval step ----------
create table public.payout_batches (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('rider', 'vendor_cod')),
  city_id     uuid references public.cities(id),
  status      text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  note        text,
  created_by  uuid references public.profiles(id),     -- null = prepared automatically by the schedule
  created_at  timestamptz not null default now(),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  cancel_reason text
);
alter table public.payout_batches enable row level security;
create policy batches_read on public.payout_batches for select to authenticated using (public.is_finance() or public.has_role(array['analyst']::public.app_role[]));
create trigger audit_payout_batches after insert or update on public.payout_batches for each row execute function public.audit_row();

alter table public.payouts
  add column batch_id   uuid references public.payout_batches(id),
  add column payee_type text check (payee_type in ('rider', 'vendor', 'customer')),
  add column payee_id   uuid;
create index payouts_batch_idx on public.payouts (batch_id);

/** Queue one payout: the money leaves the owner's wallet into PAYOUTS_PENDING straight away, so it can't be paid twice. */
create or replace function public._queue_payout(p_wallet uuid, p_purpose text, p_amount bigint, p_fee bigint, p_momo text, p_network text,
                                                p_batch uuid, p_payee_type text, p_payee uuid, p_hold text) returns public.payouts
language plpgsql security definer set search_path = public, extensions as $$
declare po public.payouts;
begin
  insert into public.payouts (wallet_id, purpose, amount, fee, momo_number, momo_network, status, hold_reason, requested_by, client_reference, batch_id, payee_type, payee_id)
  values (p_wallet, p_purpose, p_amount, p_fee, p_momo, p_network, case when p_hold is null then 'requested' else 'held' end::public.payout_status, p_hold, auth.uid(),
          'QCSP' || to_char(now() at time zone 'Africa/Accra', 'YYMMDDHH24MISS') || upper(substr(md5(gen_random_uuid()::text), 1, 8)),
          p_batch, p_payee_type, p_payee)
  returning * into po;
  perform public._ledger('payout_queued', initcap(replace(p_purpose, '_', ' ')) || ' to ' || p_momo, jsonb_build_array(
    jsonb_build_object('wallet_id', p_wallet, 'amount', -(p_amount + p_fee)),
    jsonb_build_object('wallet_id', public.sys_wallet('PAYOUTS_PENDING'), 'amount', p_amount + p_fee)), null, null, po.id);
  return po;
end $$;

-- Not sent (rejected / failed / batch cancelled): everything back to the owner's wallet; COD parcels become payable again.
create or replace function public._release_payout(po public.payouts, p_status public.payout_status, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.payouts set status = p_status, failure_reason = p_reason where id = po.id;
  perform public._ledger('withdrawal_returned', 'Payout not sent: ' || p_reason, jsonb_build_array(
    jsonb_build_object('wallet_id', public.sys_wallet('PAYOUTS_PENDING'), 'amount', -(po.amount + po.fee)),
    jsonb_build_object('wallet_id', po.wallet_id, 'amount', po.amount + po.fee)), null, null, po.id);
  if po.purpose = 'vendor_cod' then
    perform public._sys(1);
    update public.cod_collections set payout_id = null where payout_id = po.id;
    perform public._sys(-1);
  end if;
end $$;
revoke execute on function public._release_payout(public.payouts, public.payout_status, text) from public, anon, authenticated;

-- Hubtel confirms: money left QCS's Hubtel account; any cash-out fee is QCS income; COD parcels are marked paid out.
create or replace function public.complete_payout(p_ref text, p_txn text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare po public.payouts;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select * into po from public.payouts where client_reference = p_ref for update;
  if po.id is null then raise exception 'Unknown payout %', p_ref; end if;
  if po.status = 'paid' then return 'already_paid'; end if;
  if po.status <> 'processing' then raise exception 'Payout % is %', p_ref, po.status; end if;
  update public.payouts set status = 'paid', paid_at = now(), hubtel_reference = p_txn where id = po.id;
  perform public._ledger('payout', 'Sent to ' || po.momo_number || ' via Hubtel', jsonb_build_array(
    jsonb_build_object('wallet_id', public.sys_wallet('PAYOUTS_PENDING'), 'amount', -(po.amount + po.fee)),
    jsonb_build_object('wallet_id', public.sys_wallet('HUBTEL_CLEARING'), 'amount', po.amount),
    jsonb_build_object('wallet_id', public.sys_wallet('PAYOUT_FEES'), 'amount', po.fee)), null, p_txn, po.id);
  if po.purpose = 'vendor_cod' then
    perform public._sys(1);
    update public.cod_collections set status = 'paid_out' where payout_id = po.id;
    perform public._sys(-1);
  end if;
  return 'paid';
end $$;

/** Prepare this week's rider payouts: everyone with earnings ≥ the minimum and a MoMo number. Riders still holding overdue COD cash are put on hold. */
create or replace function public.create_rider_payout_batch(p_city uuid default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare b uuid; r record; minimum bigint := public.setting_int('payout_min', 1000); n int := 0; missing int := 0;
begin
  perform public._need(public.is_trusted() or public.is_finance(), 'Only Finance prepares payouts');
  insert into public.payout_batches (kind, city_id, created_by) values ('rider', p_city, auth.uid()) returning id into b;
  for r in
    select rd.id, rd.payout_momo_number, rd.payout_momo_network, w.id wallet, w.balance,
           exists (select 1 from public.cod_collections c where c.rider_id = rd.id and c.status = 'collected' and c.remit_due_by < now()) owes
    from public.riders rd join public.wallets w on w.owner_type = 'rider' and w.owner_id = rd.id
    where w.balance >= minimum and (p_city is null or rd.city_id = p_city)
      and not exists (select 1 from public.payouts p where p.wallet_id = w.id and p.status in ('requested', 'held', 'processing'))
  loop
    if r.payout_momo_number is null then missing := missing + 1; continue; end if;
    perform public._queue_payout(r.wallet, 'rider_weekly', r.balance, 0::bigint, r.payout_momo_number, r.payout_momo_network, b, 'rider', r.id,
                                 case when r.owes then 'Rider has COD cash not handed in on time' end);
    n := n + 1;
  end loop;
  update public.payout_batches set note = format('%s rider(s)%s', n, case when missing > 0 then format('; %s rider(s) skipped: no MoMo number on file', missing) else '' end) where id = b;
  if n = 0 then update public.payout_batches set status = 'cancelled', cancel_reason = 'Nothing to pay' where id = b; end if;
  return b;
end $$;

/** Prepare vendor COD payouts (daily or weekly vendors): only cash QCS has actually received is paid.
    Vendors with fees unpaid for more than 7 days (or on a manual hold) are put on hold (CLAUDE.md §9). */
create or replace function public.create_vendor_cod_batch(p_schedule public.payout_schedule, p_city uuid default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare b uuid; v record; po public.payouts; n int := 0; missing int := 0; days int := public.setting_int('vendor_fee_overdue_hold_days', 7); hold text;
begin
  perform public._need(public.is_trusted() or public.is_finance(), 'Only Finance prepares payouts');
  insert into public.payout_batches (kind, city_id, created_by) values ('vendor_cod', p_city, auth.uid()) returning id into b;
  for v in
    select vd.*, (select sum(c.amount) from public.cod_collections c where c.vendor_id = vd.id and c.status = 'remitted' and c.payout_id is null) due,
           (select balance from public.wallets where owner_type = 'vendor' and owner_id = vd.id) fees_now,
           (select coalesce(sum(e.amount), 0) from public.ledger_entries e join public.wallets w on w.id = e.wallet_id
             where w.owner_type = 'vendor' and w.owner_id = vd.id and e.created_at < now() - make_interval(days => days)) fees_then
    from public.vendors vd
    where vd.cod_payout_schedule = p_schedule and (p_city is null or vd.city_id = p_city)
  loop
    continue when coalesce(v.due, 0) <= 0;
    if v.payout_momo_number is null then missing := missing + 1; continue; end if;
    hold := case when v.cod_payout_on_hold then 'COD payouts on hold for this vendor'
                 when coalesce(v.fees_now, 0) < 0 and v.fees_then < 0 then format('Delivery fees unpaid for more than %s days (GHS %s)', days, to_char(-v.fees_now / 100.0, 'FM999,990.00')) end;
    po := public._queue_payout(public.wallet_for('vendor_cod', v.id), 'vendor_cod', v.due::bigint, 0::bigint, v.payout_momo_number, v.payout_momo_network, b, 'vendor', v.id, hold);
    perform public._sys(1);
    update public.cod_collections set payout_id = po.id where vendor_id = v.id and status = 'remitted' and payout_id is null;
    perform public._sys(-1);
    if hold is not null then
      insert into public.notifications (user_id, channel, template, payload)
      select v.owner_id, 'push', 'cod_payout_held', jsonb_build_object('reason', hold, 'amount', v.due) where v.owner_id is not null;
    end if;
    n := n + 1;
  end loop;
  update public.payout_batches set note = format('%s %s vendor(s)%s', n, p_schedule, case when missing > 0 then format('; %s skipped: no payout MoMo number', missing) else '' end) where id = b;
  if n = 0 then update public.payout_batches set status = 'cancelled', cancel_reason = 'Nothing to pay' where id = b; end if;
  return b;
end $$;

/** Approval step: nothing is sent until a Finance person approves. By default it must be someone other than who prepared it.
    Returns the payouts the server should now send through Hubtel. Held payouts stay held. */
create or replace function public.approve_payout_batch(p_batch uuid) returns setof public.payouts
language plpgsql security definer set search_path = public, extensions as $$
declare b public.payout_batches;
begin
  perform public._need(public.is_finance(), 'Only Finance can approve payouts');
  select * into b from public.payout_batches where id = p_batch for update;
  perform public._need(b.status = 'draft', 'This batch is not waiting for approval');
  perform public._need(not (public.get_setting('payout_two_person_rule') = 'true'::jsonb and b.created_by = auth.uid()),
                       'Someone else in Finance must approve a batch you prepared');
  update public.payout_batches set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_batch;
  return query update public.payouts set status = 'processing', approved_by = auth.uid() where batch_id = p_batch and status = 'requested' returning *;
end $$;

create or replace function public.cancel_payout_batch(p_batch uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare po public.payouts;
begin
  perform public._need(public.is_finance(), 'Only Finance can cancel payouts');
  perform public._need(coalesce(length(trim(p_reason)), 0) >= 5, 'Give a short reason');
  perform public._need((select status from public.payout_batches where id = p_batch) = 'draft', 'Only a batch waiting for approval can be cancelled');
  update public.payout_batches set status = 'cancelled', cancel_reason = trim(p_reason) where id = p_batch;
  for po in select * from public.payouts where batch_id = p_batch and status in ('requested', 'held') for update loop
    perform public._release_payout(po, 'cancelled', 'Batch cancelled: ' || trim(p_reason));
  end loop;
end $$;

/** Take a payout off hold (e.g. the rider has now handed in the cash). It then needs approving like any other. */
create or replace function public.release_payout_hold(p_payout uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._need(public.is_finance(), 'Only Finance can release a hold');
  perform public._need(coalesce(length(trim(p_reason)), 0) >= 5, 'Give a short reason');
  perform set_config('qcs.audit_reason', 'hold released: ' || trim(p_reason), true);
  update public.payouts set status = 'requested', hold_reason = null where id = p_payout and status = 'held';
  perform public._need(found, 'This payout is not on hold');
end $$;

/** Rider instant cash-out (fee from Settings). Still needs Finance approval before anything is sent. */
create or replace function public.request_rider_cashout(p_amount bigint) returns public.payouts
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); r public.riders; w uuid; fee bigint := public.setting_int('instant_cashout_fee', 200);
begin
  select * into r from public.riders where id = me;
  perform public._need(found, 'Riders only');
  perform public._need(r.payout_momo_number is not null, 'Add your MoMo number first');
  perform public._need(p_amount > fee + 100, format('Cash out more than GHS %s (the fee is GHS %s)', to_char((fee + 100) / 100.0, 'FM990.00'), to_char(fee / 100.0, 'FM990.00')));
  perform public._need(not exists (select 1 from public.cod_collections c where c.rider_id = me and c.status = 'collected' and c.remit_due_by < now()),
                       'Hand in your COD cash first');
  w := public.wallet_for('rider', me);
  perform public._need(not exists (select 1 from public.payouts where wallet_id = w and status in ('requested', 'held', 'processing')), 'You already have a payout on the way');
  perform public._need((select balance from public.wallets where id = w) >= p_amount, 'You don''t have that much in earnings');
  return public._queue_payout(w, 'rider_instant', p_amount - fee, fee::bigint, r.payout_momo_number, r.payout_momo_network, null, 'rider', me, null);
end $$;

insert into public.notification_templates (key, channel, audience, subject, body, essential, description) values
  ('cod_payout_held', 'push', 'sender', 'COD payout on hold', 'Your COD payout of GHS {{amount_ghs}} is on hold: {{reason}}. Please contact QCS Finance.', true, 'Vendor COD payout held'),
  ('payout_sent',     'push', 'any',    'Money sent', 'GHS {{amount_ghs}} is on its way to your MoMo.', false, 'Payout sent')
on conflict do nothing;

-- ---------- 4. what riders and Finance see ----------
create or replace function public.my_earnings(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); r public.riders; w uuid; today date := (now() at time zone 'Africa/Accra')::date;
        wk date := today - (extract(isodow from today)::int - 1); f date := coalesce(p_from, wk); t date := coalesce(p_to, today);
        tz text := 'Africa/Accra';
begin
  select * into r from public.riders where id = me;
  perform public._need(found, 'Riders only');
  w := public.wallet_for('rider', me);
  return jsonb_build_object(
    'pay_basis', r.rider_type, 'commission_bp', r.commission_rate_bp,
    'balance', (select balance from public.wallets where id = w),
    'on_the_way', coalesce((select sum(amount) from public.payouts where wallet_id = w and status in ('requested', 'held', 'processing')), 0),
    'today', coalesce((select sum(amount) from public.rider_earnings where rider_id = me and (created_at at time zone tz)::date = today), 0),
    'this_week', coalesce((select sum(amount) from public.rider_earnings where rider_id = me and (created_at at time zone tz)::date >= wk), 0),
    'range_total', coalesce((select sum(amount) from public.rider_earnings where rider_id = me and (created_at at time zone tz)::date between f and t), 0),
    'from', f, 'to', t,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', e.kind, 'amount', e.amount, 'description', e.description,
                                       'tracking_number', o.tracking_number, 'trip_id', coalesce(e.trip_id, o.trip_id)) order by e.created_at desc)
                       from public.rider_earnings e left join public.orders o on o.id = e.order_id
                       where e.rider_id = me and (e.created_at at time zone tz)::date between f and t), '[]'::jsonb),
    'cash', coalesce((select jsonb_agg(jsonb_build_object('order_id', c.order_id, 'tracking_number', o.tracking_number, 'amount', c.amount,
                                      'collected_at', c.collected_at, 'due_by', c.remit_due_by, 'overdue', c.remit_due_by < now()) order by c.collected_at)
                      from public.cod_collections c join public.orders o on o.id = c.order_id where c.rider_id = me and c.status = 'collected'), '[]'::jsonb),
    'cash_total', coalesce((select sum(amount) from public.cod_collections where rider_id = me and status = 'collected'), 0),
    'cod_blocked', r.cod_blocked,
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('at', requested_at, 'amount', amount, 'fee', fee, 'status', status, 'purpose', purpose, 'paid_at', paid_at) order by requested_at desc)
                         from (select * from public.payouts where wallet_id = w order by requested_at desc limit 10) p), '[]'::jsonb),
    'momo_number', r.payout_momo_number, 'instant_fee', public.setting_int('instant_cashout_fee', 200),
    'payout_weekday', public.setting_int('rider_payout_weekday', 1));
end $$;

create or replace function public.cod_reconciliation(p_city uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare f timestamptz := p_from::timestamp at time zone 'Africa/Accra'; t timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Accra';
begin
  -- Finance sees everything; city staff (admin, hub manager, analyst) see their own city only
  perform public._need(public.is_finance()
    or (p_city is not null and public.has_role(array['analyst','city_admin','hub_manager']::public.app_role[], p_city))
    or (p_city is null and exists (select 1 from public.user_roles where user_id = auth.uid() and role = 'analyst' and city_id is null)), 'Finance only');
  return jsonb_build_object(
    'period', (select jsonb_build_object(
        'collected', coalesce(sum(amount) filter (where collected_at >= f and collected_at < t), 0),
        'handed_in_momo', coalesce(sum(amount) filter (where remit_method = 'momo' and remitted_at >= f and remitted_at < t), 0),
        'handed_in_hub', coalesce(sum(amount) filter (where remit_method = 'cash_at_hub' and remitted_at >= f and remitted_at < t), 0))
      from public.cod_collections where p_city is null or city_id = p_city),
    'paid_to_vendors', coalesce((select sum(p.amount) from public.payouts p where p.purpose = 'vendor_cod' and p.status = 'paid' and p.paid_at >= f and p.paid_at < t
                                   and (p_city is null or exists (select 1 from public.vendors v where v.id = p.payee_id and v.city_id = p_city))), 0),
    'now', (select jsonb_build_object(
        'with_riders', coalesce(sum(amount) filter (where status = 'collected'), 0),
        'overdue', coalesce(sum(amount) filter (where status = 'collected' and remit_due_by < now()), 0),
        'received_not_paid_out', coalesce(sum(amount) filter (where status = 'remitted'), 0),
        'in_payout', coalesce(sum(amount) filter (where status = 'remitted' and payout_id is not null), 0))
      from public.cod_collections where p_city is null or city_id = p_city),
    'riders', coalesce((select jsonb_agg(x order by (x ->> 'overdue')::bigint desc, (x ->> 'holding')::bigint desc) from (
        select jsonb_build_object('rider_id', c.rider_id, 'name', p.full_name, 'phone', p.phone, 'holding', sum(c.amount),
               'overdue', coalesce(sum(c.amount) filter (where c.remit_due_by < now()), 0), 'parcels', count(*), 'oldest', min(c.collected_at),
               'order_ids', jsonb_agg(c.order_id)) x
        from public.cod_collections c join public.profiles p on p.id = c.rider_id
        where c.status = 'collected' and (p_city is null or c.city_id = p_city) group by c.rider_id, p.full_name, p.phone) s), '[]'::jsonb),
    'hubs', coalesce((select jsonb_agg(jsonb_build_object('hub_id', h.id, 'name', h.name, 'cash', public.hub_cash_on_hand(h.id)) order by h.name)
                      from public.hubs h where p_city is null or h.city_id = p_city), '[]'::jsonb),
    -- the whole ledger must always add up to zero; anything else is a bug to report immediately
    'ledger_balanced', (select coalesce(sum(balance), 0) = 0 from public.wallets),
    'wallets', case when public.is_finance() then (select jsonb_object_agg(system_code, balance) from public.wallets where owner_type = 'system') end);
end $$;

/** Exports for the accountant (CSV is built by the dashboard). Finance and analysts only. */
create or replace function public.accounting_export(p_kind text, p_from date, p_to date) returns setof jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare f timestamptz := p_from::timestamp at time zone 'Africa/Accra'; t timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Accra';
begin
  perform public._need(public.is_finance() or public.has_role(array['analyst']::public.app_role[]), 'Finance only');
  perform public._need(p_to >= p_from and p_to - p_from <= 366, 'Choose up to one year');
  if p_kind = 'journal' then
    return query select jsonb_build_object(
      'date', to_char(e.created_at at time zone 'Africa/Accra', 'YYYY-MM-DD HH24:MI:SS'), 'transaction', tx.id, 'type', tx.kind, 'description', tx.description,
      'tracking_number', o.tracking_number, 'account', coalesce(w.system_code, w.owner_type::text),
      'account_holder', coalesce(v.business_name, pr.full_name, ''), 'debit_ghs', case when e.amount < 0 then to_char(-e.amount / 100.0, 'FM9999999990.00') else '' end,
      'credit_ghs', case when e.amount > 0 then to_char(e.amount / 100.0, 'FM9999999990.00') else '' end, 'hubtel_ref', coalesce(tx.external_ref, ''))
    from public.ledger_entries e join public.ledger_transactions tx on tx.id = e.transaction_id join public.wallets w on w.id = e.wallet_id
    left join public.orders o on o.id = tx.order_id left join public.vendors v on w.owner_type in ('vendor', 'vendor_cod') and v.id = w.owner_id
    left join public.profiles pr on w.owner_type in ('customer', 'customer_credit', 'rider', 'rider_cash') and pr.id = w.owner_id
    where e.created_at >= f and e.created_at < t order by e.id;
  elsif p_kind = 'payouts' then
    return query select jsonb_build_object(
      'requested', to_char(p.requested_at at time zone 'Africa/Accra', 'YYYY-MM-DD HH24:MI'), 'paid', coalesce(to_char(p.paid_at at time zone 'Africa/Accra', 'YYYY-MM-DD HH24:MI'), ''),
      'purpose', p.purpose, 'payee', coalesce(v.business_name, pr.full_name, ''), 'momo', p.momo_number, 'network', coalesce(p.momo_network, ''),
      'amount_ghs', to_char(p.amount / 100.0, 'FM9999999990.00'), 'fee_ghs', to_char(p.fee / 100.0, 'FM9999999990.00'), 'status', p.status,
      'reference', p.client_reference, 'hubtel_ref', coalesce(p.hubtel_reference, ''), 'batch', coalesce(p.batch_id::text, ''),
      'approved_by', coalesce((select full_name from public.profiles where id = p.approved_by), ''), 'note', coalesce(p.hold_reason, p.failure_reason, ''))
    from public.payouts p left join public.vendors v on p.payee_type = 'vendor' and v.id = p.payee_id
    left join public.profiles pr on p.payee_type in ('rider', 'customer') and pr.id = p.payee_id
    where p.requested_at >= f and p.requested_at < t order by p.requested_at;
  elsif p_kind = 'cod' then
    return query select jsonb_build_object(
      'collected', to_char(c.collected_at at time zone 'Africa/Accra', 'YYYY-MM-DD HH24:MI'), 'tracking_number', o.tracking_number, 'vendor', coalesce(v.business_name, ''),
      'rider', pr.full_name, 'amount_ghs', to_char(c.amount / 100.0, 'FM9999999990.00'), 'status', c.status,
      'handed_in', coalesce(to_char(c.remitted_at at time zone 'Africa/Accra', 'YYYY-MM-DD HH24:MI'), ''), 'method', coalesce(c.remit_method::text, ''),
      'hub', coalesce((select name from public.hubs where id = c.remit_hub_id), ''), 'payout_reference', coalesce((select client_reference from public.payouts where id = c.payout_id), ''))
    from public.cod_collections c join public.orders o on o.id = c.order_id left join public.vendors v on v.id = c.vendor_id join public.profiles pr on pr.id = c.rider_id
    where c.collected_at >= f and c.collected_at < t order by c.collected_at;
  elsif p_kind = 'earnings' then
    return query select jsonb_build_object(
      'date', to_char(e.created_at at time zone 'Africa/Accra', 'YYYY-MM-DD HH24:MI'), 'rider', pr.full_name, 'phone', coalesce(pr.phone, ''),
      'rider_type', r.rider_type, 'kind', e.kind, 'tracking_number', coalesce(o.tracking_number, ''), 'description', e.description,
      'amount_ghs', to_char(e.amount / 100.0, 'FM9999999990.00'))
    from public.rider_earnings e join public.riders r on r.id = e.rider_id join public.profiles pr on pr.id = e.rider_id left join public.orders o on o.id = e.order_id
    where e.created_at >= f and e.created_at < t order by e.created_at;
  else
    raise exception 'Unknown export %', p_kind;
  end if;
end $$;

revoke all on function public._queue_payout(uuid, text, bigint, bigint, text, text, uuid, text, uuid, text), public._earn(uuid, text, bigint, uuid, uuid, text),
  public._settle_cod_remit(public.payments, text), public.create_cod_remit_payment(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.create_cod_remit_payment(uuid, uuid[]) to service_role;
grant execute on function public.add_rider_adjustment(uuid, text, bigint, text), public.receive_cod_cash(uuid, uuid[], uuid, text), public.bank_hub_cash(uuid, bigint, text),
  public.hub_cash_on_hand(uuid), public.create_rider_payout_batch(uuid), public.create_vendor_cod_batch(public.payout_schedule, uuid), public.approve_payout_batch(uuid),
  public.cancel_payout_batch(uuid, text), public.release_payout_hold(uuid, text), public.request_rider_cashout(bigint), public.my_earnings(date, date),
  public.cod_reconciliation(uuid, date, date), public.accounting_export(text, date, date) to authenticated;

-- ---------- 5. schedule: drafts are prepared automatically, but only sent after Finance approves ----------
create or replace function public.prepare_scheduled_payouts() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare dow int := extract(isodow from now() at time zone 'Africa/Accra');
begin
  perform public.create_vendor_cod_batch('daily');
  if dow = public.setting_int('vendor_cod_weekday', 1) then perform public.create_vendor_cod_batch('weekly'); end if;
  if dow = public.setting_int('rider_payout_weekday', 1) then perform public.create_rider_payout_batch(null); end if;
end $$;
revoke all on function public.prepare_scheduled_payouts() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('prepare-payouts', '0 6 * * *', 'select public.prepare_scheduled_payouts()');   -- 06:00 Accra (= UTC)
  end if;
end $$;

-- Rider page: real earnings from the ledger next to the old estimate.
create or replace function public.rider_stats(p_rider uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare r public.riders; pay jsonb; f timestamptz; t timestamptz; delivered int; failed int; trips int; fees bigint; ontime int; res jsonb;
begin
  select * into r from public.riders where id = p_rider;
  perform public._need(found and (public.is_ops(r.city_id) or p_rider = auth.uid()), 'Not allowed');
  f := (p_from::timestamp) at time zone 'Africa/Accra'; t := ((p_to + 1)::timestamp) at time zone 'Africa/Accra';
  pay := coalesce(public.get_setting('rider_pay', r.city_id), '{}');
  select count(*) filter (where o.status in ('DELIVERED','COLLECTED')),
         count(*) filter (where exists (select 1 from public.order_events e where e.order_id = o.id and e.to_status = 'FAILED_ATTEMPT' and e.actor_id = p_rider)),
         coalesce(sum(o.quoted_fee + o.extra_fee) filter (where o.status in ('DELIVERED','COLLECTED')), 0),
         count(*) filter (where o.status in ('DELIVERED','COLLECTED') and o.service_type = 'express'
                          and o.delivered_at <= o.created_at + make_interval(mins => public._num_setting('late_express_minutes', r.city_id, 90)::int))
    into delivered, failed, fees, ontime
  from public.orders o where o.rider_id = p_rider and o.updated_at >= f and coalesce(o.delivered_at, o.updated_at) < t;
  select count(*) into trips from public.trips where rider_id = p_rider and started_at >= f and started_at < t;
  res := jsonb_build_object(
    'rating', r.rating, 'score', r.score, 'offers_received', r.offers_received, 'offers_accepted', r.offers_accepted,
    'acceptance_rate', case when r.offers_received > 0 then round(100.0 * r.offers_accepted / r.offers_received) end,
    'delivered', delivered, 'failed', failed, 'trips', trips, 'delivery_fees', fees,
    'express_on_time', ontime, 'cod_held', r.cod_float_balance, 'cod_limit', r.cod_float_limit,
    'ratings_count', (select count(*) from public.ratings where rider_id = p_rider and kind = 'client'),
    'earnings_estimate', case when r.rider_type = 'fleet'
      then trips * coalesce((pay ->> 'fleet_pickup_fee')::bigint, 0) + delivered * coalesce((pay ->> 'fleet_delivery_fee')::bigint, 0)
      else round(fees * coalesce(r.commission_rate_bp, (pay ->> 'default_commission_bp')::int, 0) / 10000.0)::bigint end,
    'pay_basis', case when r.rider_type = 'fleet' then 'fleet' else 'commission' end,
    'earned', (select coalesce(sum(amount), 0) from public.rider_earnings where rider_id = p_rider and created_at >= f and created_at < t));
  return res;
end $$;
