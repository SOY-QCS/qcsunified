-- =====================================================================
-- Phase 13 tests: account deletion (store requirement). Ask in the app → support checks → details erased, history kept.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone, email) values
  ('00000000-0000-0000-0000-000000001601', '+233200001601', 'ama@example.com'),     -- customer with money in the wallet
  ('00000000-0000-0000-0000-000000001602', '+233200001602', null),                  -- rider
  ('00000000-0000-0000-0000-000000001603', '+233200001603', null),                  -- vendor owner
  ('00000000-0000-0000-0000-000000001610', '+233200001610', 'support16@qcsghana.com'),
  ('00000000-0000-0000-0000-000000001611', '+233200001611', 'disp16@qcsghana.com');
update profiles set full_name = 'Ama Owusu', email = 'ama@example.com', marketing_opt_in = true where id = '00000000-0000-0000-0000-000000001601';
insert into user_roles (user_id, role) values ('00000000-0000-0000-0000-000000001610', 'support');
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001611', 'dispatcher', id from cities where code = 'ACC';
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000001602', 'bike', 'GR-1602');
insert into riders (id, rider_type, status, city_id, vehicle_id, cod_float_balance, payout_momo_number) select '00000000-0000-0000-0000-000000001602', 'fleet', 'active', id,
  '50000000-0000-0000-0000-000000001602', 5000, '+233200001602' from cities where code = 'ACC';
insert into vendors (owner_id, business_name, city_id) select '00000000-0000-0000-0000-000000001603', 'Ama''s Kitchen', id from cities where code = 'ACC';
insert into addresses (user_id, label, formatted_address, location) values
  ('00000000-0000-0000-0000-000000001601', 'Home', '12 Lagos Ave', st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography);
insert into push_tokens (token, user_id, app) values ('ExponentPushToken[ama]', '00000000-0000-0000-0000-000000001601', 'client');
insert into device_logins (device_id, user_id, app) values ('a8f3c2d1e9b07766', '00000000-0000-0000-0000-000000001601', 'client');
-- an old delivery: must survive the deletion
insert into orders (id, service_type, city_id, customer_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method, status)
select '20000000-0000-0000-0000-000000001601', 'express', id, '00000000-0000-0000-0000-000000001601', st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography,
       st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography, 'Esi', '+233240001601', 1000, 2500, 'sender', 'cash', 'DELIVERED' from cities where code = 'ACC';
-- GHS 12.50 in Ama's wallet (through the ledger, as always)
select public._ledger('topup', 'test top-up', jsonb_build_array(
  jsonb_build_object('wallet_id', public.wallet_for('customer', '00000000-0000-0000-0000-000000001601'), 'amount', 1250),
  jsonb_build_object('wallet_id', public.sys_wallet('HUBTEL_CLEARING'), 'amount', -1250)), null, null, null);

-- =====================================================================
-- 1. Asking (in the app)
-- =====================================================================
select tests.login(null);
select tests.expect_error($$select public.request_account_deletion()$$, 'permission denied', 'visitors cannot');
select tests.login('00000000-0000-0000-0000-000000001601');
select tests.ok((public.request_account_deletion('Moving abroad') -> 'blockers' ->> 0) like 'GHS 12.50 is still in the wallet%', 'the app tells Ama what to settle first');
select tests.ok((public.request_account_deletion() ->> 'status') = 'pending' and (select count(*) from account_deletions) = 1, 'asking twice keeps one request');
select tests.ok((public.my_account_deletion() ->> 'status') = 'pending', 'the app can show the request');
select public.cancel_account_deletion();
select tests.ok(public.my_account_deletion() is null, 'she can change her mind');
select public.request_account_deletion('Moving abroad');
select tests.login('00000000-0000-0000-0000-000000001602');
select tests.ok((public.request_account_deletion() -> 'blockers' ->> 0) = 'GHS 50.00 of COD cash is still to be handed in.', 'rider: COD cash first');
select tests.login('00000000-0000-0000-0000-000000001603');
select tests.ok((public.request_account_deletion() -> 'blockers' ->> 0) like 'You own the business account "Ama''s Kitchen"%', 'vendor owner: the business account is closed with support');
select tests.ok((select count(*) from account_deletions) = 1, 'people see only their own request');

