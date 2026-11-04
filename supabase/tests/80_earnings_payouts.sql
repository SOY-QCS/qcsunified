-- =====================================================================
-- Phase 8 tests: rider earnings, COD through the ledger, hand-in (hub / MoMo), banking,
-- payout batches with two-person approval, holds, instant cash-out, reconciliation, exports.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000000801', '+233200000801'),  -- F: fleet rider
  ('00000000-0000-0000-0000-000000000802', '+233200000802'),  -- C: independent rider (20%)
  ('00000000-0000-0000-0000-000000000810', '+233200000810'),  -- vendor owner
  ('00000000-0000-0000-0000-000000000811', '+233200000811'),  -- customer
  ('00000000-0000-0000-0000-000000000820', '+233200000820'),  -- finance A
  ('00000000-0000-0000-0000-000000000821', '+233200000821'),  -- finance B
  ('00000000-0000-0000-0000-000000000822', '+233200000822'),  -- hub manager Accra
  ('00000000-0000-0000-0000-000000000823', '+233200000823');  -- dispatcher Accra
update profiles set full_name = 'Yaw Fleet' where id = '00000000-0000-0000-0000-000000000801';
update profiles set full_name = 'Kojo Indie' where id = '00000000-0000-0000-0000-000000000802';
insert into user_roles (user_id, role) values ('00000000-0000-0000-0000-000000000820', 'finance'), ('00000000-0000-0000-0000-000000000821', 'finance');
insert into user_roles (user_id, role, city_id) select u, r::app_role, (select id from cities where code = 'ACC')
from (values ('00000000-0000-0000-0000-000000000822'::uuid, 'hub_manager'), ('00000000-0000-0000-0000-000000000823', 'dispatcher')) v(u, r);
insert into vendors (id, owner_id, business_name, city_id, payout_momo_number, payout_momo_network, cod_payout_schedule)
select '10000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000810', 'Kente Hub', id, '+233240000810', 'mtn', 'weekly' from cities where code = 'ACC';
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000000801', 'bike', 'GR-801'), ('50000000-0000-0000-0000-000000000802', 'bike', 'GR-802');
insert into riders (id, rider_type, status, city_id, vehicle_id, is_online, last_location, last_location_at, commission_rate_bp)
select v.id, v.t::rider_type, 'active', c.id, v.veh, true, st_setsrid(st_makepoint(-0.1775, 5.556), 4326)::geography, now(), v.bp
from (values ('00000000-0000-0000-0000-000000000801'::uuid, 'fleet', '50000000-0000-0000-0000-000000000801'::uuid, null::int),
             ('00000000-0000-0000-0000-000000000802', 'commission', '50000000-0000-0000-0000-000000000802', 2000)) v(id, t, veh, bp)
cross join cities c where c.code = 'ACC';
create temp table k as select (select id from cities where code = 'ACC') acc, (select id from zones where code = 'ACC-ELG') legon,
                              (select id from hubs where city_id = (select id from cities where code = 'ACC') limit 1) hub;
grant select on k to anon, authenticated, service_role;
select tests.ok((select hub is not null from k), 'setup: Accra has a hub');

create function tests.book8(p_user uuid, p_vendor uuid, p_drops int, p_cod int) returns jsonb language plpgsql as $$
declare qid uuid; req jsonb;
begin
  req := jsonb_build_object('service', case when p_vendor is null then 'express' else 'ecommerce' end,
    'payer', case when p_vendor is null then 'sender' else 'vendor_wallet' end, 'payment_method', case when p_vendor is null then 'cash' else 'wallet' end,
    'pickup', jsonb_build_object('formatted_address', 'Oxford St, Osu', 'lat', 5.556, 'lng', -0.178, 'contact_name', 'Ama', 'contact_phone', '+233241111111'),
    'dropoffs', (select jsonb_agg(jsonb_build_object('formatted_address', 'Lagos Ave ' || g, 'lat', 5.6355, 'lng', -0.161, 'contact_name', 'Esi ' || g,
       'contact_phone', '+233242000000', 'weight_g', 1000, 'size', 'small', 'fragile', false, 'item_value', 0, 'cod_amount', p_cod)) from generate_series(1, p_drops) g));
  insert into quotes (user_id, vendor_id, service_type, city_id, request, price, zones, total)
  select p_user, p_vendor, (req ->> 'service')::service_type, acc, req,
         jsonb_build_object('stops', (select jsonb_agg(jsonb_build_object('netPesewas', 3000, 'insurancePesewas', 0, 'lines', '[]'::jsonb)) from generate_series(1, p_drops))),
         (select jsonb_agg(z) from (select k2.legon z from k k2, generate_series(1, p_drops)) s), 3000 * p_drops from k returning id into qid;
  return create_booking(p_user, qid);
