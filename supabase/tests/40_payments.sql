-- =====================================================================
-- Phase 4 tests: Hubtel payments, wallets, refunds, referrals, withdrawals, statements.
-- =====================================================================
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000000301', '+233200000301'),  -- Ama, customer
  ('00000000-0000-0000-0000-000000000302', '+233200000302'),  -- Kofi, new customer (referred by Ama)
  ('00000000-0000-0000-0000-000000000303', '+233200000303'),  -- vendor owner
  ('00000000-0000-0000-0000-000000000304', '+233200000304'),  -- finance
  ('00000000-0000-0000-0000-000000000305', '+233200000305');  -- dispatcher
insert into user_roles (user_id, role, city_id) values ('00000000-0000-0000-0000-000000000304', 'finance', null);
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000305', 'dispatcher', id from cities where code = 'ACC';
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000303', 'Kente Hub', id from cities where code = 'ACC';

create temp table k as select (select id from cities where code = 'ACC') acc, (select id from zones where code = 'ACC-ELG') legon;
grant select on k to anon, authenticated, service_role;

-- book through the real create_booking, as our server would
create function tests.book(p_user uuid, p_payer text, p_method text, p_drops int, p_fee int default 3000, p_vendor uuid default null, p_ref text default 'R')
returns jsonb language plpgsql as $$
declare qid uuid; req jsonb;
begin
  req := jsonb_build_object('service', case when p_vendor is null then 'express' else 'ecommerce' end, 'payer', p_payer, 'payment_method', p_method,
    'pickup', jsonb_build_object('formatted_address', 'Osu', 'lat', 5.556, 'lng', -0.178, 'contact_name', 'S', 'contact_phone', '+233241111111'),
    'dropoffs', (select jsonb_agg(jsonb_build_object('formatted_address', 'Legon ' || g, 'lat', 5.6355, 'lng', -0.161, 'contact_name', 'R' || g,
       'contact_phone', '+233242000000', 'weight_g', 1000, 'size', 'small', 'fragile', false, 'item_value', 0, 'cod_amount', 0,
       'external_ref', case when p_vendor is null then null else p_ref || g end)) from generate_series(1, p_drops) g));
  insert into quotes (user_id, vendor_id, service_type, city_id, request, price, zones, total)
  select p_user, p_vendor, (req ->> 'service')::service_type, acc, req,
         jsonb_build_object('stops', (select jsonb_agg(jsonb_build_object('netPesewas', p_fee, 'insurancePesewas', 0, 'lines', '[]'::jsonb)) from generate_series(1, p_drops))),
         (select jsonb_agg(z) from (select k2.legon z from k k2, generate_series(1, p_drops)) s), p_fee * p_drops from k
  returning id into qid;
  return create_booking(p_user, qid);
end $$;
-- move an order along as the trusted server (proof of delivery filled in)
create function tests.walk(p_order uuid, p_path text[]) returns void language plpgsql as $$
declare s text;
begin
  perform set_config('qcs.system', 'on', true);
  update orders set pod_otp_verified_at = now(), pod_signature_path = 'sig.png' where id = p_order;
  perform set_config('qcs.system', 'off', true);
  foreach s in array p_path loop
    perform transition_order(p_order, s::order_status, null, null, null, null, case when s = 'FAILED_ATTEMPT' then 'No answer' end);
  end loop;
end $$;
create function tests.bal(p_type wallet_owner, p_owner uuid) returns bigint language sql as $$
  select coalesce((select balance from wallets where owner_type = p_type and owner_id = p_owner), 0) $$;
create function tests.sys(p_code text) returns bigint language sql as $$ select balance from wallets where system_code = p_code $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;


