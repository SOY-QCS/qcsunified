-- =====================================================================
-- Phase 11 tests: API keys, request log + rate limit, idempotency, delivery object, get/list/cancel,
-- test mode, webhooks (queueing, retries, auto-disable, SSRF guard), Shopify connection data.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values
  ('00000000-0000-0000-0000-000000001101', '+233200001101'),  -- V: vendor owner
  ('00000000-0000-0000-0000-000000001102', '+233200001102'),  -- other vendor owner
  ('00000000-0000-0000-0000-000000001103', '+233200001103'),  -- V's staff without API permission
  ('00000000-0000-0000-0000-000000001104', '+233200001104');  -- V's staff with API permission
create temp table k as select (select id from cities where code = 'ACC') acc;
grant select on k to anon, authenticated, service_role;
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001101', 'Kente Online', acc from k;
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000001102', '00000000-0000-0000-0000-000000001102', 'Other Shop', acc from k;
insert into vendor_staff (vendor_id, user_id, permissions) values
  ('10000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001103', '{book}'),
  ('10000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001104', '{api}');

create function tests.order11(p_id uuid, p_vendor uuid, p_status text, p_ref text, p_at timestamptz default now()) returns void language plpgsql as $$
begin
  insert into orders (id, service_type, city_id, customer_id, vendor_id, pickup_location, dropoff_location, recipient_name, recipient_phone,
                      weight_g, quoted_fee, payer, payment_method, status, created_at, external_ref, pickup_address_text, dropoff_address_text)
  select p_id, 'ecommerce', acc, (select owner_id from vendors where id = p_vendor), p_vendor,
         st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography, st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography,
         'Esi Mensah', '+233243334444', 1000, 2500, 'vendor_wallet', 'wallet', p_status::order_status, p_at, p_ref, 'Oxford St, Osu', 'Lagos Ave, East Legon'
  from k;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- =====================================================================
-- 1. API keys
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001101');
create temp table key_t as select create_api_key('10000000-0000-0000-0000-000000001101', 'Test site', 'test') r;
grant select on key_t to anon, authenticated, service_role;
select tests.ok((select r ->> 'key' ~ '^qcs_test_[0-9a-f]{48}$' from key_t), 'test key made: qcs_test_ + 48 random characters');
select tests.expect_error($$select create_api_key('10000000-0000-0000-0000-000000001101', 'Shop', 'live')$$, 'verified', 'live keys wait for the business ID check');
select tests.logout();
update vendors set kyc_status = 'approved' where id = '10000000-0000-0000-0000-000000001101';
select tests.login('00000000-0000-0000-0000-000000001101');
create temp table key_l as select create_api_key('10000000-0000-0000-0000-000000001101', 'Shop website', 'live') r;
grant select on key_l to anon, authenticated, service_role;
select tests.ok((select r ->> 'key' like 'qcs_live_%' from key_l), 'live key after verification');
select tests.ok((select count(*) = 2 and bool_and(key_hash <> (select r ->> 'key' from key_l)) from api_keys), 'owner sees 2 keys, never the key itself');
select tests.logout();
select tests.ok((select key_hash = encode(digest((select r ->> 'key' from key_l), 'sha256'), 'hex') and key_prefix = left((select r ->> 'key' from key_l), 14)
                 from api_keys where id = (select (r ->> 'id')::uuid from key_l)), 'only the SHA-256 hash and a short prefix are stored');
select tests.login('00000000-0000-0000-0000-000000001103');
select tests.expect_error($$select create_api_key('10000000-0000-0000-0000-000000001101', 'Sneaky', 'test')$$, 'api access', 'staff without API permission can''t make keys');
select tests.ok((select count(*) from api_keys) = 0, 'or see them');
select tests.login('00000000-0000-0000-0000-000000001104');
select tests.ok((select count(*) from api_keys) = 2, 'staff with API permission see the keys');
select tests.login('00000000-0000-0000-0000-000000001102');
select tests.ok((select count(*) from api_keys) = 0, 'another business sees none');
select tests.expect_error($$select revoke_api_key((select (r ->> 'id')::uuid from key_t))$$, 'not found', 'and can''t revoke them');
select tests.login('00000000-0000-0000-0000-000000001101');
select tests.ok(tests.rows($$update api_keys set mode = 'live'$$) = 0, 'keys can''t be edited directly');