end $$;
-- the rider does the whole job in the app (offline-safe actions); COD collected when there is any
create function tests.do_job(p_rider uuid, p_trip uuid) returns void language plpgsql as $$
declare o record;
begin
  perform tests.login(p_rider);
  for o in select id from orders where trip_id = p_trip order by created_at loop
    perform rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', o.id, 'to', 'RIDER_AT_PICKUP', 'lng', -0.178, 'lat', 5.556));
    perform rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', o.id, 'to', 'PICKED_UP', 'lng', -0.178, 'lat', 5.556));
    perform rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', o.id, 'to', 'IN_TRANSIT', 'lng', -0.17, 'lat', 5.6));
  end loop;
  for o in select id, cod_amount from orders where trip_id = p_trip order by created_at loop
    perform rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', o.id, 'to', 'ARRIVED_AT_DROPOFF', 'lng', -0.161, 'lat', 5.6355));
    perform rider_action(gen_random_uuid(), jsonb_build_object('type', 'code', 'order_id', o.id,
      'code', (select payload ->> 'code' from notifications n where n.order_id = o.id and template = 'delivery_code' order by created_at desc limit 1)));
    perform rider_action(gen_random_uuid(), jsonb_build_object('type', 'pod', 'order_id', o.id, 'signature_path', o.id || '/sig.svg'));
    if o.cod_amount > 0 then perform rider_action(gen_random_uuid(), jsonb_build_object('type', 'cod', 'order_id', o.id, 'amount', o.cod_amount, 'method', 'cash')); end if;
    perform rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', o.id, 'to', 'DELIVERED', 'lng', -0.161, 'lat', 5.6355));
  end loop;
  perform tests.logout();
end $$;
create function tests.bal(p_type text, p_owner uuid) returns bigint language sql as $$
  select coalesce((select balance from wallets where owner_type = p_type::wallet_owner and owner_id = p_owner), 0) $$;
create function tests.sys(p_code text) returns bigint language sql as $$ select balance from wallets where system_code = p_code $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- =====================================================================
-- 1. Earnings engine
-- =====================================================================
select tests.service();
create temp table b1 as select tests.book8('00000000-0000-0000-0000-000000000810', '10000000-0000-0000-0000-000000000801', 2, 10000) j;   -- 2 drops, GHS 100 COD each
create temp table b2 as select tests.book8('00000000-0000-0000-0000-000000000811', null, 1, 0) j;                                          -- express, GHS 30
grant select on b1, b2 to anon, authenticated, service_role;
select assign_trip((select (j ->> 'trip_id')::uuid from b1), '00000000-0000-0000-0000-000000000801');
select assign_trip((select trip_id from orders where id = (select (j -> 'orders' -> 0 ->> 'id')::uuid from b2)), '00000000-0000-0000-0000-000000000802');
select tests.logout();
create temp table rexp as select (select balance from wallets where system_code = 'RIDER_EARNINGS_EXPENSE') v;
grant select on rexp to anon, authenticated, service_role;
select tests.do_job('00000000-0000-0000-0000-000000000801', (select (j ->> 'trip_id')::uuid from b1));
select tests.do_job('00000000-0000-0000-0000-000000000802', (select trip_id from orders where id = (select (j -> 'orders' -> 0 ->> 'id')::uuid from b2)));

select tests.ok((select count(*) = 1 and sum(amount) = 500 from rider_earnings where rider_id = '00000000-0000-0000-0000-000000000801' and kind = 'pickup'),
  'fleet: one pickup fee for the trip (GHS 5), not one per parcel');