-- =====================================================================
-- 1. MoMo order stays PENDING_PAYMENT until Hubtel's payment is verified
-- =====================================================================
select tests.service();
create temp table o1 as select (tests.book('00000000-0000-0000-0000-000000000301', 'sender', 'momo', 1) -> 'orders' -> 0 ->> 'id')::uuid id;
grant select on o1 to anon, authenticated, service_role;
select tests.ok((select status = 'PENDING_PAYMENT' from orders where id = (select id from o1)), 'MoMo order waits for payment');

select tests.login('00000000-0000-0000-0000-000000000301');
select tests.expect_error($$select create_payment(auth.uid(), 'order', array[(select id from o1)])$$, 'permission denied', 'apps cannot start payments directly');
select tests.expect_error($$select settle_payment('X', null, 1, null, null, null)$$, 'permission denied', 'apps cannot mark payments as paid');

select tests.service();
create temp table p1 as select * from create_payment('00000000-0000-0000-0000-000000000301', 'order', array[(select id from o1)]);
grant select on p1 to anon, authenticated, service_role;
select tests.ok((select amount = 3000 and length(client_reference) <= 32 from p1), 'payment amount = the order total; reference fits Hubtel''s 32 characters');
select tests.expect_error($$select create_payment('00000000-0000-0000-0000-000000000302', 'order', array[(select id from o1)])$$, 'not yours', 'cannot pay for someone else''s order');
select attach_checkout((select id from p1), 'chk_1', 'https://checkout.hubtel.com/x');
select tests.ok(record_payment_event((select client_reference from p1), 'checkout_callback', 'cb-1', '{"a":1}'), 'first callback recorded');
select tests.ok(not record_payment_event((select client_reference from p1), 'checkout_callback', 'cb-1', '{"a":1}'), 'the same callback again is ignored');
select tests.expect_error($$select settle_payment((select client_reference from p1), 'chk_1', 2000, 't1', 'mtn-gh', '+233244000301')$$, 'amount mismatch', 'wrong amount is refused');
select tests.ok((select status = 'PENDING_PAYMENT' from orders where id = (select id from o1)), 'order NOT confirmed after a wrong amount');
select tests.expect_error($$select settle_payment((select client_reference from p1), 'chk_OTHER', 3000, 't1', 'mtn-gh', '+233244000301')$$, 'does not match', 'callback for another checkout is refused');
select tests.ok(settle_payment((select client_reference from p1), 'chk_1', 3000, 't1', 'mtn-gh', '+233244000301') = 'settled', 'correct payment settles');
select tests.ok((select status = 'CONFIRMED' and payment_status = 'paid' and paid_online = 3000 from orders where id = (select id from o1)), 'order CONFIRMED only after payment verified');
create temp table n_tx as select count(*) n from ledger_transactions;
grant select on n_tx to anon, authenticated, service_role;
select tests.ok(settle_payment((select client_reference from p1), 'chk_1', 3000, 't1', 'mtn-gh', '+233244000301') = 'already_paid', 'second confirmation is harmless');
select tests.ok((select count(*) from ledger_transactions) = (select n from n_tx), 'no double-counting in the ledger');
select tests.expect_error($$select create_payment('00000000-0000-0000-0000-000000000301', 'order', array[(select id from o1)])$$, 'not waiting for payment', 'cannot pay twice for a confirmed order');

-- =====================================================================
-- 2. Wallet top-up, wallet-paid booking, promo credit first
-- =====================================================================
create temp table p2 as select * from create_payment('00000000-0000-0000-0000-000000000301', 'wallet_topup', null, 5000);
grant select on p2 to anon, authenticated, service_role;
select tests.expect_error($$select create_payment('00000000-0000-0000-0000-000000000301', 'wallet_topup', null, 50)$$, 'top up between', 'top-up below the minimum refused');
select settle_payment((select client_reference from p2), null, 5000, 't2', 'mtn-gh', '+233244000301');
select tests.ok(tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 5000, 'top-up credited to the wallet');