-- =====================================================================
-- 2. Calling the API: key check, log, rate limit
-- =====================================================================
select tests.expect_error($$select api_begin('x', 'GET', '/x')$$, 'permission denied', 'only the booking server checks keys');
select tests.service();
select tests.ok((api_begin('nope', 'GET', '/v1/deliveries') ->> 'status')::int = 401, 'unknown key → 401');
create temp table b1 as select api_begin(encode(digest((select r ->> 'key' from key_l), 'sha256'), 'hex'), 'POST', '/v1/deliveries', '41.66.1.2') r;
grant select on b1 to anon, authenticated, service_role;
select tests.ok((select (r ->> 'ok')::boolean and r ->> 'vendor_id' = '10000000-0000-0000-0000-000000001101' and r ->> 'mode' = 'live'
                        and r ->> 'owner_id' = '00000000-0000-0000-0000-000000001101' from b1), 'valid key → business, mode and owner');
select api_end((select (r ->> 'log_id')::bigint from b1), 201, 412, null, 'ACC-202611050000-ACC');
select tests.logout();
update app_settings set value = '3' where key = 'api_rate_per_minute' and city_id is null;
select tests.service();
select api_begin(encode(digest((select r ->> 'key' from key_l), 'sha256'), 'hex'), 'GET', '/v1/deliveries') from generate_series(1, 2);
select tests.ok((api_begin(encode(digest((select r ->> 'key' from key_l), 'sha256'), 'hex'), 'GET', '/v1/deliveries') ->> 'status')::int = 429,
                'rate limit: 4th call in a minute → 429');
select tests.ok((api_begin(encode(digest((select r ->> 'key' from key_t), 'sha256'), 'hex'), 'GET', '/v1/deliveries') ->> 'ok')::boolean, 'limit is per key');
select tests.logout();
update app_settings set value = '120' where key = 'api_rate_per_minute' and city_id is null;
select tests.login('00000000-0000-0000-0000-000000001101');
select tests.ok((select count(*) = 5 and count(*) filter (where status = 201 and duration_ms = 412 and reference like 'ACC-%') = 1
                        and count(*) filter (where status = 429) = 1 from api_requests), 'every call is in the business''s API log');
select revoke_api_key((select (r ->> 'id')::uuid from key_t));
select tests.login('00000000-0000-0000-0000-000000001102');
select tests.ok((select count(*) from api_requests) = 0, 'another business can''t see the log');
select tests.service();
select tests.ok((api_begin(encode(digest((select r ->> 'key' from key_t), 'sha256'), 'hex'), 'GET', '/x') ->> 'error') = 'This API key was revoked', 'revoked key → refused');

-- =====================================================================
-- 3. Idempotency
-- =====================================================================
select tests.ok(api_idem_claim('10000000-0000-0000-0000-000000001101', 'live', 'woo-77', 'h1') is null, 'first use of a key: go ahead');
select tests.ok((api_idem_claim('10000000-0000-0000-0000-000000001101', 'live', 'woo-77', 'h1') ->> 'in_progress')::boolean, 'same key while still working → in progress');
select api_idem_save('10000000-0000-0000-0000-000000001101', 'live', 'woo-77', 201, '{"tracking_number":"ACC-1"}');
select tests.ok((select (r ->> 'status')::int = 201 and r -> 'response' ->> 'tracking_number' = 'ACC-1'
                 from (select api_idem_claim('10000000-0000-0000-0000-000000001101', 'live', 'woo-77', 'h1') r) x), 'retry → the first answer again, nothing booked twice');
select tests.ok((api_idem_claim('10000000-0000-0000-0000-000000001101', 'live', 'woo-77', 'h2') ->> 'conflict')::boolean, 'same key, different request → conflict');
select tests.ok(api_idem_claim('10000000-0000-0000-0000-000000001101', 'test', 'woo-77', 'h2') is null, 'test and live keys don''t share idempotency keys');
select api_idem_claim('10000000-0000-0000-0000-000000001101', 'live', 'woo-78', 'h1');
select api_idem_save('10000000-0000-0000-0000-000000001101', 'live', 'woo-78', 500, '{}');
select tests.ok(api_idem_claim('10000000-0000-0000-0000-000000001101', 'live', 'woo-78', 'h1') is null, 'after a server error the same key can be retried');
select api_idem_claim('10000000-0000-0000-0000-000000001101', 'live', 'woo-79', 'h1');
select api_idem_save('10000000-0000-0000-0000-000000001101', 'live', 'woo-79', 422, '{"error":{"code":"address_not_found"}}');
select tests.ok(api_idem_claim('10000000-0000-0000-0000-000000001101', 'live', 'woo-79', 'h2') is null, 'after a refusal (e.g. address not found) the shop can fix it and retry with the same key');
select tests.logout();

