-- =====================================================================
-- QCS Unified — Phase 4: payments (Hubtel), wallets, refunds, referrals, statements
--
-- Money rules (CLAUDE.md §5, §7, §9):
--   • Card/MoMo orders stay PENDING_PAYMENT until Hubtel's payment is verified; only then CONFIRMED.
--   • Wallet-paid orders are charged at booking (promo credit first, then cash balance).
--   • Vendor-wallet orders: delivery fee charged per successful delivery; 50% if returned; insurance at booking.
--   • Cancelled paid orders are refunded to the wallet automatically.
--   • Every cedi moves through the double-entry ledger; balances are never edited directly.
-- =====================================================================

-- ---------- ledger plumbing ----------
insert into public.wallets (owner_type, system_code) values
  ('system', 'INSURANCE_PREMIUMS'),   -- insurance premiums collected (pays insured claims)
  ('system', 'PAYOUTS_PENDING')       -- money promised to people, waiting for Hubtel to send it
on conflict do nothing;

-- Customer cash and credit wallets can't go below zero; vendor wallets can (fees owed, see overdue-fee rules).
create or replace function public.apply_ledger_entry() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare w public.wallets;
begin
  perform set_config('qcs.ledger_write', 'on', true);
  update public.wallets set balance = balance + new.amount where id = new.wallet_id returning * into w;
  perform set_config('qcs.ledger_write', 'off', true);
  if w.owner_type in ('customer', 'customer_credit') and w.balance < 0 then
    raise exception 'Insufficient wallet balance';
  end if;
  return new;
end $$;

