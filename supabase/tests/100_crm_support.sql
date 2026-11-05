-- =====================================================================
-- Phase 10 tests: support tickets + SLA, WhatsApp inbox, 360 profiles, leads, churn alerts,
-- segments + campaigns (opt-in only, unsubscribe), help centre, customer service for vendors.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000001001', '+233200001001'),  -- C1: customer (opted in to offers)
  ('00000000-0000-0000-0000-000000001002', '+233200001002'),  -- C2: another customer (not opted in)
  ('00000000-0000-0000-0000-000000001010', '+233200001010'),  -- V: vendor owner
  ('00000000-0000-0000-0000-000000001011', '+233200001011'),  -- other vendor owner
  ('00000000-0000-0000-0000-000000001020', '+233200001020'),  -- S: support agent, Accra
  ('00000000-0000-0000-0000-000000001021', '+233200001021'),  -- A: city admin, Accra
  ('00000000-0000-0000-0000-000000001022', '+233200001022'),  -- K: support agent, Kumasi
  ('00000000-0000-0000-0000-000000001030', '+233200001030');  -- R: rider
create temp table k as select (select id from cities where code = 'ACC') acc, (select id from cities where code = 'KSI') ksi;
grant select on k to anon, authenticated, service_role;
update profiles set full_name = 'Ama Customer', city_id = (select acc from k), marketing_opt_in = true, email = 'ama@example.com' where id = '00000000-0000-0000-0000-000000001001';
update profiles set full_name = 'Kojo Other', city_id = (select acc from k) where id = '00000000-0000-0000-0000-000000001002';
update profiles set full_name = 'Efua Vendor', city_id = (select acc from k), marketing_opt_in = true where id = '00000000-0000-0000-0000-000000001010';
update profiles set full_name = 'Sena Support', city_id = (select acc from k) where id = '00000000-0000-0000-0000-000000001020';
update profiles set full_name = 'Rider Rex', city_id = (select acc from k) where id = '00000000-0000-0000-0000-000000001030';
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001020', 'support', acc from k;
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001021', 'city_admin', acc from k;
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001022', 'support', ksi from k;
insert into vendors (id, owner_id, business_name, city_id, contact_phone) select '10000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001010', 'Adinkra Beauty', acc, '+233200001010' from k;
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-000000001011', 'Other Shop', acc from k;
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000001001', 'bike', 'GR-1001');
insert into riders (id, rider_type, status, city_id, vehicle_id) select '00000000-0000-0000-0000-000000001030', 'fleet', 'active', acc, '50000000-0000-0000-0000-000000001001' from k;

