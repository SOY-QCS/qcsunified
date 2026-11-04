-- =====================================================================
-- Phase 6 tests: notifications fan-out + sender worker, preferences, push tokens,
-- public tracking (privacy + ETA), address confirmation & correction, ratings.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000000601', '+233200000601'),  -- rider
  ('00000000-0000-0000-0000-000000000610', '+233200000610'),  -- customer
  ('00000000-0000-0000-0000-000000000611', '+233200000611'),  -- someone else
  ('00000000-0000-0000-0000-000000000612', '+233200000612');  -- support
update profiles set full_name = 'Kofi Mensah' where id = '00000000-0000-0000-0000-000000000601';
update profiles set email = 'efua@example.com' where id = '00000000-0000-0000-0000-000000000610';
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000000612', 'support', id from cities where code = 'ACC';
insert into vehicles (id, type, plate_number, max_weight_g) values ('50000000-0000-0000-0000-000000000601', 'bike', 'GR-6061-24', 15000);
insert into riders (id, rider_type, status, city_id, vehicle_id, is_online, last_location, last_location_at)
select '00000000-0000-0000-0000-000000000601', 'fleet', 'active', id, '50000000-0000-0000-0000-000000000601', true,
       st_setsrid(st_makepoint(-0.1735, 5.556), 4326)::geography, now() from cities where code = 'ACC';
insert into rider_documents (rider_id, doc_type, storage_path) values ('00000000-0000-0000-0000-000000000601', 'photo', '00000000-0000-0000-0000-000000000601/photo.jpg');

create temp table k as select (select id from cities where code = 'ACC') acc, (select id from zones where code = 'ACC-ELG') legon;
grant select on k to anon, authenticated, service_role;
create function tests.book6(p_user uuid) returns uuid language plpgsql as $$
declare qid uuid; req jsonb;
begin
  req := jsonb_build_object('service', 'express', 'payer', 'sender', 'payment_method', 'cash',
    'pickup', jsonb_build_object('formatted_address', 'Oxford St, Osu', 'lat', 5.556, 'lng', -0.178, 'contact_name', 'Efua', 'contact_phone', '+233241111111'),
    'dropoffs', jsonb_build_array(jsonb_build_object('formatted_address', 'Lagos Ave, East Legon', 'lat', 5.6355, 'lng', -0.161, 'contact_name', 'Yaw Boateng',
       'contact_phone', '+233 24 555 1234', 'weight_g', 1000, 'size', 'small', 'fragile', false, 'item_value', 0, 'cod_amount', 0)));
  insert into quotes (user_id, service_type, city_id, request, price, zones, total)
  select p_user, 'express', acc, req, jsonb_build_object('stops', jsonb_build_array(jsonb_build_object('netPesewas', 3000, 'insurancePesewas', 0, 'lines', '[]'::jsonb))),
         jsonb_build_array(legon), 3000 from k returning id into qid;
  return (create_booking(p_user, qid) -> 'orders' -> 0 ->> 'id')::uuid;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- =====================================================================
-- 1. Booking → messages to the sender (by preference) and the recipient (by SMS)
-- =====================================================================
select tests.service();
create temp table o as select tests.book6('00000000-0000-0000-0000-000000000610') id;
grant select on o to anon, authenticated, service_role;
create temp table tn as select tracking_number t, confirm_token c from orders where id = (select id from o);
grant select on tn to anon, authenticated, service_role;
select tests.logout();
select tests.ok((select count(*) from notifications where order_id = (select id from o) and template = 'order_confirmed' and channel = 'push') = 1,
  'sender gets a push when the booking is confirmed');
select tests.ok(not exists (select 1 from notifications where order_id = (select id from o) and template = 'order_confirmed' and channel = 'sms'),
  'no SMS to an account holder unless they switch SMS on (it costs money)');
select tests.ok((select to_address = '+233 24 555 1234' and channel = 'sms' from notifications where order_id = (select id from o) and template = 'address_confirm'),
  'recipient gets the confirm-your-address link by SMS');
select tests.ok((select confirm_token is not null and length(confirm_token) = 24 from orders where id = (select id from o)), 'each order has an unguessable confirmation token');