-- =====================================================================
-- 4. Get / list / cancel
-- =====================================================================
select tests.order11('30000000-0000-0000-0000-000000001101', '10000000-0000-0000-0000-000000001101', 'CONFIRMED', 'WOO-1001', now() - interval '3 minutes');
select tests.order11('30000000-0000-0000-0000-000000001102', '10000000-0000-0000-0000-000000001101', 'PICKED_UP', 'WOO-1002', now() - interval '2 minutes');
select tests.order11('30000000-0000-0000-0000-000000001103', '10000000-0000-0000-0000-000000001101', 'DELIVERED', 'WOO-1003', now() - interval '1 minute');
select tests.order11('30000000-0000-0000-0000-000000001104', '10000000-0000-0000-0000-000000001102', 'CONFIRMED', 'OTHER-1');
select tests.order11('30000000-0000-0000-0000-000000001105', '10000000-0000-0000-0000-000000001101', 'DRAFT', 'WOO-DRAFT');
create temp table tn as select (select tracking_number from orders where id = '30000000-0000-0000-0000-000000001101') t1,
  (select tracking_number from orders where id = '30000000-0000-0000-0000-000000001102') t2,
  (select tracking_number from orders where id = '30000000-0000-0000-0000-000000001104') t4;
grant select on tn to anon, authenticated, service_role;
select tests.service();
select tests.ok((select d ->> 'reference' = 'WOO-1001' and d ->> 'status' = 'CONFIRMED' and d ->> 'status_text' = 'Booked' and (d -> 'fee' ->> 'amount')::int = 2500
                        and d -> 'dropoff' ->> 'contact_name' = 'Esi Mensah' and d ->> 'tracking_url' like '%/track/ACC-%' and jsonb_typeof(d -> 'events') = 'array'
                 from (select api_get_delivery('10000000-0000-0000-0000-000000001101', (select t1 from tn)) d) x), 'get by tracking number: the delivery object');
select tests.ok((api_get_delivery('10000000-0000-0000-0000-000000001101', 'WOO-1002') ->> 'status') = 'PICKED_UP', 'get by your own order number');
select tests.ok(api_get_delivery('10000000-0000-0000-0000-000000001101', (select t4 from tn)) is null, 'another business''s delivery: not found');
select tests.ok(api_get_delivery('10000000-0000-0000-0000-000000001101', 'WOO-DRAFT') is null, 'drafts are not shown');
select tests.ok(not (api_delivery('30000000-0000-0000-0000-000000001101') ?| array['delivery_otp_hash', 'pickup_otp_hash', 'confirm_token']), 'delivery codes are never in the API');
create temp table p1 as select api_list_deliveries('10000000-0000-0000-0000-000000001101', null, null, null, null, 2) r;
grant select on p1 to anon, authenticated, service_role;
select tests.ok((select jsonb_array_length(r -> 'data') = 2 and (r ->> 'has_more')::boolean and r -> 'data' -> 0 ->> 'reference' = 'WOO-1003' from p1), 'list: newest first, 2 per page, more to come');
select tests.ok((select jsonb_array_length(x -> 'data') = 1 and not (x ->> 'has_more')::boolean and x -> 'data' -> 0 ->> 'reference' = 'WOO-1001'
                 from (select api_list_deliveries('10000000-0000-0000-0000-000000001101', null, null, null, null, 2, (select (r ->> 'next_before')::timestamptz from p1)) x) y),
                'list: next page');
select tests.ok((select jsonb_array_length(api_list_deliveries('10000000-0000-0000-0000-000000001101', 'confirmed,picked_up') -> 'data')) = 2, 'list: filter by status');
select tests.expect_error($$select api_cancel_delivery('10000000-0000-0000-0000-000000001101', (select t2 from tn))$$, 'already "Picked up"', 'can''t cancel once the rider has it');
select tests.expect_error($$select api_cancel_delivery('10000000-0000-0000-0000-000000001101', (select t4 from tn))$$, 'not found', 'can''t cancel another business''s delivery');
select tests.ok((api_cancel_delivery('10000000-0000-0000-0000-000000001101', 'WOO-1001', 'customer changed mind') ->> 'status') = 'CANCELLED', 'cancel before pickup');
select tests.logout();
select tests.ok(exists (select 1 from order_events where order_id = '30000000-0000-0000-0000-000000001101' and to_status = 'CANCELLED' and reason = 'api_cancel'
                        and note like 'Cancelled via API: customer changed mind'), 'cancellation in the order history');