-- orders straight in the database (status history isn't the point here)
create function tests.order10(p_id uuid, p_customer uuid, p_vendor uuid, p_status text, p_at timestamptz default now(), p_rider uuid default null)
returns void language plpgsql as $$
begin
  insert into orders (id, service_type, city_id, customer_id, vendor_id, rider_id, pickup_location, dropoff_location, recipient_name, recipient_phone,
                      weight_g, quoted_fee, payer, payment_method, status, created_at)
  select p_id, case when p_vendor is null then 'express' else 'ecommerce' end::service_type, acc, p_customer, p_vendor, p_rider,
         st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography, st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography,
         'Esi Mensah', '+233243334444', 1000, 2500, case when p_vendor is null then 'sender' else 'vendor_wallet' end::payer_type,
         case when p_vendor is null then 'momo' else 'wallet' end::payment_method, p_status::order_status, p_at
  from k;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;
select tests.order10('30000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001001', null, 'IN_TRANSIT', now(), '00000000-0000-0000-0000-000000001030');
select tests.order10('30000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-000000001002', null, 'DELIVERED');
select tests.order10('30000000-0000-0000-0000-000000001003', '00000000-0000-0000-0000-000000001010', '10000000-0000-0000-0000-000000001001', 'IN_TRANSIT');
create temp table tn as select (select tracking_number from orders where id = '30000000-0000-0000-0000-000000001001') o1,
  (select tracking_number from orders where id = '30000000-0000-0000-0000-000000001002') o2,
  (select tracking_number from orders where id = '30000000-0000-0000-0000-000000001003') o3;
grant select on tn to anon, authenticated, service_role;

-- =====================================================================
-- 1. Working-hours clock (Mon–Sat 8am–6pm Accra)
-- =====================================================================
select tests.ok(_work_add('2026-11-06 17:30+00', 60) = '2026-11-07 08:30+00', 'Friday 5:30pm + 1 working hour = Saturday 8:30am');
select tests.ok(_work_add('2026-11-07 17:30+00', 60) = '2026-11-09 08:30+00', 'Saturday 5:30pm + 1 working hour = Monday 8:30am (Sunday off)');
select tests.ok(_work_add('2026-11-06 10:00+00', 24 * 60) = '2026-11-09 14:00+00', '24 working hours from Friday 10am = Monday 2pm');
select tests.ok(_work_add('2026-11-08 12:00+00', 30) = '2026-11-09 08:30+00', 'ticket on a Sunday: clock starts Monday 8am');

-- =====================================================================
-- 2. "Report a problem" on an order
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001001');
select tests.expect_error($$select open_ticket('damaged', 'It is broken', (select o2 from tn))$$, 'couldn''t find', 'cannot report a problem on someone else''s delivery');
select tests.expect_error($$select open_ticket('weird', 'Something odd happened')$$, 'choose what', 'category must be one we know');
select tests.expect_error($$select open_ticket('delay', 'hi')$$, 'tell us', 'needs a few words');
create temp table t1 as select (open_ticket('damaged', 'The box arrived crushed and the bottle is broken', (select o1 from tn))->>'id')::uuid id;
grant select on t1 to anon, authenticated, service_role;
select tests.ok((select priority = 'urgent' and category = 'damaged' and opened_as = 'client' and channel = 'app'
                        and order_id = '30000000-0000-0000-0000-000000001001' and status = 'open' from tickets where id = (select id from t1)),
                'damaged-parcel report is an urgent ticket linked to the order');
select tests.ok((select first_response_due > now() and resolution_due > first_response_due from tickets where id = (select id from t1)), 'SLA due times set');
select tests.ok((select count(*) from ticket_messages where ticket_id = (select id from t1)) = 1, 'customer sees their message');
select tests.ok((open_ticket('damaged', 'Also the lid is missing', (select o1 from tn)) ->> 'existing')::boolean, 'same problem again: added to the open ticket, no duplicate');
select tests.ok((select count(*) from tickets where order_id = '30000000-0000-0000-0000-000000001001') = 1, 'still one ticket');
select tests.logout();
select tests.ok(exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000001020' and template = 'ticket_new'), 'Accra support agent alerted');
select tests.ok(exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000001021' and template = 'ticket_new'), 'urgent: city admin alerted too');
select tests.ok(not exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000001022' and template = 'ticket_new'), 'Kumasi support not alerted for an Accra ticket');
select tests.ok(exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000001001' and template = 'ticket_received'), 'customer gets "we got your message"');

-- privacy
select tests.login('00000000-0000-0000-0000-000000001002');
select tests.ok((select count(*) from tickets) = 0, 'another customer sees no tickets');
select tests.expect_error($$select reply_ticket((select id from t1), 'me too')$$, 'not your ticket', 'and cannot reply to it');
select tests.login('00000000-0000-0000-0000-000000001022');
select tests.ok((select count(*) from tickets where id = (select id from t1)) = 0, 'Kumasi support does not see Accra tickets');

-- support works the ticket
select tests.login('00000000-0000-0000-0000-000000001020');
select tests.ok((select count(*) from tickets where id = (select id from t1)) = 1, 'Accra support sees it');
select reply_ticket((select id from t1), 'Rider says the box was dropped. Checking.', true);
select tests.ok((select first_responded_at is null and status = 'open' from tickets where id = (select id from t1)), 'an internal note is not a reply to the customer');
select reply_ticket((select id from t1), 'We are sorry. Please send photos so we can open a claim.');
select tests.ok((select first_responded_at is not null and status = 'pending' and assigned_to = '00000000-0000-0000-0000-000000001020' from tickets where id = (select id from t1)),
                'staff reply: first reply recorded, waiting on customer, assigned to the agent');
select tests.ok(ticket_sla_state((select t from tickets t where id = (select id from t1))) = 'waiting_customer', 'SLA state: waiting for customer');
select tests.logout();
select tests.ok(exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000001001' and template = 'ticket_reply' and payload ->> 'message' like 'We are sorry%'),
                'customer notified of the reply');
select tests.login('00000000-0000-0000-0000-000000001001');
select tests.ok((select count(*) from ticket_messages where ticket_id = (select id from t1)) = 3, 'customer sees 3 messages (not the internal note)');
select tests.ok(not exists (select 1 from ticket_messages where is_internal), 'internal notes are hidden from customers');
select tests.expect_error($$select reply_ticket((select id from t1), 'x', true)$$, 'only staff', 'customers cannot write internal notes');
select tests.expect_error($$select update_ticket((select id from t1), '{"status":"closed"}')$$, 'only support', 'customers cannot change ticket status');
select tests.expect_error($$insert into tickets (channel, subject) values ('app', 'sneaky')$$, 'row-level security', 'tickets cannot be written directly');
select reply_ticket((select id from t1), 'Here are the photos', false, '00000000-0000-0000-0000-000000001001/box.jpg');
select tests.ok((select status = 'open' from tickets where id = (select id from t1)), 'customer answer puts it back in the queue');
select tests.logout();
select tests.ok(exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000001020' and template = 'ticket_customer_reply'), 'assigned agent told the customer replied');

select tests.login('00000000-0000-0000-0000-000000001020');
select tests.expect_error($$select update_ticket((select id from t1), '{"assigned_to":"00000000-0000-0000-0000-000000001001"}')$$, 'staff member', 'cannot assign a ticket to a customer');
select update_ticket((select id from t1), '{"assigned_to":"00000000-0000-0000-0000-000000001021","reason":"needs a claim decision"}');
select reply_ticket((select id from t1), 'Claim approved: refund to your wallet today.', false, null, true);
select tests.ok((select status = 'resolved' and resolved_at is not null from tickets where id = (select id from t1)), 'reply and resolve in one step');
select tests.logout();
select tests.ok(exists (select 1 from audit_log where table_name = 'tickets' and record_id = (select id::text from t1) and reason = 'needs a claim decision'), 'reassignment in the audit log with the reason');

-- a customer can reopen a resolved ticket by replying
select tests.login('00000000-0000-0000-0000-000000001001');
select reply_ticket((select id from t1), 'The refund has not arrived');
select tests.ok((select status = 'open' and resolved_at is null from tickets where id = (select id from t1)), 'reply reopens a resolved ticket');
create temp table t2 as select (open_ticket('account', 'How do I change my phone number?') ->> 'id')::uuid id;
grant select on t2 to anon, authenticated, service_role;
select tests.ok((select order_id is null and priority = 'normal' from tickets where id = (select id from t2)), 'general question without an order: normal priority');

-- vendor and rider reports
select tests.login('00000000-0000-0000-0000-000000001010');
create temp table t3 as select (open_ticket('cod_money', 'COD for this order was not paid out', (select o3 from tn)) ->> 'id')::uuid id;
grant select on t3 to anon, authenticated, service_role;
select tests.ok((select opened_as = 'vendor' and vendor_id = '10000000-0000-0000-0000-000000001001' and priority = 'urgent' from tickets where id = (select id from t3)),
                'vendor report on their order: vendor ticket, COD money = urgent');
select tests.login('00000000-0000-0000-0000-000000001030');
create temp table t4 as select (open_ticket('address', 'Recipient gave a wrong landmark', (select o1 from tn)) ->> 'id')::uuid id;
grant select on t4 to anon, authenticated, service_role;
select tests.ok((select opened_as = 'rider' and vendor_id is null from tickets where id = (select id from t4)), 'rider report on their job: rider ticket');
select tests.login('00000000-0000-0000-0000-000000001001');
select tests.ok(not exists (select 1 from tickets where id = (select id from t4)), 'customer does not see the rider''s report');

-- staff log a phone call
select tests.login('00000000-0000-0000-0000-000000001020');
create temp table t5 as select staff_open_ticket(jsonb_build_object('phone', '0200001002', 'tracking_number', (select o2 from tn), 'category', 'delay',
  'body', 'Called to ask why delivery took 3 hours', 'channel', 'phone')) id;
grant select on t5 to anon, authenticated, service_role;
select tests.ok((select customer_id = '00000000-0000-0000-0000-000000001002' and channel = 'phone' and assigned_to = '00000000-0000-0000-0000-000000001020'
                        and order_id = '30000000-0000-0000-0000-000000001002' from tickets where id = (select id from t5)),
                'phone call logged: matched to the customer by phone, assigned to the agent');
select tests.logout();

-- =====================================================================
-- 3. SLA timers
-- =====================================================================
update tickets set first_response_due = now() - interval '5 minutes' where id = (select id from t2);
update tickets set resolution_due = now() - interval '1 minute' where id = (select id from t1);
select tests.ok(ticket_sla_state((select t from tickets t where id = (select id from t2))) = 'reply_overdue', 'SLA state: reply overdue');
select tests.ok((ticket_sla_tick() ->> 'alerts')::int = 2, 'SLA watcher raises 2 alerts');
select tests.ok((ticket_sla_tick() ->> 'alerts')::int = 0, 'and does not repeat them');
select tests.ok(exists (select 1 from notifications where template = 'ticket_sla' and user_id = '00000000-0000-0000-0000-000000001021' and payload ->> 'what' = 'Resolution'),
                'resolution breach goes to the assigned person');
update tickets set status = 'resolved', resolved_at = now() - interval '8 days' where id = (select id from t5);
select ticket_sla_tick();
select tests.ok((select status = 'closed' from tickets where id = (select id from t5)), 'resolved tickets close after 7 days');
select tests.login('00000000-0000-0000-0000-000000001002');
select tests.expect_error($$select reply_ticket((select id from t5), 'hello?')$$, 'closed', 'closed ticket cannot be replied to');
select tests.login('00000000-0000-0000-0000-000000001020');
select tests.ok((select (support_overview((select acc from k)) ->> 'urgent_open')::int) = 2, 'support overview counts urgent tickets');
select tests.logout();

-- =====================================================================
-- 4. WhatsApp inbox
-- =====================================================================
select tests.service();
create temp table wa as select handle_whatsapp_message('wamid.1', '233551234567', 'Hello my parcel ' || (select o3 from tn) || ' is damaged, the box is wet', 'Yaa Asantewaa') r;
grant select on wa to anon, authenticated, service_role;
select tests.ok((select r like 'Thanks for contacting QCS. Your ticket number is #%' from wa), 'first message: auto-reply with the ticket number');
create temp table t6 as select id from tickets where requester_phone = '+233551234567';
grant select on t6 to anon, authenticated, service_role;
select tests.ok((select channel = 'whatsapp' and category = 'damaged' and priority = 'urgent' and opened_as = 'public' and requester_name = 'Yaa Asantewaa'
                        and order_id = '30000000-0000-0000-0000-000000001003' from tickets where id = (select id from t6)),
                'WhatsApp message became an urgent ticket, linked to the order in the text');
select tests.ok(handle_whatsapp_message('wamid.2', '233551234567', 'Please call me', null, '{"kind":"image","path":"wa/wamid.2.jpg"}') is null,
                'follow-up message: no auto-reply');
select tests.ok((select count(*) from ticket_messages where ticket_id = (select id from t6)) = 2, 'follow-up added to the same ticket');
select tests.ok((select attachment_path from ticket_messages where ticket_id = (select id from t6) order by id desc limit 1) = 'wa/wamid.2.jpg', 'photo kept with the message');
select tests.ok(handle_whatsapp_message('wamid.2', '233551234567', 'Please call me') is null
                and (select count(*) from ticket_messages where ticket_id = (select id from t6)) = 2, 'Meta retry of the same message is ignored');
select tests.logout();
select tests.login('00000000-0000-0000-0000-000000001020');
select reply_ticket((select id from t6), 'Hello Yaa, we are checking with the vendor now.');
select tests.logout();
select tests.ok((select channel = 'whatsapp' and to_address = '+233551234567' and (payload ->> 'wa_text')::boolean from notifications
                  where template = 'ticket_reply_wa' and payload ->> 'message' like 'Hello Yaa%'), 'reply goes back on WhatsApp as free text (inside 24 h)');
update tickets set last_customer_at = now() - interval '2 days' where id = (select id from t6);
select tests.login('00000000-0000-0000-0000-000000001020');
select reply_ticket((select id from t6), 'Any update?');
select tests.logout();
select tests.ok((select not (payload ->> 'wa_text')::boolean from notifications where template = 'ticket_reply_wa' and payload ->> 'message' = 'Any update?'),
                'after 24 h the approved reply template is used');
select tests.service();
select tests.ok(handle_whatsapp_message('wamid.3', '233200001001', 'STOP') like 'You won''t receive QCS offers%', 'STOP: opt out of offers');
select tests.logout();
select tests.ok(not (select marketing_opt_in from profiles where id = '00000000-0000-0000-0000-000000001001'), 'customer opted out');
select tests.service();
select handle_whatsapp_message('wamid.4', '233200001001', 'START');
select tests.logout();
select tests.ok((select marketing_opt_in from profiles where id = '00000000-0000-0000-0000-000000001001'), 'START: opted back in');
select tests.service();
select handle_whatsapp_message('wamid.5', '233200001030', 'DELIVERED ACC-000000000000-ACC 1234');
select tests.logout();
select tests.ok(not exists (select 1 from tickets where requester_phone = '+233200001030' and channel = 'whatsapp'), 'rider DELIVERED command is not turned into a ticket');
select tests.login('00000000-0000-0000-0000-000000001001');
select tests.expect_error($$select handle_whatsapp_message('x', '1', 'hi')$$, 'permission denied', 'apps cannot fake WhatsApp messages');
select tests.logout();

-- =====================================================================
-- 5. 360 profiles
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001020');
select tests.ok((select (c ->> 'orders')::int = 1 and (c ->> 'tickets_total')::int = 2 from (select customer_360('00000000-0000-0000-0000-000000001001') c) x),
                'customer 360: orders and tickets');
select set_crm_profile('customer', '00000000-0000-0000-0000-000000001001', array['VIP', ' vip ', 'Osu'], '00000000-0000-0000-0000-000000001020');
select tests.ok((select tags = array['osu', 'vip'] or tags = array['vip', 'osu'] from customer_crm where user_id = '00000000-0000-0000-0000-000000001001'), 'tags cleaned and de-duplicated');
select add_crm_note('customer', '00000000-0000-0000-0000-000000001001', 'Prefers WhatsApp, calls after 5pm');
select set_crm_profile('vendor', '10000000-0000-0000-0000-000000001001', array['beauty'], '00000000-0000-0000-0000-000000001020');
select tests.ok((select account_manager_id = '00000000-0000-0000-0000-000000001020' and tags = array['beauty'] from vendors where id = '10000000-0000-0000-0000-000000001001'),
                'vendor tags + account manager saved');
select tests.ok((select (vendor_stats('10000000-0000-0000-0000-000000001001') ->> 'complaints_90d')::int) = 2, 'vendor 360 counts complaints (vendor''s own + WhatsApp one about their order)');
select tests.expect_error($$select set_crm_profile('vendor', '10000000-0000-0000-0000-000000001001', null, '00000000-0000-0000-0000-000000001001')$$, 'must be staff', 'account manager must be staff');
select tests.login('00000000-0000-0000-0000-000000001001');
select tests.expect_error($$select customer_360('00000000-0000-0000-0000-000000001001')$$, 'staff only', 'customers cannot see 360 profiles');
select tests.ok((select count(*) from crm_notes) = 0, 'or CRM notes');
select tests.logout();
select tests.ok(exists (select 1 from audit_log where table_name = 'vendors' and reason = 'CRM profile'), 'vendor CRM change audited');

-- =====================================================================
-- 6. Leads pipeline
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001020');
create temp table l1 as select save_lead(null, jsonb_build_object('business_name', 'Kumi Sneakers', 'phone', '0244556677', 'city_id', (select acc from k),
  'source', 'instagram', 'expected_weekly', 40, 'next_action', 'Call Monday', 'next_action_at', current_date)) id;
grant select on l1 to anon, authenticated, service_role;
select tests.ok((select phone = '+233244556677' and stage = 'new' and owner_id = '00000000-0000-0000-0000-000000001020' from leads where id = (select id from l1)), 'lead saved, phone tidied');
select tests.expect_error($$select save_lead(null, jsonb_build_object('business_name', 'Kumi Again', 'phone', '+233 24 455 6677', 'city_id', (select acc from k)))$$,
                          'already exists', 'duplicate lead refused');
select move_lead((select id from l1), 'contacted', 'Spoke to Kumi, sending samples');
select tests.expect_error($$select move_lead((select id from l1), 'active')$$, 'signed up', 'cannot be Active before signing up');
select tests.expect_error($$select move_lead((select id from l1), 'lost')$$, 'why', 'lost needs a reason');
select tests.ok((select count(*) from crm_notes where lead_id = (select id from l1)) = 1, 'stage change kept on the lead timeline');
select tests.ok((select (support_overview((select acc from k)) ->> 'leads_follow_up_due')::int) = 1, 'follow-up due today counted');
select tests.login('00000000-0000-0000-0000-000000001022');
select tests.ok((select count(*) from leads) = 0, 'Kumasi staff do not see Accra leads');
select tests.expect_error($$select move_lead((select id from l1), 'trial')$$, 'only support', 'nor move them');
select tests.logout();
-- the shop signs up with the same phone → linked and moved to Trial automatically
insert into auth.users (id, phone) values ('00000000-0000-0000-0000-000000001012', '+233244556677');
insert into vendors (id, owner_id, business_name, city_id, contact_phone) select '10000000-0000-0000-0000-000000001003', '00000000-0000-0000-0000-000000001012', 'Kumi Sneakers Ltd', acc, '0244556677' from k;
select tests.ok((select vendor_id = '10000000-0000-0000-0000-000000001003' and stage = 'trial' from leads where id = (select id from l1)), 'sign-up links the lead and moves it to Trial');
select tests.ok((select crm_stage = 'trial' and account_manager_id = '00000000-0000-0000-0000-000000001020' from vendors where id = '10000000-0000-0000-0000-000000001003'),
                'new vendor gets the lead''s account manager');

-- =====================================================================
-- 7. Churn alerts (daily)
-- =====================================================================
-- Adinkra Beauty: 10 a week for the previous 4 weeks, 2 this week (80% down)
select tests.order10(gen_random_uuid(), '00000000-0000-0000-0000-000000001010', '10000000-0000-0000-0000-000000001001', 'DELIVERED', now() - make_interval(days => 8 + (i % 27)))
from generate_series(1, 40) i;
select tests.order10(gen_random_uuid(), '00000000-0000-0000-0000-000000001010', '10000000-0000-0000-0000-000000001001', 'DELIVERED', now() - interval '1 day') from generate_series(1, 1);
-- Other Shop: tiny volume (1 a week) — below the minimum, never flagged
select tests.order10(gen_random_uuid(), '00000000-0000-0000-0000-000000001011', '10000000-0000-0000-0000-000000001002', 'DELIVERED', now() - make_interval(days => 8 + i * 6))
from generate_series(1, 4) i;
update vendors set crm_stage = 'active' where id in ('10000000-0000-0000-0000-000000001001', '10000000-0000-0000-0000-000000001002');
select tests.ok((crm_daily() ->> 'flagged')::int = 1, 'one vendor flagged');
select tests.ok((select this_week = 2 and weekly_avg = 10 and drop_percent = 80 from crm_alerts where vendor_id = '10000000-0000-0000-0000-000000001001'),
                'alert: 2 this week vs 10 a week before, 80% down');
select tests.ok((select crm_stage = 'churn_risk' from vendors where id = '10000000-0000-0000-0000-000000001001'), 'vendor moved to Churn risk');
select tests.ok((select crm_stage = 'active' from vendors where id = '10000000-0000-0000-0000-000000001002'), 'small vendor not flagged');
select tests.ok(exists (select 1 from notifications where template = 'churn_alert' and user_id = '00000000-0000-0000-0000-000000001020'), 'account manager alerted');
select tests.ok((crm_daily() ->> 'flagged')::int = 0, 'running again the same week does not repeat the alert');
select tests.login('00000000-0000-0000-0000-000000001020');
select tests.expect_error($$select handle_crm_alert((select id from crm_alerts limit 1), 'ok')$$, 'write what you did', 'handling an alert needs a note');
select handle_crm_alert((select id from crm_alerts limit 1), 'Called Efua: supplier delay, back next week');
select tests.ok((select status = 'done' from crm_alerts limit 1) and exists (select 1 from crm_notes where body like 'Churn alert handled:%'), 'alert handled, note on the vendor timeline');
select tests.logout();
-- recovery: volume back up → back to Active
select tests.order10(gen_random_uuid(), '00000000-0000-0000-0000-000000001010', '10000000-0000-0000-0000-000000001001', 'DELIVERED', now() - interval '2 hours') from generate_series(1, 9);
select crm_daily();
select tests.ok((select crm_stage = 'active' from vendors where id = '10000000-0000-0000-0000-000000001001'), 'volume recovered: back to Active');
-- trial vendor becomes active after 5 deliveries; its lead follows
select tests.order10(gen_random_uuid(), '00000000-0000-0000-0000-000000001012', '10000000-0000-0000-0000-000000001003', 'DELIVERED', now() - interval '1 hour') from generate_series(1, 5);
select crm_daily();
select tests.ok((select crm_stage = 'active' from vendors where id = '10000000-0000-0000-0000-000000001003')
                and (select stage = 'active' from leads where id = (select id from l1)), 'trial → active after 5 deliveries, lead follows');

-- =====================================================================
-- 8. Segments & campaigns
-- =====================================================================
insert into push_tokens (user_id, token, app, platform) values ('00000000-0000-0000-0000-000000001001', 'ExponentPushToken[ama]', 'client', 'android');
select tests.login('00000000-0000-0000-0000-000000001020');
select tests.ok((select (p ->> 'people')::int = 1 and (p ->> 'push')::int = 1 and (p ->> 'email')::int = 1
                 from (select segment_preview('customers', '{}', (select acc from k)) p) x), 'customer segment: only the opted-in customer (Kojo never opted in)');
select tests.ok((select (segment_preview('customers', '{"inactive_days": 30}', (select acc from k)) ->> 'people')::int) = 0, 'filter: inactive 30 days excludes a recent customer');
select tests.ok((select (segment_preview('vendors', '{"tags":["beauty"]}', (select acc from k)) ->> 'people')::int) = 1, 'vendor segment by tag');
select tests.expect_error($$select segment_members('customers', '{}', null)$$, 'permission denied', 'member lists (phone numbers) are not exposed to the apps');
create temp table seg as select save_segment(null, 'Accra customers', 'customers', '{}', (select acc from k)) id;
grant select on seg to anon, authenticated, service_role;
select tests.expect_error($$select save_campaign(null, jsonb_build_object('segment_id', (select id from seg), 'channels', '["whatsapp"]'::jsonb, 'message', 'GHS 20 off this week'))$$,
                          'template', 'WhatsApp offers need an approved template');
create temp table camp as select save_campaign(null, jsonb_build_object('name', 'Weekend promo', 'segment_id', (select id from seg), 'channels', '["push","sms"]'::jsonb,
  'title', 'Weekend offer', 'message', 'GHS 20 off Express this weekend with code WKND20')) id;
grant select on camp to anon, authenticated, service_role;
select tests.expect_error($$select schedule_campaign((select id from camp))$$, 'only an admin', 'support prepares, but cannot send');
select tests.login('00000000-0000-0000-0000-000000001021');
select schedule_campaign((select id from camp));
select tests.logout();
select campaign_tick();
select tests.ok((select status = 'sending' and recipients = 1 and messages = 2 from campaigns where id = (select id from camp)), 'campaign sent to 1 person on 2 channels');
select tests.ok((select payload ->> 'unsubscribe_url' like '%/u/%' from notifications where template = 'broadcast' and channel = 'sms'), 'SMS carries an unsubscribe link');
select campaign_tick();
select tests.ok((select status = 'sent' and messages = 2 from campaigns where id = (select id from camp)), 'next run: finished, nobody messaged twice');
select tests.ok(not exists (select 1 from notifications where template = 'broadcast' and user_id = '00000000-0000-0000-0000-000000001002'), 'not-opted-in customer got nothing');
-- opt out between queueing and sending → skipped
create temp table tok as select unsubscribe_token t from profiles where id = '00000000-0000-0000-0000-000000001001';
grant select on tok to anon, authenticated, service_role;
select tests.login(null);
select tests.ok((unsubscribe((select t from tok)) ->> 'ok')::boolean, 'unsubscribe link works without logging in');
select tests.ok(not (unsubscribe('nope') ->> 'ok')::boolean, 'bad link does nothing');
select tests.logout();
select tests.service();
select count(*) from claim_notifications(500);
select tests.logout();
select tests.ok((select status = 'skipped' and error = 'opted out' from notifications where template = 'broadcast' and channel = 'sms'), 'offer not sent after opting out');
select tests.ok(exists (select 1 from audit_log where table_name = 'campaigns' and after ->> 'status' = 'scheduled'), 'campaign approval audited');

-- =====================================================================
-- 9. Help centre
-- =====================================================================
select tests.login(null);
select tests.ok((select count(*) from help_articles) >= 10, 'help articles are public');
select tests.expect_error($$insert into help_articles (slug, audience, category, title, body) values ('hack', 'all', 'x', 'x', 'x')$$, 'row-level security', 'public cannot write help');
select tests.logout();
update help_articles set published = false where slug = 'cod';
select tests.login(null);
select tests.ok(not exists (select 1 from help_articles where slug = 'cod'), 'unpublished article hidden');
select tests.login('00000000-0000-0000-0000-000000001020');
select tests.ok(exists (select 1 from help_articles where slug = 'cod'), 'support sees drafts');
update help_articles set title = 'How COD works', published = true where slug = 'cod';
select tests.ok((select title = 'How COD works' from help_articles where slug = 'cod'), 'support edits articles');
select tests.logout();

-- =====================================================================
-- 10. Customer service for vendors (§11)
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001020');
select tests.expect_error($$select log_contact('30000000-0000-0000-0000-000000001003', 'call', 'confirmed')$$, 'has not bought', 'only for vendors who bought the service');
select tests.logout();
update vendors set cs_service_enabled = true where id = '10000000-0000-0000-0000-000000001001';
select tests.login('00000000-0000-0000-0000-000000001020');
select log_contact('30000000-0000-0000-0000-000000001003', 'call', 'confirmed', 'Customer confirmed address and time');
select cs_message('30000000-0000-0000-0000-000000001003', 'Your Adinkra Beauty order arrives this afternoon.');
select tests.logout();
select tests.ok((select to_address = '+233243334444' and payload ->> 'vendor_name' = 'Adinkra Beauty' from notifications where template = 'cs_message' limit 1),
                'message to the vendor''s customer "on behalf of" the vendor');
select tests.ok((select body like 'QCS on behalf of {{vendor_name}}%' from notification_templates where key = 'cs_message' and channel = 'sms'), 'worded "QCS on behalf of <vendor>"');
select tests.login('00000000-0000-0000-0000-000000001010');
select tests.ok((select count(*) from order_contacts) = 2, 'vendor sees every call/chat on their orders');
select tests.login('00000000-0000-0000-0000-000000001011');
select tests.ok((select count(*) from order_contacts) = 0, 'other vendor sees none');
select tests.login('00000000-0000-0000-0000-000000001030');
select tests.expect_error($$select log_contact('30000000-0000-0000-0000-000000001003', 'call', 'confirmed')$$, 'only customer-service', 'riders cannot log contacts');
select tests.logout();
insert into order_events (order_id, from_status, to_status) values ('30000000-0000-0000-0000-000000001003', 'IN_TRANSIT', 'DELIVERED');
insert into order_events (order_id, from_status, to_status) values ('30000000-0000-0000-0000-000000001003', 'IN_TRANSIT', 'DELIVERED');
select tests.ok((select count(*) = 1 and sum(amount) = 200 from cs_charges where order_id = '30000000-0000-0000-0000-000000001003'), 'GHS 2 customer-service fee billed once per delivered order');
select tests.ok((select balance = -200 from wallets where owner_type = 'vendor' and owner_id = '10000000-0000-0000-0000-000000001001'), 'charged to the vendor wallet');
select tests.ok((select coalesce(sum(amount), 0) = 0 from ledger_entries), 'ledger still balanced');

rollback;