-- preferences
select tests.login('00000000-0000-0000-0000-000000000610');
insert into notification_preferences (user_id, push, whatsapp, sms, email) values ('00000000-0000-0000-0000-000000000610', true, false, true, true);
select tests.expect_error($$insert into notification_preferences (user_id) values ('00000000-0000-0000-0000-000000000611')$$, 'row-level security', 'you can only set your own preferences');
select register_push_token('ExponentPushToken[abc123]', 'client', 'android');
select tests.expect_error($$select register_push_token('not-a-token', 'client')$$, 'expo push token', 'junk push tokens are refused');
select tests.ok((select count(*) from push_tokens) = 1, 'customer sees their own push token');

-- =====================================================================
-- 2. Rider assigned → tracking: status for anyone, details only with the last 4 digits
-- =====================================================================
select tests.service();
select assign_trip((select trip_id from orders where id = (select id from o)), '00000000-0000-0000-0000-000000000601');
select tests.logout();
select tests.ok((select array_agg(channel::text order by channel::text) = '{push}'
                 from notifications where order_id = (select id from o) and template = 'rider_assigned' and user_id = '00000000-0000-0000-0000-000000000610'),
  'rider-assigned message follows the sender''s choices (WhatsApp switched off)');
select tests.ok((select payload ->> 'rider_name' = 'Kofi' and payload ->> 'rider_plate' = 'GR-6061-24' from notifications where order_id = (select id from o) and template = 'rider_assigned' and channel = 'push'),
  'message names the rider and plate');

select tests.login(null);
create temp table pub as select track_order((select t from tn)) j;
select tests.ok((select (j ->> 'found')::boolean and not (j ->> 'verified')::boolean and j ->> 'status' = 'ASSIGNED' and j -> 'rider' is null and j -> 'dropoff' is null from pub),
  'anyone with the tracking number sees the status only');