select tests.ok((select count(*) = 2 and sum(amount) = 1600 from rider_earnings where rider_id = '00000000-0000-0000-0000-000000000801' and kind = 'delivery'),
  'fleet: GHS 8 per successful stop');
select tests.ok(tests.bal('rider', '00000000-0000-0000-0000-000000000801') = 2100, 'fleet rider wallet = GHS 21');
select tests.ok((select amount = 600 and description like '%20%' from rider_earnings where rider_id = '00000000-0000-0000-0000-000000000802' and kind = 'commission'),
  'independent: 20% of the GHS 30 delivery fee = GHS 6');
select tests.ok(not exists (select 1 from rider_earnings where rider_id = '00000000-0000-0000-0000-000000000802' and kind = 'pickup'), 'independent riders get no pickup fee');
select tests.ok((select v - 2700 from rexp) = tests.sys('RIDER_EARNINGS_EXPENSE'), 'every earning is an expense in the ledger');
-- paid once only
select _earn('00000000-0000-0000-0000-000000000801', 'delivery', 800, (select id from orders where trip_id = (select (j ->> 'trip_id')::uuid from b1) limit 1), null, 'again');
select tests.ok(tests.bal('rider', '00000000-0000-0000-0000-000000000801') = 2100, 'the same delivery is never paid twice');

-- bonuses and deductions
select tests.login('00000000-0000-0000-0000-000000000823');
select tests.expect_error($$select add_rider_adjustment('00000000-0000-0000-0000-000000000801', 'bonus', 1000, 'Rider of the week')$$, 'only finance', 'dispatcher cannot add a bonus');
select tests.login('00000000-0000-0000-0000-000000000820');
select add_rider_adjustment('00000000-0000-0000-0000-000000000801', 'bonus', 1000, 'Rider of the week');
select add_rider_adjustment('00000000-0000-0000-0000-000000000801', 'deduction', 300, 'Lost delivery bag');
select tests.logout();
select tests.ok(tests.bal('rider', '00000000-0000-0000-0000-000000000801') = 2800, 'bonus +GHS 10, deduction −GHS 3 → GHS 28');
select tests.ok(exists (select 1 from audit_log where table_name = 'rider_earnings' and reason = 'Lost delivery bag'), 'adjustments are in the audit log');

-- rider's own screen
select tests.login('00000000-0000-0000-0000-000000000801');
create temp table me as select my_earnings() j;
grant select on me to anon, authenticated, service_role;
select tests.ok((select (j ->> 'today')::int = 2800 and (j ->> 'balance')::int = 2800 and jsonb_array_length(j -> 'lines') = 5 from me), 'rider sees today''s total and each line');
select tests.ok((select (j ->> 'cash_total')::int = 20000 and jsonb_array_length(j -> 'cash') = 2 from me), 'rider sees GHS 200 cash in hand, parcel by parcel');
select tests.ok(tests.rows($$update rider_earnings set amount = 99999$$) = 0, 'riders can''t edit their earnings');
select tests.logout();

-- =====================================================================
-- 2. COD: collected → handed in (hub / MoMo) → banked
-- =====================================================================
select tests.ok(tests.bal('rider_cash', '00000000-0000-0000-0000-000000000801') = -20000 and tests.bal('vendor_cod', '10000000-0000-0000-0000-000000000801') = 20000,
  'COD collected: rider holds GHS 200 for QCS, QCS owes the vendor GHS 200');
create temp table cods as select order_id, row_number() over (order by collected_at, order_id) n from cod_collections where rider_id = '00000000-0000-0000-0000-000000000801';
grant select on cods to anon, authenticated, service_role;
select tests.login('00000000-0000-0000-0000-000000000823');
select tests.expect_error($$select receive_cod_cash('00000000-0000-0000-0000-000000000801', array(select order_id from cods where n = 1), (select hub from k))$$, 'hub staff', 'dispatcher cannot receive cash');
select tests.login('00000000-0000-0000-0000-000000000822');
select tests.ok(receive_cod_cash('00000000-0000-0000-0000-000000000801', array(select order_id from cods where n = 1), (select hub from k), 'counted twice') = 10000, 'hub manager receives GHS 100 cash');
select tests.expect_error($$select receive_cod_cash('00000000-0000-0000-0000-000000000801', array(select order_id from cods where n = 1), (select hub from k))$$, 'still holding', 'the same cash can''t be received twice');
select tests.logout();
select tests.ok(hub_cash_on_hand((select hub from k)) = 10000 and tests.sys('HUB_CASH') = -10000, 'GHS 100 is now at the hub');