create temp table o2 as select tests.book('00000000-0000-0000-0000-000000000301', 'sender', 'wallet', 1) r;
grant select on o2 to anon, authenticated, service_role;
select tests.ok((select (r -> 'orders' -> 0 ->> 'status') = 'CONFIRMED' from o2) and tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 2000, 'wallet order confirmed and GHS 30 taken from the wallet');
select tests.expect_error($$select tests.book('00000000-0000-0000-0000-000000000301', 'sender', 'wallet', 1, 9000)$$, 'not enough in your qcs wallet', 'not enough balance: booking refused');
select tests.ok(tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 2000, 'refused booking took nothing');

select tests.logout();
select post_ledger_transaction('promo', 'test credit', jsonb_build_array(jsonb_build_object('wallet_id', wallet_for('customer_credit', '00000000-0000-0000-0000-000000000301'), 'amount', 1000),
                                                                       jsonb_build_object('wallet_id', sys_wallet('PROMO_EXPENSE'), 'amount', -1000)));
select tests.service();
create temp table o3 as select (tests.book('00000000-0000-0000-0000-000000000301', 'sender', 'wallet', 1) -> 'orders' -> 0 ->> 'id')::uuid id;
grant select on o3 to anon, authenticated, service_role;
select tests.ok(tests.bal('customer_credit', '00000000-0000-0000-0000-000000000301') = 0 and tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 0
                and (select paid_from_credit = 1000 and paid_from_wallet = 2000 from orders where id = (select id from o3)), 'promo credit used first, then cash');

-- cancelling a paid order refunds automatically, credit back as credit
select tests.logout();
select transition_order((select id from o3), 'CANCELLED', null, null, 'Changed my mind', null, null);
select tests.ok(tests.bal('customer_credit', '00000000-0000-0000-0000-000000000301') = 1000 and tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 2000, 'cancelled: GHS 10 back as credit, GHS 20 back as cash');
select tests.ok((select payment_status = 'refunded' and refunded_amount = 3000 from orders where id = (select id from o3)), 'order marked refunded');

-- =====================================================================
-- 3. Vendor wallet: pay per successful delivery, 50% on returns
-- =====================================================================
select tests.service();
create temp table t1 as select tests.book('00000000-0000-0000-0000-000000000303', 'vendor_wallet', 'wallet', 2, 3000, '10000000-0000-0000-0000-000000000301') r;
grant select on t1 to anon, authenticated, service_role;
select tests.ok(tests.bal('vendor', '10000000-0000-0000-0000-000000000301') = 0, 'nothing charged to the vendor at booking');
select tests.logout();
select tests.walk((select (r -> 'orders' -> 0 ->> 'id')::uuid from t1), array['ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED_AT_DROPOFF','DELIVERED']);
select tests.ok(tests.bal('vendor', '10000000-0000-0000-0000-000000000301') = -3000, 'delivered: GHS 30 charged to the vendor wallet');
select tests.walk((select (r -> 'orders' -> 1 ->> 'id')::uuid from t1), array['ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED_AT_DROPOFF','FAILED_ATTEMPT','RETURNING_TO_SENDER','RETURNED']);
select tests.ok(tests.bal('vendor', '10000000-0000-0000-0000-000000000301') = -4500, 'returned: 50% (GHS 15) charged');
select tests.ok((select failed_fee = 1500 and fees_charged = 1500 from orders where id = (select (r -> 'orders' -> 1 ->> 'id')::uuid from t1)), 'return fee recorded on the order');

-- prepaid order returned: half the fee comes back
select tests.walk((select id from o1), array['ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED_AT_DROPOFF','FAILED_ATTEMPT','RETURNING_TO_SENDER','RETURNED']);
select tests.ok(tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 3500, 'MoMo-paid order returned: GHS 15 back to the wallet');