-- =====================================================================
-- 5. Webhooks
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001101');
select tests.expect_error($$insert into webhooks (vendor_id, url) values ('10000000-0000-0000-0000-000000001101', 'http://shop.example.com/hook')$$, 'https', 'webhooks must use https');
select tests.expect_error($$insert into webhooks (vendor_id, url) values ('10000000-0000-0000-0000-000000001101', 'https://10.0.0.5/hook')$$, 'not an IP', 'no IP addresses (private networks)');
select tests.expect_error($$insert into webhooks (vendor_id, url) values ('10000000-0000-0000-0000-000000001101', 'https://localhost/hook')$$, 'not an IP', 'no localhost');
select tests.expect_error($$insert into webhooks (vendor_id, url, events) values ('10000000-0000-0000-0000-000000001101', 'https://shop.example.com/h', '{order.paid}')$$, 'unknown webhook event', 'only known events');
insert into webhooks (vendor_id, url, mode) values ('10000000-0000-0000-0000-000000001101', 'https://shop.example.com/qcs-live', 'live');
insert into webhooks (vendor_id, url, mode) values ('10000000-0000-0000-0000-000000001101', 'https://shop.example.com/qcs-test', 'test');
insert into webhooks (vendor_id, url, mode, events) values ('10000000-0000-0000-0000-000000001101', 'https://erp.example.com/qcs', 'live', '{delivery.status_changed}');
select tests.ok((select bool_and(secret ~ '^whsec_[0-9a-f]{48}$') from webhooks), 'every endpoint gets its own signing secret');
select tests.login('00000000-0000-0000-0000-000000001102');
select tests.ok((select count(*) from webhooks) = 0, 'another business can''t see them');
select tests.expect_error($$insert into webhooks (vendor_id, url) values ('10000000-0000-0000-0000-000000001101', 'https://evil.example.com/x')$$, 'row-level security', 'or add one');
select tests.logout();
create temp table w as select (select id from webhooks where url like '%qcs-live') live, (select id from webhooks where url like '%qcs-test') test, (select id from webhooks where url like '%erp%') erp;
grant select on w to anon, authenticated, service_role;
select tests.ok((select count(*) from webhook_deliveries where webhook_id = (select live from w) and event_type = 'delivery.status_changed' and payload -> 'data' ->> 'status' = 'CANCELLED') = 0,
                'nothing was sent before the endpoint existed');

-- a live delivery moves: created + status changes go to the live endpoints only
select tests.order11('30000000-0000-0000-0000-000000001106', '10000000-0000-0000-0000-000000001101', 'DRAFT', 'WOO-1006');
insert into order_events (order_id, from_status, to_status) values ('30000000-0000-0000-0000-000000001106', 'DRAFT', 'CONFIRMED');
insert into order_events (order_id, from_status, to_status, reason) values ('30000000-0000-0000-0000-000000001106', 'CONFIRMED', 'FAILED_ATTEMPT', 'recipient_unreachable');
select tests.ok((select count(*) from webhook_deliveries where webhook_id = (select live from w)) = 3, 'all-events endpoint: created + 2 status changes');
select tests.ok((select count(*) from webhook_deliveries where webhook_id = (select erp from w)) = 2, 'status-only endpoint: 2 status changes');
select tests.ok((select count(*) from webhook_deliveries where webhook_id = (select test from w)) = 0, 'test endpoint gets no live events');
select tests.ok((select payload -> 'data' ->> 'previous_status' is null from webhook_deliveries where webhook_id = (select erp from w) and payload -> 'data' ->> 'status' = 'CONFIRMED'),
                'internal draft step is never shown as previous status');
select tests.ok(not exists (select 1 from jsonb_array_elements(api_delivery('30000000-0000-0000-0000-000000001106', true) -> 'events') e where e ->> 'status' = 'DRAFT'), 'history starts at Booked');
select tests.ok((select payload ->> 'type' = 'delivery.status_changed' and (payload ->> 'livemode')::boolean and payload ->> 'id' like 'evt_%'
                        and payload -> 'data' ->> 'status' = 'FAILED_ATTEMPT' and payload -> 'data' ->> 'previous_status' = 'CONFIRMED'
                        and payload -> 'data' ->> 'reason' = 'recipient_unreachable' and payload -> 'data' ->> 'reference' = 'WOO-1006'
                 from webhook_deliveries where webhook_id = (select erp from w) and payload -> 'data' ->> 'status' = 'FAILED_ATTEMPT'), 'event payload: type, id, status, previous status, reason');