-- =====================================================================
-- 2. Support processes it
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001611');
select tests.ok(public.account_deletion_list() = '[]'::jsonb, 'a dispatcher does not see the list');
select tests.expect_error(format('select public.process_account_deletion(%L, null)', (select id from account_deletions where user_id = '00000000-0000-0000-0000-000000001601' and status = 'pending')),
                          'only support', 'a dispatcher cannot delete accounts');
select tests.expect_error($$select public.staff_request_account_deletion('0200001601', 'WhatsApp')$$, 'only support', 'a dispatcher cannot log requests');
select tests.login('00000000-0000-0000-0000-000000001610');
select tests.expect_error($$select public.staff_request_account_deletion('0200001699', 'WhatsApp')$$, 'no account', 'unknown number refused');
select tests.ok(public.staff_request_account_deletion('020 000 1603', 'WhatsApp from registered number') = (select id from account_deletions where user_id = '00000000-0000-0000-0000-000000001603'),
                'support logs a WhatsApp request by phone: joins the existing one');
select tests.ok(jsonb_array_length(public.account_deletion_list()) = 3 and (public.account_deletion_list() -> 0 ->> 'days_left')::int = 30, 'support sees 3 requests, 30 days to act');
select tests.expect_error(format('select public.process_account_deletion(%L, null)', (select id from account_deletions where user_id = '00000000-0000-0000-0000-000000001601' and status = 'pending')),
                          'settle these first', 'cannot delete while money is in the wallet');
-- Ama withdraws her money (as a wallet refund would)
select tests.logout();
select public._ledger('withdrawal', 'test withdrawal', jsonb_build_array(
  jsonb_build_object('wallet_id', public.wallet_for('customer', '00000000-0000-0000-0000-000000001601'), 'amount', -1250),
  jsonb_build_object('wallet_id', public.sys_wallet('HUBTEL_CLEARING'), 'amount', 1250)), null, null, null);
select tests.login('00000000-0000-0000-0000-000000001610');
select tests.ok(public.process_account_deletion((select id from account_deletions where user_id = '00000000-0000-0000-0000-000000001601' and status = 'pending'), 'Wallet empty, no open orders.')
                = '00000000-0000-0000-0000-000000001601', 'support deletes it');
select tests.logout();
select tests.ok((select full_name = 'Deleted account' and phone is null and email is null and not is_active and not marketing_opt_in from profiles where id = '00000000-0000-0000-0000-000000001601'),
                'name, phone and email erased');
select tests.ok(not exists (select 1 from addresses where user_id = '00000000-0000-0000-0000-000000001601')
                and not exists (select 1 from push_tokens where user_id = '00000000-0000-0000-0000-000000001601')
                and not exists (select 1 from device_logins where user_id = '00000000-0000-0000-0000-000000001601')
                and not exists (select 1 from user_roles where user_id = '00000000-0000-0000-0000-000000001601'), 'addresses, phone records and roles removed');
select tests.ok(exists (select 1 from orders where id = '20000000-0000-0000-0000-000000001601' and customer_id = '00000000-0000-0000-0000-000000001601'), 'order history kept (without her details)');
select tests.ok((select status = 'done' and processed_by = '00000000-0000-0000-0000-000000001610' from account_deletions where user_id = '00000000-0000-0000-0000-000000001601' and status = 'done'),
                'request closed with who did it');
select tests.ok(exists (select 1 from audit_log where table_name = 'account_deletions' and reason = 'Wallet empty, no open orders.'), 'in the audit log');
-- until the dashboard confirms the login is removed, the request stays on the list (so a failed removal can be retried)
select tests.login('00000000-0000-0000-0000-000000001610');
select tests.ok((select x ->> 'stage' from jsonb_array_elements(public.account_deletion_list()) x where x ->> 'user_id' = '00000000-0000-0000-0000-000000001601') = 'login',
                'erased but login not yet removed: still listed');
select tests.ok(public.mark_login_removed((select id from account_deletions where user_id = '00000000-0000-0000-0000-000000001601' and status = 'done')) = '00000000-0000-0000-0000-000000001601', 'login removal recorded');
select tests.ok(not exists (select 1 from jsonb_array_elements(public.account_deletion_list()) x where x ->> 'user_id' = '00000000-0000-0000-0000-000000001601'), 'then it leaves the list');
select tests.logout();

rollback;