-- =====================================================================
-- 4. Late payment and unpaid-order expiry
-- =====================================================================
select tests.service();
create temp table o4 as select (tests.book('00000000-0000-0000-0000-000000000301', 'sender', 'card', 1) -> 'orders' -> 0 ->> 'id')::uuid id;
grant select on o4 to anon, authenticated, service_role;
create temp table p4 as select * from create_payment('00000000-0000-0000-0000-000000000301', 'order', array[(select id from o4)]);
grant select on p4 to anon, authenticated, service_role;
select tests.logout();
update orders set created_at = now() - interval '2 hours' where id = (select id from o4);
create temp table ex as select expire_unpaid_orders() n;
select tests.ok((select n from ex) >= 1, 'expiry job found the unpaid order');
select tests.ok((select status = 'CANCELLED' from orders where id = (select id from o4)), 'unpaid card order cancelled after the time limit');
select tests.service();
select settle_payment((select client_reference from p4), null, 3000, 't4', 'card', null);
select tests.ok(tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 6500, 'paid after it was cancelled: money kept safe in the wallet');

-- =====================================================================
-- 5. Refunds by Finance
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000305');
select tests.expect_error($$select refund_order((select (r -> 'orders' -> 0 ->> 'id')::uuid from t1), 500, 'late')$$, 'only finance', 'dispatcher cannot refund');
select tests.login('00000000-0000-0000-0000-000000000304');
select tests.expect_error($$select refund_order((select (r -> 'orders' -> 0 ->> 'id')::uuid from t1), 500, '')$$, 'reason', 'refund needs a reason');
select tests.expect_error($$select refund_order((select (r -> 'orders' -> 0 ->> 'id')::uuid from t1), 99999, 'late')$$, 'up to ghs 30.00', 'cannot refund more than was charged');
select refund_order((select (r -> 'orders' -> 0 ->> 'id')::uuid from t1), 1000, 'Rider was very late');
select tests.ok(tests.bal('vendor', '10000000-0000-0000-0000-000000000301') = -3500, 'GHS 10 refunded to the vendor wallet');
select tests.ok(exists (select 1 from audit_log where action = 'REFUND' and reason = 'Rider was very late' and actor_id = '00000000-0000-0000-0000-000000000304'), 'refund in the audit log');

-- =====================================================================
-- 6. Referrals
-- =====================================================================
select tests.logout();
create temp table ama_code as select referral_code c from profiles where id = '00000000-0000-0000-0000-000000000301';
grant select on ama_code to anon, authenticated, service_role;
select tests.ok((select c ~ '^QCS[A-Z0-9]{5}$' from ama_code), 'everyone gets a referral code like QCSAB12C');
select tests.login('00000000-0000-0000-0000-000000000302');
select tests.expect_error($$select apply_referral((select referral_code from profiles where id = auth.uid()))$$, 'own code', 'cannot refer yourself');
select tests.expect_error($$select apply_referral('NOPE')$$, 'isn''t valid', 'unknown referral code');
select tests.ok(apply_referral((select c from ama_code)) is not null, 'new customer enters a friend''s code');
select tests.expect_error($$select apply_referral((select c from ama_code))$$, 'already used', 'only one referral code');
select tests.expect_error($$update profiles set referred_by = null where id = auth.uid()$$, 'apply_referral', 'referral cannot be edited directly');
select tests.service();
create temp table o5 as select tests.book('00000000-0000-0000-0000-000000000302', 'sender', 'cash', 2) r;
grant select on o5 to anon, authenticated, service_role;
select tests.logout();
select tests.walk((select (r -> 'orders' -> 0 ->> 'id')::uuid from o5), array['SEARCHING_RIDER','ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED_AT_DROPOFF','DELIVERED']);
select tests.ok(tests.bal('customer_credit', '00000000-0000-0000-0000-000000000302') = 1000 and tests.bal('customer_credit', '00000000-0000-0000-0000-000000000301') = 2000, 'first delivery: GHS 10 credit each for Kofi and Ama');
select tests.walk((select (r -> 'orders' -> 1 ->> 'id')::uuid from o5), array['SEARCHING_RIDER','ASSIGNED','RIDER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED_AT_DROPOFF','DELIVERED']);
select tests.ok(tests.bal('customer_credit', '00000000-0000-0000-0000-000000000302') = 1000, 'reward only once');
select tests.login('00000000-0000-0000-0000-000000000302');
select tests.expect_error($$select apply_referral('QCSAAAAA')$$, 'already used', 'no code after the first delivery');