-- sender: claim, fail, retry later, give up after the last retry, turn endpoint off
select tests.login('00000000-0000-0000-0000-000000001101');
select tests.expect_error($$select claim_webhooks(10)$$, 'permission denied', 'apps can''t read the queue (secrets)');
select tests.service();
create temp table c1 as select r from claim_webhooks(50) r;
grant select on c1 to anon, authenticated, service_role;
select tests.ok((select count(*) = 5 and bool_and(r ->> 'secret' like 'whsec_%' and r ->> 'url' like 'https://%') from c1), 'sender gets 5 messages with URL and secret');
select tests.ok((select count(*) from claim_webhooks(50)) = 0, 'claimed messages are not handed out twice');
select finish_webhook((r ->> 'id')::uuid, true, 200, null, 'ok') from c1 where r ->> 'url' like '%erp%';
select finish_webhook((r ->> 'id')::uuid, false, 503, 'HTTP 503', 'Service Unavailable') from c1 where r ->> 'url' like '%qcs-live';
select tests.logout();
select tests.ok((select count(*) = 3 and bool_and(status = 'queued' and next_attempt_at between now() + interval '59 seconds' and now() + interval '61 seconds' and last_status_code = 503)
                 from webhook_deliveries where webhook_id = (select live from w)), 'failed: retried in 1 minute');