-- MoMo hand-in through Hubtel
select tests.service();
create temp table pay as select create_cod_remit_payment('00000000-0000-0000-0000-000000000801', array(select order_id from cods where n = 2)) p;
grant select on pay to anon, authenticated, service_role;
select tests.ok((select (p).amount = 10000 and (p).purpose = 'cod_remit' from pay), 'MoMo hand-in checkout for GHS 100');
select tests.expect_error($$select create_cod_remit_payment('00000000-0000-0000-0000-000000000801', array(select order_id from cods where n = 1))$$, 'already handed in', 'cash already at the hub can''t be paid again');
select settle_payment((select (p).client_reference from pay), null, 10000, 'HT-1', 'mtn-gh', '+233200000801');
select tests.logout();
select tests.ok(tests.bal('rider_cash', '00000000-0000-0000-0000-000000000801') = 0 and (select bool_and(status = 'remitted') from cod_collections where order_id in (select order_id from cods)),
  'all cash handed in: rider owes nothing');
select tests.ok((select remit_method = 'momo' from cod_collections where order_id = (select order_id from cods where n = 2)), 'recorded as a MoMo hand-in');

-- bank the hub cash
select tests.login('00000000-0000-0000-0000-000000000820');
select tests.expect_error($$select bank_hub_cash((select hub from k), 50000, 'SLIP-1')$$, 'more than the cash', 'cannot bank more than the hub holds');
select bank_hub_cash((select hub from k), 10000, 'SLIP-1');
select tests.logout();
select tests.ok(hub_cash_on_hand((select hub from k)) = 0 and tests.sys('BANK') = -10000, 'hub cash banked');

-- =====================================================================
-- 3. Vendor COD payout batch with two-person approval
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000820');
create temp table vb as select create_vendor_cod_batch('weekly') id;
grant select on vb to anon, authenticated, service_role;
select tests.ok((select count(*) = 1 and sum(amount) = 20000 and bool_and(status = 'requested') from payouts where batch_id = (select id from vb)), 'vendor payout of GHS 200 prepared');
select tests.ok(tests.bal('vendor_cod', '10000000-0000-0000-0000-000000000801') = 0 and tests.sys('PAYOUTS_PENDING') >= 20000, 'money set aside so it can''t be paid twice');
select tests.ok((select bool_and(payout_id is not null) from cod_collections where order_id in (select order_id from cods)), 'the parcels are linked to the payout');
select tests.expect_error($$select approve_payout_batch((select id from vb))$$, 'someone else', 'you cannot approve a batch you prepared');
select tests.login('00000000-0000-0000-0000-000000000821');
create temp table sent as select p from approve_payout_batch((select id from vb)) p;
grant select on sent to anon, authenticated, service_role;
select tests.ok((select count(*) = 1 from sent), 'second Finance person approves: 1 payout to send');
select tests.service();
select complete_payout((select (p).client_reference from sent), 'HT-OUT-1');
select tests.logout();
select tests.ok((select bool_and(status = 'paid_out') from cod_collections where order_id in (select order_id from cods)), 'vendor paid: COD parcels marked paid out');
select tests.ok(tests.bal('vendor', '10000000-0000-0000-0000-000000000801') = -6000, 'fees stay separate: vendor still owes GHS 60 in delivery fees');