-- =====================================================================
-- 7. Withdrawals back to the MoMo number that topped up
-- =====================================================================
select tests.expect_error($$select request_withdrawal(500)$$, 'topped up with', 'no MoMo top-up yet: no withdrawal');
select tests.login('00000000-0000-0000-0000-000000000301');
select tests.expect_error($$select request_withdrawal(999999)$$, 'that much', 'cannot withdraw more than the balance');
create temp table w1 as select * from request_withdrawal(1500);
grant select on w1 to anon, authenticated, service_role;
select tests.ok((select momo_number = '+233244000301' and status = 'requested' from w1) and tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 5000, 'withdrawal to the top-up number; money set aside');
select tests.expect_error($$select approve_payout((select id from w1))$$, 'only finance', 'customer cannot approve their own payout');
select tests.login('00000000-0000-0000-0000-000000000304');
select approve_payout((select id from w1));
select tests.service();
select tests.ok(complete_payout((select client_reference from w1), 'hub-1') = 'paid' and tests.sys('PAYOUTS_PENDING') = 0, 'Hubtel confirms: payout paid, nothing left pending');
select tests.ok(complete_payout((select client_reference from w1), 'hub-1') = 'already_paid', 'second confirmation is harmless');
select tests.login('00000000-0000-0000-0000-000000000301');
create temp table w2 as select * from request_withdrawal(1000);
grant select on w2 to anon, authenticated, service_role;
select tests.login('00000000-0000-0000-0000-000000000304');
select approve_payout((select id from w2));
select tests.service();
select fail_payout((select client_reference from w2), 'Number not registered');
select tests.ok(tests.bal('customer', '00000000-0000-0000-0000-000000000301') = 5000 and (select status = 'failed' from payouts where id = (select id from w2)), 'failed payout: money back in the wallet');

-- =====================================================================
-- 8. Statements, visibility, and the books balance
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000303');
create temp table st as select * from vendor_statement('10000000-0000-0000-0000-000000000301', (now() at time zone 'Africa/Accra')::date - 1, (now() at time zone 'Africa/Accra')::date);
grant select on st to anon, authenticated, service_role;
select tests.ok((select kind from st where at is null) = 'opening' and (select count(*) from st where kind in ('delivery_fee', 'return_fee', 'refund')) = 3, 'statement lists the delivery fee, return fee and refund');
select tests.ok((select balance from st where kind = 'closing') = tests.bal('vendor', '10000000-0000-0000-0000-000000000301'), 'closing balance on the statement = wallet balance');
select tests.ok((my_wallets() -> 'vendors' -> 0 ->> 'balance')::bigint = -3500, 'my_wallets shows the business wallet');
select tests.login('00000000-0000-0000-0000-000000000301');
select tests.expect_error($$select * from vendor_statement('10000000-0000-0000-0000-000000000301', current_date - 1, current_date)$$, 'not allowed', 'other people cannot read a vendor''s statement');
select tests.ok((my_wallets() ->> 'cash')::bigint = 5000 and (my_wallets() ->> 'credit')::bigint = 2000 and my_wallets() ->> 'can_withdraw_to' = '+233244000301', 'my_wallets: cash, credit and withdrawal number');
select tests.ok((select count(*) from payments) = 3, 'customer sees only their own payments');
select tests.ok((select count(*) from payment_events) = 0, 'customers cannot read raw Hubtel messages');
select tests.logout();
select tests.ok((select sum(balance) from wallets) = 0, 'every wallet together still sums to zero');

rollback;