select tests.ok((select count(*) = 2 and bool_and(status = 'sent') from webhook_deliveries where webhook_id = (select erp from w)), 'answered 2xx: sent');
-- the live endpoint keeps failing through every retry
update app_settings set value = '2' where key = 'webhook_disable_after' and city_id is null;
update webhook_deliveries set attempts = 9, status = 'sending' where webhook_id = (select live from w);
select tests.service();
select finish_webhook(id, false, null, 'connection refused') from webhook_deliveries where webhook_id = (select live from w);
select tests.logout();
select tests.ok((select count(*) = 3 and bool_and(status = 'failed') from webhook_deliveries where webhook_id = (select live from w)), 'after the last retry (~2 days): failed');
select tests.ok((select not is_active and disabled_reason like '%could not be delivered%' from webhooks where id = (select live from w)), 'endpoint turned off after failing repeatedly');
select tests.ok(exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000001101' and template = 'webhook_disabled' and channel = 'email'), 'business emailed about it');
insert into order_events (order_id, from_status, to_status) values ('30000000-0000-0000-0000-000000001106', 'FAILED_ATTEMPT', 'RESCHEDULED');
select tests.ok((select count(*) from webhook_deliveries where webhook_id = (select live from w)) = 3, 'a turned-off endpoint gets nothing new');
select tests.login('00000000-0000-0000-0000-000000001101');
update webhooks set is_active = true where id = (select live from w);
select tests.ok((select failure_streak = 0 and disabled_reason is null from webhooks where id = (select live from w)), 'turning it back on clears the failure count');
select resend_webhook((select id from webhook_deliveries where webhook_id = (select live from w) limit 1));
select tests.ok((select count(*) from webhook_deliveries where webhook_id = (select live from w) and status = 'queued' and attempts = 0) = 1, 'resend a failed message');
select tests.ok(ping_webhook((select erp from w)) is not null, 'send test event (ping)');
select tests.ok((select count(*) from webhook_deliveries where event_type = 'ping') = 1, 'ping queued');
select tests.ok(rotate_webhook_secret((select erp from w)) like 'whsec_%', 'rotate the signing secret');
select tests.login('00000000-0000-0000-0000-000000001102');
select tests.ok((select count(*) from webhook_deliveries) = 0, 'another business can''t see the message log');
select tests.expect_error($$select resend_webhook((select id from webhook_deliveries limit 1))$$, 'not found', 'or resend');
select tests.logout();

-- =====================================================================
-- 6. Test mode
-- =====================================================================
select tests.service();
create temp table td as select api_test_create('10000000-0000-0000-0000-000000001101', api_delivery('30000000-0000-0000-0000-000000001106') - 'events') d;
grant select on td to anon, authenticated, service_role;
select tests.ok((select d ->> 'tracking_number' like 'TEST-%' and not (d ->> 'livemode')::boolean and d ->> 'status' = 'CONFIRMED' from td), 'practice delivery: TEST- number, livemode false');
select tests.expect_error($$select api_test_create('10000000-0000-0000-0000-000000001101', '{"reference":"WOO-1006"}')$$, 'already booked', 'test mode also refuses a repeated order number');
select tests.ok((select count(*) from webhook_deliveries where webhook_id = (select test from w) and event_type = 'delivery.created') = 1, 'test webhook gets delivery.created');
select tests.ok((select count(*) from orders where tracking_number like 'TEST-%') = 0, 'nothing real was created (no order, no rider, no charge)');
select api_test_transition('10000000-0000-0000-0000-000000001101', (select d ->> 'tracking_number' from td), 'picked_up');
select tests.ok((select status = 'PICKED_UP' and data -> 'rider' ->> 'first_name' = 'Test' and jsonb_array_length(data -> 'events') = 2 from api_test_deliveries), 'simulate: picked up');
select tests.ok((select payload -> 'data' ->> 'previous_status' = 'CONFIRMED' from webhook_deliveries where webhook_id = (select test from w) and event_type = 'delivery.status_changed'),
                'and the test webhook gets the status change');
select tests.expect_error($$select api_test_transition('10000000-0000-0000-0000-000000001101', (select d ->> 'tracking_number' from td), 'FAILED_ATTEMPT')$$, 'reason', 'failed attempt needs a reason (as in real life)');
select tests.expect_error($$select api_test_cancel('10000000-0000-0000-0000-000000001101', (select d ->> 'tracking_number' from td))$$, 'already "Picked up"', 'same cancel rule as live');
select api_test_transition('10000000-0000-0000-0000-000000001101', (select d ->> 'tracking_number' from td), 'DELIVERED');
select tests.ok((select data ->> 'delivered_at' is not null from api_test_deliveries), 'delivered time set');
select tests.expect_error($$select api_test_transition('10000000-0000-0000-0000-000000001101', (select d ->> 'tracking_number' from td), 'IN_TRANSIT')$$, 'finished', 'finished practice deliveries stay finished');
select tests.ok((select jsonb_array_length(api_test_list('10000000-0000-0000-0000-000000001101') -> 'data')) = 1, 'list practice deliveries');
select tests.ok(api_test_get('10000000-0000-0000-0000-000000001102', (select d ->> 'tracking_number' from td)) is null, 'another business can''t see them');
select tests.logout();

-- =====================================================================
-- 7. Shopify connection data
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001101');
select tests.ok(split_part(start_shopify_connect('10000000-0000-0000-0000-000000001101', 'https://Kente-Online.myshopify.com/admin'), ':', 2) = 'kente-online.myshopify.com',
                'shop address tidied (https://…/admin → kente-online.myshopify.com)');
select tests.ok(split_part(start_shopify_connect('10000000-0000-0000-0000-000000001101', 'kente-online'), ':', 2) = 'kente-online.myshopify.com', 'short name works too');
select tests.expect_error($$select start_shopify_connect('10000000-0000-0000-0000-000000001101', 'not a shop!')$$, 'store address', 'nonsense refused');
select tests.logout();
insert into shopify_shops (shop, vendor_id) values ('kente-online.myshopify.com', '10000000-0000-0000-0000-000000001101');
insert into shopify_tokens (shop, access_token) values ('kente-online.myshopify.com', 'shpat_secret');
select tests.login('00000000-0000-0000-0000-000000001102');
select tests.expect_error($$select start_shopify_connect('10000000-0000-0000-0000-000000001102', 'kente-online.myshopify.com')$$, 'another QCS account', 'a shop can''t be linked to two businesses');
select tests.login('00000000-0000-0000-0000-000000001101');
select tests.ok((select count(*) from shopify_shops) = 1, 'business sees its connected shop');
select tests.ok((select count(*) from shopify_tokens) = 0, 'but never the Shopify access token');
select tests.ok(tests.rows($$update shopify_shops set auto_create = false$$) = 1, 'can switch automatic booking off');
select tests.expect_error($$update shopify_shops set vendor_id = '10000000-0000-0000-0000-000000001102'$$, 'only the service', 'can''t move the shop to another account');
select tests.ok((select count(*) from shopify_oauth_states) = 0, 'sign-in states are server-only');
select tests.logout();

-- source of API bookings
select tests.service();
select api_mark_source(null, 'api');
select tests.logout();
select tests.ok(not exists (select 1 from orders where source = 'api'), 'source is only set for the quote that was booked');

rollback;