-- fees unpaid > 7 days → next COD payout held
select tests.service();
create temp table b3 as select tests.book8('00000000-0000-0000-0000-000000000810', '10000000-0000-0000-0000-000000000801', 2, 5000) j;
grant select on b3 to anon, authenticated, service_role;
select assign_trip((select (j ->> 'trip_id')::uuid from b3), '00000000-0000-0000-0000-000000000801');
select tests.logout();
select tests.do_job('00000000-0000-0000-0000-000000000801', (select (j ->> 'trip_id')::uuid from b3));
-- pretend the fees were charged 10 days ago (test only: the ledger is normally untouchable)
set constraints all immediate;
alter table ledger_entries disable trigger ledger_entries_append_only;
update ledger_entries set created_at = now() - interval '10 days' where wallet_id = (select id from wallets where owner_type = 'vendor' and owner_id = '10000000-0000-0000-0000-000000000801');
alter table ledger_entries enable trigger ledger_entries_append_only;
set constraints all deferred;
select tests.login('00000000-0000-0000-0000-000000000822');
select receive_cod_cash('00000000-0000-0000-0000-000000000801', array(select order_id from cod_collections where status = 'collected' and rider_id = '00000000-0000-0000-0000-000000000801'), (select hub from k));
select tests.login('00000000-0000-0000-0000-000000000821');
create temp table vb2 as select create_vendor_cod_batch('weekly') id;
grant select on vb2 to anon, authenticated, service_role;
select tests.ok((select status = 'held' and hold_reason like 'Delivery fees unpaid for more than 7 days%' from payouts where batch_id = (select id from vb2)), 'fees unpaid for over 7 days: COD payout held');
select tests.logout();
select tests.ok(exists (select 1 from notifications where template = 'cod_payout_held' and user_id = '00000000-0000-0000-0000-000000000810'), 'vendor is told why');
select tests.login('00000000-0000-0000-0000-000000000820');
select cancel_payout_batch((select id from vb2), 'Wait for fees to be paid');
select tests.logout();
select tests.ok(tests.bal('vendor_cod', '10000000-0000-0000-0000-000000000801') = 10000 and (select bool_and(payout_id is null) from cod_collections where status = 'remitted'),
  'cancelled batch: money and parcels are payable again');

-- =====================================================================
-- 4. Rider payouts
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000820');
create temp table rb as select create_rider_payout_batch() id;
grant select on rb to anon, authenticated, service_role;
select tests.ok((select note like '%no MoMo number%' from payout_batches where id = (select id from rb)), 'riders without a MoMo number are skipped and listed');
select tests.logout();
update riders set payout_momo_number = '+233200000801', payout_momo_network = 'mtn' where id = '00000000-0000-0000-0000-000000000801';
update riders set payout_momo_number = '+233200000802', payout_momo_network = 'telecel' where id = '00000000-0000-0000-0000-000000000802';
-- C is holding overdue cash
insert into cod_collections (order_id, rider_id, city_id, amount, remit_due_by)
select (select id from orders where rider_id = '00000000-0000-0000-0000-000000000802' limit 1), '00000000-0000-0000-0000-000000000802', acc, 4000, now() - interval '1 hour' from k;
select tests.login('00000000-0000-0000-0000-000000000821');
select add_rider_adjustment('00000000-0000-0000-0000-000000000802', 'bonus', 1000, 'Weekend top performer');
create temp table rb2 as select create_rider_payout_batch() id;
grant select on rb2 to anon, authenticated, service_role;
select tests.ok((select amount = 2800 + 1600 + 500 and status = 'requested' from payouts where batch_id = (select id from rb2) and payee_id = '00000000-0000-0000-0000-000000000801')
            and tests.bal('rider', '00000000-0000-0000-0000-000000000801') = 0,
  'fleet rider: whole balance in the weekly payout');
select tests.ok((select status = 'held' and hold_reason like '%COD cash not handed in%' from payouts where batch_id = (select id from rb2) and payee_id = '00000000-0000-0000-0000-000000000802'),
  'rider with overdue COD cash: payout held');
select tests.login('00000000-0000-0000-0000-000000000820');
create temp table sent2 as select p from approve_payout_batch((select id from rb2)) p;
grant select on sent2 to anon, authenticated, service_role;
select tests.ok((select count(*) = 1 from sent2), 'only the payout not on hold is sent');
select tests.service();
select fail_payout((select (p).client_reference from sent2), 'Recipient number not registered for MoMo');
select tests.logout();
select tests.ok(tests.bal('rider', '00000000-0000-0000-0000-000000000801') > 0 and (select status = 'failed' from payouts where client_reference = (select (p).client_reference from sent2)),
  'failed transfer: money back in the rider''s earnings');