-- Get (or create) a person's or vendor's wallet.
create or replace function public.wallet_for(p_type public.wallet_owner, p_owner uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare w uuid;
begin
  select id into w from public.wallets where owner_type = p_type and owner_id = p_owner;
  if w is null then
    insert into public.wallets (owner_type, owner_id) values (p_type, p_owner) on conflict do nothing returning id into w;
    if w is null then select id into w from public.wallets where owner_type = p_type and owner_id = p_owner; end if;
  end if;
  return w;
end $$;
create or replace function public.sys_wallet(p_code text) returns uuid language sql stable security definer set search_path = public, extensions as $$
  select id from public.wallets where system_code = p_code $$;

-- Internal: post a balanced transaction. Only our own database functions call this.
create or replace function public._ledger(p_kind text, p_description text, p_entries jsonb, p_order uuid default null,
                                          p_external_ref text default null, p_payout uuid default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare tx uuid; e jsonb;
begin
  insert into public.ledger_transactions (kind, description, order_id, external_ref, payout_id, created_by)
  values (p_kind, coalesce(p_description, ''), p_order, p_external_ref, p_payout, auth.uid()) returning id into tx;
  for e in select * from jsonb_array_elements(p_entries) loop
    if (e ->> 'amount')::bigint <> 0 then
      insert into public.ledger_entries (transaction_id, wallet_id, amount) values (tx, (e ->> 'wallet_id')::uuid, (e ->> 'amount')::bigint);
    end if;
  end loop;
  return tx;
end $$;
revoke execute on function public._ledger(text, text, jsonb, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.wallet_for(public.wallet_owner, uuid) from public, anon, authenticated;

create or replace function public.post_ledger_transaction(
  p_kind text, p_description text, p_entries jsonb, p_order_id uuid default null, p_external_ref text default null
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
begin
  if not (public.is_trusted() or public.is_finance()) then
    raise exception 'Only Finance or the server can post ledger transactions';
  end if;
  return public._ledger(p_kind, p_description, p_entries, p_order_id, p_external_ref, null);
end $$;

-- ---------- what was paid on each order ----------
alter table public.orders
  add column paid_from_wallet bigint not null default 0 check (paid_from_wallet >= 0),
  add column paid_from_credit bigint not null default 0 check (paid_from_credit >= 0),
  add column paid_online      bigint not null default 0 check (paid_online >= 0),       -- card / MoMo through Hubtel
  add column fees_charged     bigint not null default 0 check (fees_charged >= 0),      -- vendor wallet: fee charged at delivery/return
  add column refunded_amount  bigint not null default 0 check (refunded_amount >= 0);

-- ---------- payments through Hubtel ----------
create table public.payments (
  id                    uuid primary key default gen_random_uuid(),
  client_reference      text not null unique check (length(client_reference) <= 32),   -- our reference sent to Hubtel
  purpose               public.payment_purpose not null,
  user_id               uuid not null references public.profiles(id),
  vendor_id             uuid references public.vendors(id),
  wallet_id             uuid references public.wallets(id),       -- wallet top-ups: the wallet to credit
  amount                bigint not null check (amount > 0),       -- pesewas expected
  state                 public.payment_state not null default 'initiated',
  checkout_id           text,
  checkout_url          text,
  hubtel_transaction_id text,
  channel               text,                                     -- e.g. mtn-gh, vodafone-gh, card
  payer_phone           text,                                     -- MoMo number that paid (refunds go back here)
  failure_reason        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  paid_at               timestamptz
);
create index payments_user_idx on public.payments (user_id, created_at desc);
create index payments_state_idx on public.payments (state, created_at) where state in ('initiated', 'pending');
create trigger payments_updated before update on public.payments for each row execute function public.set_updated_at();
create trigger audit_payments after update of state on public.payments for each row execute function public.audit_row();

create table public.payment_items (
  payment_id uuid not null references public.payments(id) on delete cascade,
  order_id   uuid not null references public.orders(id),
  amount     bigint not null check (amount > 0),
  primary key (payment_id, order_id)
);

-- Every message from Hubtel is kept; the same message twice is ignored (idempotent).
create table public.payment_events (
  id               bigint generated always as identity primary key,
  client_reference text,
  source           text not null,                 -- checkout_callback, status_check, payout_callback
  dedupe_key       text not null unique,
  payload          jsonb not null,
  outcome          text,
  received_at      timestamptz not null default now()
);
create index payment_events_ref_idx on public.payment_events (client_reference);

alter table public.payments enable row level security;
alter table public.payment_items enable row level security;
alter table public.payment_events enable row level security;
create policy payments_read on public.payments for select to authenticated
  using (user_id = (select auth.uid()) or vendor_id in (select public.my_vendor_ids('wallet')) or public.is_finance() or public.has_role(array['support','analyst']::public.app_role[]));
create policy payment_items_read on public.payment_items for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_items.payment_id));
create policy payment_events_read on public.payment_events for select to authenticated using (public.is_finance());

alter table public.payouts add column client_reference text unique;
alter table public.ledger_transactions add constraint ledger_tx_payout_fk foreign key (payout_id) references public.payouts(id);

insert into public.app_settings (key, value, description) values
  ('topup_min', '100', 'Smallest wallet top-up (pesewas)'),
  ('topup_max', '500000', 'Largest single wallet top-up (pesewas)'),
  ('payment_timeout_minutes', '60', 'Unpaid card/MoMo orders are cancelled after this many minutes'),
  ('referral_referrer_credit', '1000', 'Credit (pesewas) for the person who referred a new customer'),
  ('referral_new_customer_credit', '1000', 'Credit (pesewas) for the new customer who used a referral code')
on conflict do nothing;

create or replace function public.setting_int(p_key text, p_default bigint) returns bigint
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select (value #>> '{}')::numeric::bigint from public.app_settings where key = p_key and city_id is null), p_default) $$;

-- ---------- start a payment ----------
-- Called by the booking server (service role) before sending the person to Hubtel's checkout.
create or replace function public.create_payment(p_user uuid, p_purpose public.payment_purpose, p_order_ids uuid[] default null,
                                                 p_amount bigint default null, p_vendor uuid default null)
returns public.payments language plpgsql security definer set search_path = public, extensions as $$
declare pay public.payments; total bigint := 0; o record; w uuid; ref text;
begin
  if not public.is_trusted() then raise exception 'Payments are started by the QCS server'; end if;
  ref := 'QCS' || to_char(now() at time zone 'Africa/Accra', 'YYMMDDHH24MISS') || upper(substr(md5(gen_random_uuid()::text), 1, 8));

  if p_purpose = 'wallet_topup' then
    if p_amount is null or p_amount < public.setting_int('topup_min', 100) or p_amount > public.setting_int('topup_max', 500000) then
      raise exception 'Top up between GHS % and GHS %', public.setting_int('topup_min', 100) / 100.0, public.setting_int('topup_max', 500000) / 100;
    end if;
    if p_vendor is not null then
      if not exists (select 1 from public.vendors v where v.id = p_vendor and v.owner_id = p_user
                     union all select 1 from public.vendor_staff s where s.vendor_id = p_vendor and s.user_id = p_user and s.is_active and 'wallet' = any (s.permissions)) then
        raise exception 'You can''t top up this business wallet';
      end if;
      w := public.wallet_for('vendor', p_vendor);
    else
      w := public.wallet_for('customer', p_user);
    end if;
    insert into public.payments (client_reference, purpose, user_id, vendor_id, wallet_id, amount)
    values (ref, 'wallet_topup', p_user, p_vendor, w, p_amount) returning * into pay;
    return pay;
  end if;

  if p_order_ids is null or cardinality(p_order_ids) = 0 then raise exception 'Choose the orders to pay for'; end if;
  insert into public.payments (client_reference, purpose, user_id, amount) values (ref, 'order', p_user, 1) returning * into pay;
  for o in select * from public.orders where id = any (p_order_ids) for update loop
    if o.customer_id is distinct from p_user then raise exception 'Order % is not yours', o.tracking_number; end if;
    if o.status <> 'PENDING_PAYMENT' then raise exception 'Order % is not waiting for payment', o.tracking_number; end if;
    total := total + o.quoted_fee + o.extra_fee + o.insurance_premium;
    insert into public.payment_items (payment_id, order_id, amount) values (pay.id, o.id, o.quoted_fee + o.extra_fee + o.insurance_premium);
  end loop;
  if total = 0 or (select count(*) from public.payment_items where payment_id = pay.id) <> cardinality(p_order_ids) then
    raise exception 'Some orders were not found';
  end if;
  -- an earlier unfinished attempt for the same orders is abandoned
  update public.payments p set state = 'cancelled', failure_reason = 'replaced by a new attempt'
   where p.state in ('initiated', 'pending') and p.id <> pay.id
     and exists (select 1 from public.payment_items i where i.payment_id = p.id and i.order_id = any (p_order_ids));
  update public.payments set amount = total where id = pay.id returning * into pay;
  update public.orders set payment_status = 'pending' where id = any (p_order_ids);
  return pay;
end $$;

create or replace function public.attach_checkout(p_payment uuid, p_checkout_id text, p_url text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  update public.payments set checkout_id = p_checkout_id, checkout_url = p_url, state = 'pending' where id = p_payment and state = 'initiated';
end $$;

-- Keep every Hubtel message; returns false if we've already seen this exact message.
create or replace function public.record_payment_event(p_ref text, p_source text, p_dedupe text, p_payload jsonb) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  insert into public.payment_events (client_reference, source, dedupe_key, payload) values (p_ref, p_source, p_dedupe, p_payload)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---------- payment verified → money in, orders confirmed ----------
-- Safe to call more than once: the second call changes nothing.
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

create or replace function public.fail_payment(p_ref text, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare pay public.payments;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select * into pay from public.payments where client_reference = p_ref for update;
  if not found or pay.state = 'paid' then return; end if;
  update public.payments set state = 'failed', failure_reason = p_reason where id = pay.id;
  perform public._sys(1);
  update public.orders o set payment_status = 'failed'
   where o.id in (select order_id from public.payment_items where payment_id = pay.id) and o.status = 'PENDING_PAYMENT';
  perform public._sys(-1);
end $$;

-- Unpaid card/MoMo orders are cancelled after the timeout (default 60 min).
create or replace function public.expire_unpaid_orders() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare o record; n int := 0;
begin
  for o in select id from public.orders where status = 'PENDING_PAYMENT'
            and created_at < now() - make_interval(mins => public.setting_int('payment_timeout_minutes', 60)::int) loop
    perform public.transition_order(o.id, 'CANCELLED', null, null, 'Not paid in time', null, 'payment_timeout');
    n := n + 1;
  end loop;
  update public.payments set state = 'expired' where state in ('initiated', 'pending')
     and created_at < now() - make_interval(mins => public.setting_int('payment_timeout_minutes', 60)::int);
  return n;
end $$;

-- ---------- charging wallets at booking ----------
-- Customer wallet orders: promo/referral credit is used first, then the cash balance.
-- Vendor wallet orders: only the insurance premium now; the delivery fee is charged per successful delivery.
create or replace function public._charge_booking(p_quote uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; credit_w uuid; cash_w uuid; vendor_w uuid; due bigint; from_credit bigint; from_cash bigint; avail bigint;
begin
  perform public._sys(1);
  for o in select * from public.orders where quote_id = p_quote order by created_at, id for update loop
    if o.payer = 'sender' and o.payment_method = 'wallet' then
      credit_w := public.wallet_for('customer_credit', o.customer_id);
      cash_w := public.wallet_for('customer', o.customer_id);
      due := o.quoted_fee + o.extra_fee + o.insurance_premium;
      from_credit := least(due, (select balance from public.wallets where id = credit_w));
      from_cash := due - from_credit;
      avail := (select balance from public.wallets where id = cash_w);
      if from_cash > avail then
        raise exception 'Not enough in your QCS wallet: GHS % needed, GHS % available. Top up or choose another way to pay.',
          to_char(due / 100.0, 'FM999,990.00'), to_char((avail + from_credit) / 100.0, 'FM999,990.00');
      end if;
      perform public._ledger('order_payment', 'Paid from wallet ' || o.tracking_number, jsonb_build_array(
        jsonb_build_object('wallet_id', credit_w, 'amount', -from_credit),
        jsonb_build_object('wallet_id', cash_w, 'amount', -from_cash),
        jsonb_build_object('wallet_id', public.sys_wallet('PROMO_EXPENSE'), 'amount', 0),
        jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', due - o.insurance_premium),
        jsonb_build_object('wallet_id', public.sys_wallet('INSURANCE_PREMIUMS'), 'amount', o.insurance_premium)), o.id);
      update public.orders set payment_status = 'paid', paid_from_credit = from_credit, paid_from_wallet = from_cash where id = o.id;
    elsif o.payer = 'vendor_wallet' and o.insurance_premium > 0 then
      vendor_w := public.wallet_for('vendor', o.vendor_id);
      perform public._ledger('insurance_premium', 'Insurance ' || o.tracking_number, jsonb_build_array(
        jsonb_build_object('wallet_id', vendor_w, 'amount', -o.insurance_premium),
        jsonb_build_object('wallet_id', public.sys_wallet('INSURANCE_PREMIUMS'), 'amount', o.insurance_premium)), o.id);
    end if;
  end loop;
  perform public._sys(-1);
end $$;
revoke execute on function public._charge_booking(uuid) from public, anon, authenticated;

-- Give money back to whoever paid (wallet cash, wallet credit, vendor wallet).
create or replace function public._refund_to_payer(o public.orders, p_amount bigint, p_kind text, p_why text, p_from_insurance bigint default 0)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare to_credit bigint := 0; to_cash bigint; target uuid;
begin
  if p_amount <= 0 then return; end if;
  if o.payer = 'vendor_wallet' then
    target := public.wallet_for('vendor', o.vendor_id);
    perform public._ledger(p_kind, p_why, jsonb_build_array(
      jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', -(p_amount - p_from_insurance)),
      jsonb_build_object('wallet_id', public.sys_wallet('INSURANCE_PREMIUMS'), 'amount', -p_from_insurance),
      jsonb_build_object('wallet_id', target, 'amount', p_amount)), o.id);
  else
    -- credit goes back as credit (can't be cashed out); everything else to the cash wallet
    to_credit := least(p_amount, greatest(0, o.paid_from_credit - o.refunded_amount));
    to_cash := p_amount - to_credit;
    perform public._ledger(p_kind, p_why, jsonb_build_array(
      jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', -(p_amount - p_from_insurance)),
      jsonb_build_object('wallet_id', public.sys_wallet('INSURANCE_PREMIUMS'), 'amount', -p_from_insurance),
      jsonb_build_object('wallet_id', public.wallet_for('customer_credit', o.customer_id), 'amount', to_credit),
      jsonb_build_object('wallet_id', public.wallet_for('customer', o.customer_id), 'amount', to_cash)), o.id);
  end if;
  update public.orders set refunded_amount = refunded_amount + p_amount where id = o.id;
end $$;
revoke execute on function public._refund_to_payer(public.orders, bigint, text, text, bigint) from public, anon, authenticated;

-- ---------- money that follows an order's status ----------
create or replace function public.money_on_status() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  paid bigint := new.paid_online + new.paid_from_wallet + new.paid_from_credit;
  fee bigint; rate numeric;
begin
  if new.status = old.status then return new; end if;
  perform public._sys(1);

  -- Delivered: vendor wallet pays the delivery fee now (per successful delivery).
  if new.status in ('DELIVERED', 'COLLECTED') and new.payer = 'vendor_wallet' and new.fees_charged = 0 then
    fee := new.quoted_fee + new.extra_fee;
    perform public._ledger('delivery_fee', 'Delivery ' || new.tracking_number, jsonb_build_array(
      jsonb_build_object('wallet_id', public.wallet_for('vendor', new.vendor_id), 'amount', -fee),
      jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', fee)), new.id);
    update public.orders set fees_charged = fee where id = new.id;
  end if;

  -- Returned: 50% of the delivery fee (CLAUDE.md §5). Prepaid orders get the other half back.
  if new.status = 'RETURNED' then
    rate := coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'failed_return_fee_rate' and city_id is null), 0.5);
    fee := round(new.quoted_fee * rate);
    update public.orders set failed_fee = fee where id = new.id;
    if new.payer = 'vendor_wallet' and new.fees_charged = 0 then
      perform public._ledger('return_fee', 'Returned (50%) ' || new.tracking_number, jsonb_build_array(
        jsonb_build_object('wallet_id', public.wallet_for('vendor', new.vendor_id), 'amount', -fee),
        jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', fee)), new.id);
      update public.orders set fees_charged = fee where id = new.id;
    elsif paid > 0 then
      perform public._refund_to_payer(new, (new.quoted_fee + new.extra_fee) - fee - new.refunded_amount, 'return_refund',
                                      'Returned: 50% of the delivery fee refunded ' || new.tracking_number);
    end if;
  end if;

  -- Cancelled after paying: everything back to the wallet (including insurance — no trip happened).
  if new.status = 'CANCELLED' then
    if paid > 0 then
      perform public._refund_to_payer(new, paid - new.refunded_amount, 'cancellation_refund', 'Cancelled — refunded ' || new.tracking_number, new.insurance_premium);
      update public.orders set payment_status = 'refunded' where id = new.id;
    elsif new.payer = 'vendor_wallet' and new.insurance_premium > 0 then
      perform public._refund_to_payer(new, new.insurance_premium, 'cancellation_refund', 'Cancelled — insurance refunded ' || new.tracking_number, new.insurance_premium);
    end if;
  end if;

  -- First successful delivery for a referred customer: reward both people.
  if new.status in ('DELIVERED', 'COLLECTED') then
    perform public._reward_referral(new.customer_id, new.id);
  end if;

  perform public._sys(-1);
  return new;
end $$;

-- ---------- refunds by Finance ----------
create or replace function public.refund_order(p_order uuid, p_amount bigint, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; paid bigint;
begin
  if not (public.is_trusted() or public.is_finance()) then raise exception 'Only Finance can refund'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for the refund'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  paid := o.paid_online + o.paid_from_wallet + o.paid_from_credit + o.fees_charged + case when o.payer = 'vendor_wallet' then o.insurance_premium else 0 end;
  if p_amount <= 0 or p_amount > paid - o.refunded_amount then
    raise exception 'You can refund up to GHS % on this order', to_char((paid - o.refunded_amount) / 100.0, 'FM999,990.00');
  end if;
  perform set_config('qcs.audit_reason', p_reason, true);
  perform public._sys(1);
  perform public._refund_to_payer(o, p_amount, 'refund', 'Refund ' || o.tracking_number || ': ' || p_reason);
  perform public._sys(-1);
  insert into public.audit_log (actor_id, action, table_name, record_id, before, after, reason)
  values (auth.uid(), 'REFUND', 'orders', o.id::text, jsonb_build_object('refunded_amount', o.refunded_amount),
          jsonb_build_object('refunded_amount', o.refunded_amount + p_amount), p_reason);
end $$;
revoke execute on function public.refund_order(uuid, bigint, text) from public, anon;
grant execute on function public.refund_order(uuid, bigint, text) to authenticated, service_role;

-- ---------- referrals ----------
alter table public.profiles
  add column referral_code text unique,
  add column referred_by   uuid references public.profiles(id);

create table public.referral_rewards (
  referee_id      uuid primary key references public.profiles(id),   -- one reward per new customer, ever
  referrer_id     uuid not null references public.profiles(id),
  order_id        uuid not null references public.orders(id),
  referrer_credit bigint not null,
  referee_credit  bigint not null,
  created_at      timestamptz not null default now()
);
alter table public.referral_rewards enable row level security;
create policy referral_rewards_read on public.referral_rewards for select to authenticated
  using (referrer_id = (select auth.uid()) or referee_id = (select auth.uid()) or public.is_finance());

create or replace function public.make_referral_code() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare c text;
begin
  if new.referral_code is null then
    loop
      c := 'QCS' || upper(substr(translate(encode(gen_random_bytes(6), 'base64'), '+/=0O1Il', 'ABCDEFGH'), 1, 5));
      exit when not exists (select 1 from public.profiles where referral_code = c);
    end loop;
    new.referral_code := c;
  end if;
  return new;
end $$;
create trigger profiles_referral_code before insert on public.profiles for each row execute function public.make_referral_code();
do $$ declare r record; begin
  for r in select id from public.profiles where referral_code is null loop
    update public.profiles set referral_code = 'QCS' || upper(substr(md5(r.id::text), 1, 5)) where id = r.id;
  end loop;
end $$;

-- A new customer enters a friend's code (once, before their first order).
create or replace function public.apply_referral(p_code text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare me public.profiles; ref public.profiles;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then raise exception 'Sign in first'; end if;
  if me.referred_by is not null then raise exception 'You have already used a referral code'; end if;
  select * into ref from public.profiles where referral_code = upper(trim(p_code));
  if ref.id is null then raise exception 'That referral code isn''t valid'; end if;
  if ref.id = me.id then raise exception 'You can''t use your own code'; end if;
  if exists (select 1 from public.orders where customer_id = me.id) then raise exception 'Referral codes are for new customers, before their first delivery'; end if;
  perform public._sys(1);
  update public.profiles set referred_by = ref.id where id = me.id;
  perform public._sys(-1);
  return coalesce(nullif(ref.full_name, ''), 'your friend');
end $$;
revoke execute on function public.apply_referral(text) from public, anon;
grant execute on function public.apply_referral(text) to authenticated;

create or replace function public._reward_referral(p_customer uuid, p_order uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare referrer uuid; a bigint; b bigint;
begin
  select referred_by into referrer from public.profiles where id = p_customer;
  if referrer is null or exists (select 1 from public.referral_rewards where referee_id = p_customer) then return; end if;
  a := public.setting_int('referral_referrer_credit', 1000);
  b := public.setting_int('referral_new_customer_credit', 1000);
  insert into public.referral_rewards (referee_id, referrer_id, order_id, referrer_credit, referee_credit) values (p_customer, referrer, p_order, a, b);
  perform public._ledger('referral', 'Referral reward', jsonb_build_array(
    jsonb_build_object('wallet_id', public.sys_wallet('PROMO_EXPENSE'), 'amount', -(a + b)),
    jsonb_build_object('wallet_id', public.wallet_for('customer_credit', referrer), 'amount', a),
    jsonb_build_object('wallet_id', public.wallet_for('customer_credit', p_customer), 'amount', b)), p_order);
  insert into public.notifications (user_id, channel, template, payload) values
    (referrer, 'push', 'referral_reward', jsonb_build_object('amount', a)),
    (p_customer, 'push', 'referral_reward', jsonb_build_object('amount', b));
end $$;
revoke execute on function public._reward_referral(uuid, uuid) from public, anon, authenticated;

-- Referral fields are set only through apply_referral().
create or replace function public.protect_referral() returns trigger language plpgsql as $$
begin
  if (new.referral_code, new.referred_by) is distinct from (old.referral_code, old.referred_by) and not public.is_trusted() then
    raise exception 'Use apply_referral() to enter a referral code';
  end if;
  return new;
end $$;
create trigger profiles_protect_referral before update on public.profiles for each row execute function public.protect_referral();

create trigger orders_money after update of status on public.orders for each row execute function public.money_on_status();

-- ---------- wallet withdrawals (client refunds to MoMo, CLAUDE.md §9) ----------
-- Money goes back only to the MoMo number that topped the wallet up (fraud protection).
create or replace function public.request_withdrawal(p_amount bigint) returns public.payouts
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); w uuid; num text; net text; po public.payouts; ref text;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if p_amount < 100 then raise exception 'Withdraw at least GHS 1'; end if;
  select payer_phone, channel into num, net from public.payments
   where user_id = me and purpose = 'wallet_topup' and state = 'paid' and payer_phone is not null and coalesce(channel, '') <> 'card'
   order by paid_at desc limit 1;
  if num is null then raise exception 'Withdrawals go back to the Mobile Money number you topped up with. You haven''t topped up by MoMo yet.'; end if;
  w := public.wallet_for('customer', me);
  if (select balance from public.wallets where id = w) < p_amount then raise exception 'You don''t have that much in your wallet'; end if;
  ref := 'QCSW' || to_char(now() at time zone 'Africa/Accra', 'YYMMDDHH24MISS') || upper(substr(md5(gen_random_uuid()::text), 1, 8));
  insert into public.payouts (wallet_id, purpose, amount, momo_number, momo_network, status, requested_by, client_reference)
  values (w, 'customer_refund', p_amount, num, net, 'requested', me, ref) returning * into po;
  perform public._ledger('withdrawal_hold', 'Withdrawal to ' || num, jsonb_build_array(
    jsonb_build_object('wallet_id', w, 'amount', -p_amount),
    jsonb_build_object('wallet_id', public.sys_wallet('PAYOUTS_PENDING'), 'amount', p_amount)), null, null, po.id);
  return po;
end $$;
revoke execute on function public.request_withdrawal(bigint) from public, anon;
grant execute on function public.request_withdrawal(bigint) to authenticated;

-- Finance approves (the server then asks Hubtel to send the money) or rejects (money goes back to the wallet).
create or replace function public.approve_payout(p_payout uuid) returns public.payouts
language plpgsql security definer set search_path = public, extensions as $$
declare po public.payouts;
begin
  if not (public.is_trusted() or public.is_finance()) then raise exception 'Only Finance can approve payouts'; end if;
  update public.payouts set status = 'processing', approved_by = auth.uid() where id = p_payout and status = 'requested' returning * into po;
  if po.id is null then raise exception 'This payout is not waiting for approval'; end if;
  return po;
end $$;

create or replace function public._release_payout(po public.payouts, p_status public.payout_status, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.payouts set status = p_status, failure_reason = p_reason where id = po.id;
  perform public._ledger('withdrawal_returned', 'Payout not sent: ' || p_reason, jsonb_build_array(
    jsonb_build_object('wallet_id', public.sys_wallet('PAYOUTS_PENDING'), 'amount', -po.amount),
    jsonb_build_object('wallet_id', po.wallet_id, 'amount', po.amount)), null, null, po.id);
end $$;
revoke execute on function public._release_payout(public.payouts, public.payout_status, text) from public, anon, authenticated;

create or replace function public.reject_payout(p_payout uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare po public.payouts;
begin
  if not (public.is_trusted() or public.is_finance()) then raise exception 'Only Finance can reject payouts'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  select * into po from public.payouts where id = p_payout and status in ('requested', 'held') for update;
  if po.id is null then raise exception 'This payout can''t be rejected now'; end if;
  perform public._release_payout(po, 'cancelled', p_reason);
end $$;

-- Hubtel confirms the money was sent (or not).
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
    jsonb_build_object('wallet_id', public.sys_wallet('PAYOUTS_PENDING'), 'amount', -po.amount),
    jsonb_build_object('wallet_id', public.sys_wallet('HUBTEL_CLEARING'), 'amount', po.amount)), null, p_txn, po.id);
  return 'paid';
end $$;

create or replace function public.fail_payout(p_ref text, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare po public.payouts;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  select * into po from public.payouts where client_reference = p_ref and status = 'processing' for update;
  if po.id is null then return; end if;
  perform public._release_payout(po, 'failed', p_reason);
end $$;

-- ---------- wallets and statements ----------
create or replace function public.my_wallets() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'cash', coalesce((select balance from public.wallets where owner_type = 'customer' and owner_id = auth.uid()), 0),
    'credit', coalesce((select balance from public.wallets where owner_type = 'customer_credit' and owner_id = auth.uid()), 0),
    'referral_code', (select referral_code from public.profiles where id = auth.uid()),
    'can_withdraw_to', (select payer_phone from public.payments where user_id = auth.uid() and purpose = 'wallet_topup' and state = 'paid'
                        and payer_phone is not null and coalesce(channel, '') <> 'card' order by paid_at desc limit 1),
    'vendors', coalesce((select jsonb_agg(jsonb_build_object('vendor_id', v.id, 'business_name', v.business_name, 'balance', w.balance))
                         from public.vendors v join public.wallets w on w.owner_type = 'vendor' and w.owner_id = v.id
                         where v.id in (select public.my_vendor_ids('wallet'))), '[]'::jsonb));
$$;
grant execute on function public.my_wallets() to authenticated;

-- Vendor statement for a date range (Accra dates): opening balance, every wallet movement, COD lines, closing balance.
create or replace function public.vendor_statement(p_vendor uuid, p_from date, p_to date)
returns table (at timestamptz, kind text, reference text, description text, debit bigint, credit bigint, balance bigint, cod bigint)
language plpgsql stable security definer set search_path = public, extensions as $$
declare w uuid; opening bigint; t0 timestamptz := (p_from::timestamp at time zone 'Africa/Accra'); t1 timestamptz := ((p_to + 1)::timestamp at time zone 'Africa/Accra');
begin
  if not (p_vendor in (select public.my_vendor_ids('statements')) or p_vendor in (select public.my_vendor_ids('wallet')) or public.is_finance() or public.is_trusted()) then
    raise exception 'Not allowed to see this statement';
  end if;
  if p_to < p_from or p_to - p_from > 366 then raise exception 'Choose a date range of up to one year'; end if;
  select id into w from public.wallets where owner_type = 'vendor' and owner_id = p_vendor;
  opening := coalesce((select sum(e.amount) from public.ledger_entries e where e.wallet_id = w and e.created_at < t0), 0);
  return query
  with moves as (
    select e.created_at as at, t.kind, o.tracking_number as reference, t.description,
           case when e.amount < 0 then -e.amount end as debit, case when e.amount > 0 then e.amount end as credit, e.amount as delta, null::bigint as cod, e.id as seq
    from public.ledger_entries e join public.ledger_transactions t on t.id = e.transaction_id left join public.orders o on o.id = t.order_id
    where e.wallet_id = w and e.created_at >= t0 and e.created_at < t1
    union all
    select c.collected_at, 'cod_collected', o.tracking_number, 'Cash collected from customer', null, null, 0, c.amount, 0
    from public.cod_collections c join public.orders o on o.id = c.order_id
    where c.vendor_id = p_vendor and c.collected_at >= t0 and c.collected_at < t1
    union all
    select c.remitted_at, 'cod_remitted', o.tracking_number, 'Cash handed to QCS by rider', null, null, 0, c.amount, 0
    from public.cod_collections c join public.orders o on o.id = c.order_id
    where c.vendor_id = p_vendor and c.remitted_at >= t0 and c.remitted_at < t1
  )
  select null::timestamptz, 'opening'::text, null::text, 'Opening balance'::text, null::bigint, null::bigint, opening, null::bigint
  union all
  select x.at, x.kind, x.reference, x.description, x.debit, x.credit, x.balance, x.cod from (
    select m.at, m.kind, m.reference, m.description, m.debit, m.credit,
           (opening + sum(m.delta) over (order by m.at, m.seq rows unbounded preceding))::bigint as balance, m.cod, m.seq
    from moves m order by m.at, m.seq) x
  union all
  select t1, 'closing', null, 'Closing balance', null, null, (opening + coalesce((select sum(m.delta) from moves m), 0))::bigint, null;
end $$;
revoke execute on function public.vendor_statement(uuid, date, date) from public, anon;
grant execute on function public.vendor_statement(uuid, date, date) to authenticated, service_role;

-- ---------- scheduled jobs ----------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('expire-unpaid-orders', '*/10 * * * *', 'select public.expire_unpaid_orders()');
  end if;
end $$;

revoke execute on function public.create_payment(uuid, public.payment_purpose, uuid[], bigint, uuid) from public, anon, authenticated;
revoke execute on function public.attach_checkout(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.record_payment_event(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.settle_payment(text, text, bigint, text, text, text) from public, anon, authenticated;
revoke execute on function public.fail_payment(text, text) from public, anon, authenticated;
revoke execute on function public.complete_payout(text, text) from public, anon, authenticated;
revoke execute on function public.fail_payout(text, text) from public, anon, authenticated;
revoke execute on function public.expire_unpaid_orders() from public, anon, authenticated;
grant execute on function public.create_payment(uuid, public.payment_purpose, uuid[], bigint, uuid), public.attach_checkout(uuid, text, text),
  public.record_payment_event(text, text, text, jsonb), public.settle_payment(text, text, bigint, text, text, text), public.fail_payment(text, text),
  public.complete_payout(text, text), public.fail_payout(text, text), public.expire_unpaid_orders() to service_role;

-- ---------- create_booking now charges wallets at booking ----------
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

  perform public._charge_booking(q.id);   -- wallet payments and vendor insurance premiums
  update public.quotes set used_at = now() where id = q.id;
  return jsonb_build_object('trip_id', v_trip, 'needs_payment', upfront, 'total', q.total, 'orders', out,
                            'paid_from_wallet', (req ->> 'payer') = 'sender' and (req ->> 'payment_method') = 'wallet');
end $$;