select tests.ok((select jsonb_array_length(j -> 'timeline') >= 2 from pub), 'status timeline is public');
select tests.ok((select not (track_order((select t from tn), '0000') ->> 'verified')::boolean), 'wrong last 4 digits: still status only');
create temp table priv as select track_order(lower((select t from tn)), '1234') j;
select tests.ok((select (j ->> 'verified')::boolean and j #>> '{rider,first_name}' = 'Kofi' and j #>> '{rider,plate}' = 'GR-6061-24'
                 and j #>> '{rider,phone}' = '+233200000601' and j #> '{rider,location}' is not null from priv),
  'right last 4 digits: rider name, plate, phone and live location');
select tests.ok((select (j ->> 'eta_minutes')::int between 15 and 60 from priv), 'arrival estimate while the rider heads to pickup');
select tests.ok((select j #>> '{dropoff,address}' = 'Lagos Ave, East Legon' and j ->> 'recipient_name' = 'Yaw Boateng' from priv), 'address shown only after the check');
select tests.ok((select j #>> '{rider,photo_path}' like '%photo.jpg' from priv), 'rider photo reference included');
select tests.logout();
-- brute force protection
select tests.login(null);
select track_order((select t from tn), lpad(g::text, 4, '0')) from generate_series(1, 10) g;
select tests.ok((select (track_order((select t from tn), '1234') ->> 'locked')::boolean), 'after 10 wrong guesses in an hour, details are locked even for the right code');
select tests.logout();
delete from track_attempts;
-- the sender sees everything when signed in
select tests.login('00000000-0000-0000-0000-000000000610');
select tests.ok((select (track_order((select t from tn)) ->> 'verified')::boolean), 'signed-in sender sees full tracking without the code');
select tests.login('00000000-0000-0000-0000-000000000611');
select tests.ok((select not (track_order((select t from tn)) ->> 'verified')::boolean), 'another signed-in user does not');
select tests.logout();

-- =====================================================================
-- 3. Recipient corrects the pin
-- =====================================================================
select tests.login(null);
select tests.ok((select address_link((select c from tn)) ->> 'recipient_name' = 'Yaw Boateng' and (address_link((select c from tn)) ->> 'can_change')::boolean),
  'confirmation link opens without login');
select tests.ok(address_link('short') is null, 'bad link shows nothing');
select tests.expect_error($$select correct_address((select c from tn), -0.17, 5.64, '', '', 0)$$, 'permission denied', 'only the server may move a pin (it works out the price)');
select tests.logout();
select tests.service();
select tests.expect_error($$select correct_address((select c from tn), -1.62, 6.69, '', '', 0)$$, 'outside the delivery area', 'pin cannot move to another city');
select tests.ok((correct_address((select c from tn), -0.1555, 5.6440, 'Blue gate opposite the pharmacy', 'Call when close', 1500) ->> 'moved_m')::int > 1000, 'pin moved more than 1 km');
select tests.logout();
select tests.ok((select extra_fee = 1500 and address_confirmation = 'corrected' and dropoff_landmark = 'Blue gate opposite the pharmacy'
                 and delivery_instructions like '%Recipient: Call when close%' from orders where id = (select id from o)), 'new pin, landmark, note and extra fee saved');
select tests.ok(exists (select 1 from notifications where order_id = (select id from o) and template = 'price_changed' and payload ->> 'extra_ghs' = '15.00'),
  'sender is told about the extra GHS 15.00');
select tests.ok(exists (select 1 from notifications where order_id = (select id from o) and template = 'route_changed' and user_id = '00000000-0000-0000-0000-000000000601'),
  'rider is told the drop-off moved');
select tests.ok(exists (select 1 from audit_log where reason like 'recipient corrected the drop-off pin%'), 'pin correction is in the audit log');
select tests.login('00000000-0000-0000-0000-000000000601');
select tests.ok((select round((my_job() -> 'orders' -> 0 ->> 'dropoff_lat')::numeric, 3) = 5.644), 'rider''s job shows the new location');
select tests.logout();

-- =====================================================================
-- 4. Sender worker
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000610');
select tests.expect_error($$select claim_notifications(10)$$, 'permission denied', 'apps cannot read the outgoing queue');
select tests.logout();
select tests.service();
create temp table batch as select claim_notifications(100) m;
select tests.ok((select count(*) > 0 from batch), 'worker claims queued messages');
select tests.ok((select m ->> 'body' from batch where m ->> 'key' = 'address_confirm' and m ->> 'channel' = 'sms')
                 like 'QCS: Efua is sending you a parcel (' || (select t from tn) || '). Please confirm your location: https://qcsghana.com/c/%', 'SMS is worded from the template with the link');
select tests.ok((select m -> 'to' = '["ExponentPushToken[abc123]"]'::jsonb from batch where m ->> 'key' = 'order_confirmed'), 'push goes to the customer''s phones');
select tests.ok((select m ->> 'to' = 'efua@example.com' from batch where m ->> 'channel' = 'email' limit 1) or not exists (select 1 from batch where m ->> 'channel' = 'email'),
  'email goes to the profile email');
select tests.ok(not exists (select 1 from batch where m -> 'data' ? 'code'), 'delivery codes never appear in push data');
select tests.ok((select count(*) = 0 from claim_notifications(100)), 'claimed messages are not handed out twice');
select tests.ok(exists (select 1 from notifications where template = 'route_changed' and status = 'skipped' and error = 'no push address'),
  'a message nobody can receive is skipped, not retried forever');
select finish_notification((select (m ->> 'id')::uuid from batch where m ->> 'key' = 'order_confirmed'), true);
select finish_notification((select (m ->> 'id')::uuid from batch where m ->> 'key' = 'address_confirm' and m ->> 'channel' = 'sms'), false, 'Hubtel timeout');
select tests.logout();
select tests.ok((select status = 'sent' from notifications where template = 'order_confirmed' and order_id = (select id from o)), 'success is recorded');
select tests.ok((select status = 'queued' and attempts = 1 and next_attempt_at > now() from notifications where template = 'address_confirm' and channel = 'sms'), 'failure is retried later');
update notifications set attempts = 3, status = 'sending' where template = 'address_confirm' and channel = 'sms';
select tests.service();
select finish_notification((select id from notifications where template = 'address_confirm' and channel = 'sms'), false, 'still down');
select tests.logout();
select tests.ok((select status = 'failed' and error = 'still down' from notifications where template = 'address_confirm' and channel = 'sms'), 'gives up after 3 tries');
insert into notifications (to_address, order_id, channel, template, payload) values ('+233245551234', (select id from o), 'sms', 'delivery_code', '{"code":"4821","tracking_number":"X"}');
select tests.service();
select finish_notification((select (m ->> 'id')::uuid from claim_notifications(100) m where m ->> 'key' = 'delivery_code'), true);
select tests.logout();
select tests.ok((select not (payload ? 'code') and status = 'sent' from notifications where payload ->> 'tracking_number' = 'X'), 'delivery code is wiped from the queue once sent');
-- admin can switch a template off
select tests.login('00000000-0000-0000-0000-000000000612');
select tests.ok(tests.rows($$update notification_templates set enabled = false where key = 'picked_up'$$) = 0, 'support cannot edit templates');
select tests.logout();
update notification_templates set enabled = false where key = 'on_the_way';

-- =====================================================================
-- 5. Delivery → rating
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000000601');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from o), 'to', 'RIDER_AT_PICKUP', 'lng', -0.178, 'lat', 5.556));
select tests.expect_error($$select rate_pickup((select id from o), 4)$$, 'after you have the parcel', 'rider rates the pickup only after collecting');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from o), 'to', 'PICKED_UP', 'lng', -0.178, 'lat', 5.556));
select rate_pickup((select id from o), 2, array['long wait'], 'Waited 25 minutes');
select rate_pickup((select id from o), 5);  -- ignored
select tests.ok((select score = 2 and kind = 'rider' from ratings where order_id = (select id from o)), 'rider rated the pickup once');
select tests.logout();
select tests.ok(not exists (select 1 from notifications where order_id = (select id from o) and template = 'on_the_way'), 'a disabled template sends nothing');
create temp table code as select payload ->> 'code' c from notifications where order_id = (select id from o) and template = 'delivery_code' order by created_at desc limit 1;
grant select on code to anon, authenticated, service_role;
select tests.login('00000000-0000-0000-0000-000000000601');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from o), 'to', 'IN_TRANSIT', 'lng', -0.17, 'lat', 5.6));
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from o), 'to', 'ARRIVED_AT_DROPOFF', 'lng', -0.1555, 'lat', 5.644));
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'code', 'order_id', (select id from o), 'code', (select c from code)));
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'pod', 'order_id', (select id from o), 'signature_path', 'x/sig.svg'));
select tests.login('00000000-0000-0000-0000-000000000610');
select tests.expect_error($$select rate_rider((select id from o), 5)$$, 'once the parcel is delivered', 'cannot rate before delivery');
select tests.login(null);
select tests.ok((select (address_link((select c from tn)) ->> 'can_change')::boolean = false), 'pin is locked once the rider is at the door');
select tests.login('00000000-0000-0000-0000-000000000601');
select rider_action(gen_random_uuid(), jsonb_build_object('type', 'status', 'order_id', (select id from o), 'to', 'DELIVERED', 'lng', -0.1555, 'lat', 5.644));
select tests.login('00000000-0000-0000-0000-000000000610');
select tests.ok((select (j ->> 'can_rate')::boolean and j #>> '{rider,phone}' is null and j #>> '{rider,location}' is null from (select track_order((select t from tn)) j) x),
  'after delivery: rating offered, rider phone and location hidden');
select tests.login('00000000-0000-0000-0000-000000000611');
select tests.expect_error($$select rate_rider((select id from o), 5)$$, 'your own deliveries', 'only the sender can rate');
select tests.login('00000000-0000-0000-0000-000000000610');
select rate_rider((select id from o), 2, array['late'], 'Took very long');
select tests.expect_error($$select rate_rider((select id from o), 5)$$, 'already been rated', 'one rating per delivery');
select tests.ok(tests.rows($$update ratings set score = 5$$) = 0, 'ratings cannot be edited');
select tests.logout();
select tests.ok((select rating = 2.00 from riders where id = '00000000-0000-0000-0000-000000000601'), 'rider rating is the average of client ratings');
select tests.ok(exists (select 1 from notifications where template = 'low_rating' and user_id = '00000000-0000-0000-0000-000000000612'), 'support is alerted to a 1–2 star rating');
select tests.ok(exists (select 1 from notifications where order_id = (select id from o) and template = 'delivered' and channel = 'push'), 'sender is told it was delivered');
select tests.ok((select bool_and(coalesce(occurred_at, created_at) > now() - interval '1 minute') from order_events where order_id = (select id from o)), 'online rider updates carry the real time (bug fix)');
select tests.login('00000000-0000-0000-0000-000000000601');
select tests.ok((select count(*) = 1 from ratings where kind = 'client'), 'rider can see ratings about them');
select tests.logout();
rollback;