select tests.login('00000000-0000-0000-0000-000000000820');
select release_payout_hold((select id from payouts where batch_id = (select id from rb2) and payee_id = '00000000-0000-0000-0000-000000000802'), 'Rider paid the cash at hub');
select tests.logout();
select tests.ok((select status = 'requested' from payouts where batch_id = (select id from rb2) and payee_id = '00000000-0000-0000-0000-000000000802'), 'hold released; it now needs approval');

-- instant cash-out
select tests.login('00000000-0000-0000-0000-000000000801');
select tests.expect_error($$select request_rider_cashout(999999)$$, 'that much', 'cannot cash out more than earned');
create temp table co as select request_rider_cashout(1000) p;
grant select on co to anon, authenticated, service_role;
select tests.ok((select (p).amount = 800 and (p).fee = 200 and (p).status = 'requested' from co), 'GHS 10 cash-out: GHS 8 sent, GHS 2 fee, waits for approval');
select tests.expect_error($$select request_rider_cashout(1000)$$, 'already have a payout', 'one cash-out at a time');
select tests.login('00000000-0000-0000-0000-000000000802');
select tests.expect_error($$select request_rider_cashout(500)$$, 'hand in your cod', 'no cash-out while holding overdue COD');
select tests.login('00000000-0000-0000-0000-000000000820');
select approve_payout((select (p).id from co));
select tests.service();
create temp table fees0 as select tests.sys('PAYOUT_FEES') v;
grant select on fees0 to anon, authenticated, service_role;
select complete_payout((select (p).client_reference from co), 'HT-OUT-2');
select tests.logout();
select tests.ok(tests.sys('PAYOUT_FEES') = (select v from fees0) + 200, 'cash-out fee is QCS income');

-- =====================================================================
-- 5. Reconciliation & exports
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000823');
select tests.expect_error($$select cod_reconciliation(null, current_date - 7, current_date)$$, 'finance only', 'dispatcher cannot see reconciliation');
select tests.expect_error($$select accounting_export('journal', current_date, current_date)$$, 'finance only', 'nor exports');
select tests.login('00000000-0000-0000-0000-000000000820');
create temp table rec as select cod_reconciliation((select acc from k), current_date - 7, current_date) j;
grant select on rec to anon, authenticated, service_role;
select tests.ok((select (j ->> 'ledger_balanced')::boolean from rec), 'the whole ledger still adds up to zero');
select tests.ok((select (j #>> '{period,collected}')::bigint = 34000 and (j #>> '{period,handed_in_hub}')::bigint = 20000 and (j #>> '{period,handed_in_momo}')::bigint = 10000 from rec),
  'reconciliation: GHS 340 collected = 200 at hub + 100 MoMo + 40 still with a rider');
select tests.ok((select (j #>> '{now,with_riders}')::bigint = 4000 and (j #>> '{now,overdue}')::bigint = 4000 and jsonb_array_length(j -> 'riders') = 1 from rec), 'who is still holding cash');
select tests.ok((select (j ->> 'paid_to_vendors')::bigint = 20000 from rec), 'GHS 200 paid to vendors');
select tests.ok((select count(*) > 20 from accounting_export('journal', current_date - 1, current_date)), 'journal export has every ledger line');
select tests.ok((select count(*) >= 4 from accounting_export('payouts', current_date - 1, current_date)), 'payouts export');
select tests.ok((select count(*) = 5 from accounting_export('cod', current_date - 1, current_date)), 'COD export');
select tests.ok((select count(*) >= 9 from accounting_export('earnings', current_date - 1, current_date)), 'earnings export');
select tests.login('00000000-0000-0000-0000-000000000822');
select tests.ok((select j -> 'wallets' = 'null'::jsonb or j -> 'wallets' is null from (select cod_reconciliation((select acc from k), current_date - 7, current_date) j) x), 'hub manager sees their city''s COD, not QCS''s account totals');
select tests.expect_error($$select cod_reconciliation(null, current_date - 7, current_date)$$, 'finance only', 'and not all cities');
select tests.logout();
select tests.ok((select sum(balance) = 0 from wallets), 'double-entry: all wallets sum to zero');
rollback;
