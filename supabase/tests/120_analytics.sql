-- =====================================================================
-- Phase 12 tests: order facts (times, outcome, on-time), rider shifts, report numbers, who may see what,
-- vendor analytics (money only with the wallet permission), scheduled email reports.
-- Known data: 7 deliveries in the last 7 days (+1 the week before) so every number can be checked by hand.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone, email) values
  ('00000000-0000-0000-0000-000000001201', '+233200001201', null),                   -- vendor V owner (Accra)
  ('00000000-0000-0000-0000-000000001202', '+233200001202', null),                   -- vendor W owner (Kumasi)
  ('00000000-0000-0000-0000-000000001203', '+233200001203', null),                   -- V's staff, no wallet permission
  ('00000000-0000-0000-0000-000000001210', '+233200001210', 'analyst@qcsghana.com'), -- analyst (all cities)
  ('00000000-0000-0000-0000-000000001211', '+233200001211', 'accra@qcsghana.com'),   -- city admin Accra
  ('00000000-0000-0000-0000-000000001212', '+233200001212', 'disp@qcsghana.com'),    -- dispatcher (no reports)
  ('00000000-0000-0000-0000-000000001220', '+233200001220', null);                   -- rider
update profiles set email = u.email from auth.users u where u.id = profiles.id and u.email is not null;
update profiles set full_name = 'Rider Kojo' where id = '00000000-0000-0000-0000-000000001220';
create temp table k as select (select id from cities where code = 'ACC') acc, (select id from cities where code = 'KSI') ksi,
  (select id from zones where code = 'ACC-ELG') legon, (current_date - 6) d0;
grant select on k to anon, authenticated, service_role;
insert into user_roles (user_id, role) values ('00000000-0000-0000-0000-000000001210', 'analyst');
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001211', 'city_admin', acc from k;
insert into user_roles (user_id, role, city_id) select '00000000-0000-0000-0000-000000001212', 'dispatcher', acc from k;
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000001201', '00000000-0000-0000-0000-000000001201', 'Kente Online', acc from k;
insert into vendors (id, owner_id, business_name, city_id) select '10000000-0000-0000-0000-000000001202', '00000000-0000-0000-0000-000000001202', 'Ashanti Gold', ksi from k;
insert into vendor_staff (vendor_id, user_id, permissions) values ('10000000-0000-0000-0000-000000001201', '00000000-0000-0000-0000-000000001203', '{book}');
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000001201', 'bike', 'GR-1201');
insert into riders (id, rider_type, status, city_id, vehicle_id, last_location_at) select '00000000-0000-0000-0000-000000001220', 'fleet', 'active', acc, '50000000-0000-0000-0000-000000001201', now() from k;

-- an order and its history: p_steps = array of [status, minutes after booking, reason]
create function tests.o12(p_id int, p_service text, p_city text, p_vendor uuid, p_final text, p_fee int, p_steps text[][], p_day_offset int default 0,
                          p_option text default null, p_cod int default 0, p_failed_fee int default null) returns void language plpgsql as $$
declare oid uuid := ('30000000-0000-0000-0000-00000000' || lpad(p_id::text, 4, '0'))::uuid; t0 timestamptz; prev text := 'DRAFT'; s text[];
begin
  t0 := ((select d0 from k) + p_day_offset + time '10:00') at time zone 'Africa/Accra';
  insert into orders (id, service_type, city_id, vendor_id, customer_id, rider_id, pickup_location, dropoff_location, dropoff_zone_id, recipient_name, recipient_phone,
                      weight_g, quoted_fee, failed_fee, payer, payment_method, status, intercity_option, cod_amount, pickup_date, created_at, origin_hub_id, dest_hub_id)
  select oid, p_service::service_type, case p_city when 'ACC' then acc else ksi end, p_vendor, coalesce((select owner_id from vendors where id = p_vendor), '00000000-0000-0000-0000-000000001201'),
         '00000000-0000-0000-0000-000000001220', st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography,
         case p_city when 'ACC' then st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography else st_setsrid(st_makepoint(-1.618, 6.69), 4326)::geography end,
         case p_city when 'ACC' then legon end, 'Esi', '+233243334444', 1000, p_fee, coalesce(p_failed_fee, 0),
         case when p_vendor is null then 'sender' else 'vendor_wallet' end::payer_type, case when p_vendor is null then 'cash' else 'wallet' end::payment_method,
         p_final::order_status, p_option::intercity_option, p_cod, (select d0 from k) + p_day_offset, t0,
         case when p_service = 'intercity' then (select id from hubs where code = 'KSI-HUB') end, case when p_service = 'intercity' then (select id from hubs where code = 'ACC-HUB') end
  from k;
  foreach s slice 1 in array p_steps loop
    insert into order_events (order_id, from_status, to_status, reason, occurred_at)
    values (oid, prev::order_status, s[1]::order_status, nullif(s[3], ''), t0 + make_interval(mins => s[2]::int));
    prev := s[1];
  end loop;
end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- (test data only: orders are inserted already finished, so skip the automatic "created" history entry; the steps below are the history)
alter table orders disable trigger orders_created_event;
-- 1. Express, Accra: picked up after 20 min, delivered 30 min later → on time (90 min)
select tests.o12(1, 'express', 'ACC', null, 'DELIVERED', 3000, array[['CONFIRMED','0',''],['ASSIGNED','5',''],['PICKED_UP','20',''],['DELIVERED','50','']]);
-- 2. Express, Accra: delivered after 2 h → late
select tests.o12(2, 'express', 'ACC', null, 'DELIVERED', 3000, array[['CONFIRMED','0',''],['ASSIGNED','10',''],['PICKED_UP','40',''],['DELIVERED','120','']], 1);
-- 3. E-commerce Kente Online: delivered same day (16:00) with GHS 100 COD → on time
select tests.o12(3, 'ecommerce', 'ACC', '10000000-0000-0000-0000-000000001201', 'DELIVERED', 2500, array[['CONFIRMED','0',''],['PICKED_UP','120',''],['DELIVERED','360','']], 2, null, 10000);
-- 4. E-commerce Kente Online: failed (recipient unreachable), returned → 50% fee
select tests.o12(4, 'ecommerce', 'ACC', '10000000-0000-0000-0000-000000001201', 'RETURNED', 2500,
                 array[['CONFIRMED','0',''],['PICKED_UP','120',''],['FAILED_ATTEMPT','300','recipient_unreachable'],['RETURNING_TO_SENDER','310',''],['RETURNED','400','']], 2, null, 0, 1250);
-- 5. E-commerce Kente Online: cancelled
select tests.o12(5, 'ecommerce', 'ACC', '10000000-0000-0000-0000-000000001201', 'CANCELLED', 2500, array[['CONFIRMED','0',''],['CANCELLED','30','']], 3);
-- 6. Inter-city Ashanti Gold (Kumasi), hub collection: ready after 30 h → on time (48 h), collected later
select tests.o12(6, 'intercity', 'KSI', '10000000-0000-0000-0000-000000001202', 'COLLECTED', 4000,
                 array[['CONFIRMED','0',''],['PICKED_UP','60',''],['READY_FOR_COLLECTION','1800',''],['COLLECTED','3500','']], 0, 'hub_collection');
-- 7. E-commerce Kente Online, still on the way
select tests.o12(7, 'ecommerce', 'ACC', '10000000-0000-0000-0000-000000001201', 'IN_TRANSIT', 2500, array[['CONFIRMED','0',''],['PICKED_UP','60',''],['IN_TRANSIT','70','']], 6);
-- 8. the week before: one Kente Online delivery (for "vs previous period")
select tests.o12(8, 'ecommerce', 'ACC', '10000000-0000-0000-0000-000000001201', 'DELIVERED', 2500, array[['CONFIRMED','0',''],['DELIVERED','300','']], -7);
alter table orders enable trigger orders_created_event;
-- a draft never becomes a fact
insert into orders (service_type, city_id, pickup_location, dropoff_location, recipient_name, recipient_phone, weight_g, quoted_fee, payer, payment_method)
select 'express', acc, st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography, st_setsrid(st_makepoint(-0.161, 5.6355), 4326)::geography, 'X', '+233240000000', 1000, 100, 'sender', 'cash' from k;

-- =====================================================================
-- 1. Facts
-- =====================================================================
select tests.ok((select count(*) from order_facts) = 8, 'one fact row per booked delivery (drafts excluded)');
select tests.ok((select picked_up_at - booked_at = interval '20 minutes' and delivered_at - picked_up_at = interval '30 minutes' and on_time and outcome = 'delivered'
                 from order_facts where order_id = '30000000-0000-0000-0000-000000000001'), 'express: pickup 20 min, delivery 30 min, on time');
select tests.ok((select not on_time from order_facts where order_id = '30000000-0000-0000-0000-000000000002'), 'express after 2 hours: late');
select tests.ok((select on_time from order_facts where order_id = '30000000-0000-0000-0000-000000000003'), 'e-commerce delivered on its pickup day before 21:00: on time');
select tests.ok((select outcome = 'returned' and failed_attempts = 1 and last_failed_reason = 'recipient_unreachable' and on_time is null
                 from order_facts where order_id = '30000000-0000-0000-0000-000000000004'), 'returned: failure reason kept, no on-time verdict');
select tests.ok((select on_time and ready_at is not null from order_facts where order_id = '30000000-0000-0000-0000-000000000006'), 'hub collection: on time = ready at the hub within 48 h');
select tests.ok((select outcome = 'open' and day = (select d0 + 6 from k) from order_facts where order_id = '30000000-0000-0000-0000-000000000007'), 'in progress: open, booking day in Accra time');
update orders set rider_id = null where id = '30000000-0000-0000-0000-000000000007';
select tests.ok((select rider_id is null from order_facts where order_id = '30000000-0000-0000-0000-000000000007'), 'rider change follows into the facts');
select tests.login('00000000-0000-0000-0000-000000001201');
select tests.ok((select count(*) from order_facts) = 0, 'facts are not readable directly (only through reports)');
select tests.logout();

-- =====================================================================
-- 2. Overview (analyst: all cities)
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001210');
create temp table ov as select analytics_overview(null, (select d0 from k), current_date) r;
grant select on ov to anon, authenticated, service_role;
select tests.ok((select (r -> 'kpis' ->> 'orders')::int = 7 and (r -> 'kpis' ->> 'delivered')::int = 4 and (r -> 'kpis' ->> 'returned')::int = 1
                        and (r -> 'kpis' ->> 'cancelled')::int = 1 and (r -> 'kpis' ->> 'open')::int = 1 from ov), 'counts: 7 orders, 4 delivered, 1 returned, 1 cancelled, 1 open');
select tests.ok((select (r -> 'kpis' ->> 'success_pct')::numeric = 80.0 from ov), 'success rate = delivered / (delivered + returned) = 4/5 = 80%');
select tests.ok((select (r -> 'kpis' ->> 'on_time_pct')::numeric = 75.0 from ov), 'on time = 3 of 4 finished = 75%');
select tests.ok((select (r -> 'kpis' ->> 'revenue')::int = 3000 + 3000 + 2500 + 1250 + 4000 from ov), 'revenue = delivered fees + 50% fee on the return (cancelled and open earn nothing yet)');
select tests.ok((select (r -> 'kpis' ->> 'avg_pickup_min')::int = 30 from ov), 'average Express pickup: (20 + 40) / 2 = 30 min');
select tests.ok((select (r -> 'kpis' ->> 'avg_delivery_min')::int = 117 from ov), 'average pickup→delivery (city services): (30 + 80 + 240) / 3 ≈ 117 min');
select tests.ok((select (r -> 'previous' ->> 'orders')::int = 1 from ov), 'previous 7 days: 1 order (to compare)');
select tests.ok((select jsonb_array_length(r -> 'daily') = 7 and (r -> 'daily' -> 2 ->> 'ecommerce')::int = 2 and (r -> 'daily' -> 0 ->> 'intercity')::int = 1 from ov),
                'one row per day (empty days included), split by service');
select tests.ok((select r -> 'failed_reasons' = '[{"reason": "recipient_unreachable", "count": 1}]'::jsonb from ov), 'failure reasons counted');
select tests.ok((select jsonb_array_length(r -> 'by_city') = 4 and (select (x ->> 'orders')::int from jsonb_array_elements(r -> 'by_city') x where x ->> 'city' = 'Kumasi') = 1 from ov),
                'per city');
select tests.ok((select (select (x ->> 'success_pct')::numeric from jsonb_array_elements(r -> 'by_service') x where x ->> 'service' = 'ecommerce') = 50.0 from ov),
                'per service: e-commerce 1 delivered, 1 returned = 50%');
select tests.ok(((analytics_overview(null, (select d0 from k), current_date, 'express') -> 'kpis' ->> 'orders')::int) = 2, 'filter by service');
select tests.expect_error($$select analytics_overview(null, current_date, current_date - 1)$$, 'period', 'period must make sense');

-- who may see what
select tests.login('00000000-0000-0000-0000-000000001211');
select tests.ok(((analytics_overview(null, (select d0 from k), current_date) -> 'kpis' ->> 'orders')::int) = 6, 'Accra admin: Accra only (6 of 7)');
select tests.expect_error($$select analytics_overview((select ksi from k), (select d0 from k), current_date)$$, 'your city', 'Accra admin can''t open Kumasi');
select tests.login('00000000-0000-0000-0000-000000001212');
select tests.expect_error($$select analytics_overview(null, (select d0 from k), current_date)$$, 'reports are for', 'dispatchers don''t see revenue reports');
select tests.login('00000000-0000-0000-0000-000000001201');
select tests.expect_error($$select analytics_overview(null, (select d0 from k), current_date)$$, 'reports are for', 'vendors don''t see QCS reports');
select tests.login(null);
select tests.expect_error($$select analytics_overview(null, current_date, current_date)$$, 'permission denied', 'nor does the public');
select tests.logout();

-- =====================================================================
-- 3. COD outstanding, riders, vendors, heatmap
-- =====================================================================
insert into cod_collections (order_id, rider_id, vendor_id, city_id, amount, status, collected_at, remit_due_by)
select '30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000001220', '10000000-0000-0000-0000-000000001201', acc, 10000, 'collected', now() - interval '2 days', now() - interval '1 day' from k;
insert into cod_collections (order_id, rider_id, vendor_id, city_id, amount, status, collected_at, remit_due_by, remitted_at)
select '30000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000001220', '10000000-0000-0000-0000-000000001201', acc, 5000, 'remitted', now() - interval '8 days', now() - interval '7 days', now() - interval '7 days' from k;
select tests.login('00000000-0000-0000-0000-000000001210');
select tests.ok((select r ->> 'with_riders' = '10000' and r ->> 'with_riders_overdue' = '10000' and r ->> 'riders_overdue' = '1' and r ->> 'held_by_qcs' = '5000'
                 from (select analytics_overview(null, current_date, current_date) -> 'cod' r) x), 'COD now: GHS 100 overdue with 1 rider, GHS 50 held by QCS for payout');
select tests.logout();

-- rider: online 4 h, busy 1 h on a trip
update riders set is_online = true where id = '00000000-0000-0000-0000-000000001220';
select tests.ok((select count(*) from rider_shifts where ended_at is null) = 1, 'going online opens a shift');
update riders set is_online = false where id = '00000000-0000-0000-0000-000000001220';
select tests.ok((select count(*) from rider_shifts where ended_at is not null) = 1, 'going offline closes it');
update rider_shifts set started_at = now() - interval '5 hours', ended_at = now() - interval '1 hour';
insert into trips (trip_type, status, city_id, rider_id, assigned_at, completed_at)
select 'express', 'COMPLETED', acc, '00000000-0000-0000-0000-000000001220', now() - interval '3 hours', now() - interval '2 hours' from k;
insert into rider_earnings (rider_id, kind, amount, order_id, description) values ('00000000-0000-0000-0000-000000001220', 'delivery', 800, '30000000-0000-0000-0000-000000000001', 'Stop fee');
select tests.login('00000000-0000-0000-0000-000000001211');
select tests.ok((select (r ->> 'online_hours')::numeric = 4.0 and (r ->> 'busy_hours')::numeric = 1.0 and (r ->> 'trips')::int = 1 and (r ->> 'earnings')::int = 800
                        and (r ->> 'delivered')::int = 4 and r ->> 'name' = 'Rider Kojo'
                 from jsonb_array_elements(analytics_riders(null, (select d0 from k), current_date)) r), 'rider this week: 4 deliveries, 4 h online, 1 h busy (25% utilisation), 1 trip, GHS 8 earned');

select tests.ok((select r -> 0 ->> 'name' = 'Kente Online' and (r -> 0 ->> 'orders')::int = 4 and (r -> 0 ->> 'success_pct')::numeric = 50.0
                        and (r -> 0 ->> 'prev_orders')::int = 1 and (r -> 0 ->> 'change_pct')::int = 300 and jsonb_array_length(r) = 1
                 from (select analytics_vendors(null, (select d0 from k), current_date) r) x), 'vendor ranking (Accra admin): Kente Online 4 orders, +300% vs last week');
create temp table hm as select analytics_heatmap(null, (select d0 from k), current_date) r;
grant select on hm to anon, authenticated, service_role;
select tests.ok((select sum((c ->> 'n')::int) = 6 from hm, jsonb_array_elements(r -> 'cells') c), 'heatmap: Accra drop-offs in ~550 m squares');
select tests.ok((select r -> 'zones' -> 0 ->> 'zone' is not null and (r -> 'zones' -> 0 ->> 'orders')::int = 6 from hm), 'and per zone');
select tests.logout();

-- =====================================================================
-- 4. Vendor analytics (client portal)
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001201');
create temp table va as select vendor_analytics('10000000-0000-0000-0000-000000001201', (select d0 from k), current_date) r;
grant select on va to anon, authenticated, service_role;
select tests.ok((select (r -> 'kpis' ->> 'orders')::int = 4 and (r -> 'kpis' ->> 'delivered')::int = 1 and (r -> 'kpis' ->> 'success_pct')::numeric = 50.0 from va), 'vendor: 4 orders, 1 delivered, 50% success');
select tests.ok((select (r -> 'kpis' ->> 'delivery_spend')::int = 3750 and (r -> 'kpis' ->> 'cod_collected')::int = 10000 and (r ->> 'cod_waiting')::int = 15000 from va),
                'owner sees money: spend GHS 37.50 (25 + 12.50 return fee), COD GHS 100 collected, GHS 150 not yet paid out');
select tests.ok((select (r -> 'previous' ->> 'orders')::int = 1 and r -> 'failed_reasons' -> 0 ->> 'reason' = 'recipient_unreachable'
                        and r -> 'top_areas' -> 0 ->> 'area' = 'East Legon / Airport' and jsonb_array_length(r -> 'daily') = 7 from va), 'previous period, failure reasons, top areas, daily');
select tests.expect_error($$select vendor_analytics('10000000-0000-0000-0000-000000001202', (select d0 from k), current_date)$$, 'not your business', 'can''t see another business');
select tests.login('00000000-0000-0000-0000-000000001203');
select tests.ok((select (r -> 'kpis' ->> 'orders')::int = 4 and r -> 'kpis' ->> 'delivery_spend' is null and r ->> 'cod_waiting' is null and not (r ->> 'money')::boolean
                 from (select vendor_analytics('10000000-0000-0000-0000-000000001201', (select d0 from k), current_date) r) x), 'staff without wallet permission: volumes yes, money no');
select tests.logout();

-- =====================================================================
-- 5. Scheduled email reports
-- =====================================================================
select tests.login('00000000-0000-0000-0000-000000001210');
select save_report_subscription('weekly', null, true);
select save_report_subscription('daily', (select acc from k), true);
select tests.expect_error($$select save_report_subscription('weekly', null, true, '00000000-0000-0000-0000-000000001211')$$, 'super admin', 'only a Super Admin sets reports for others');
select tests.login('00000000-0000-0000-0000-000000001212');
select tests.expect_error($$select save_report_subscription('daily', null, true)$$, 'can''t see reports', 'dispatchers can''t subscribe');
select tests.logout();
select tests.login('00000000-0000-0000-0000-000000001210');
select tests.expect_error($$select send_scheduled_reports()$$, 'permission denied', 'only the schedule sends reports');
select tests.service();
create temp table monday as select (current_date - ((extract(isodow from current_date)::int + 6) % 7)) + 7 d;   -- next Monday
grant select on monday to anon, authenticated, service_role;
select tests.ok(send_scheduled_reports((select d from monday)) = 2, 'Monday: daily + weekly reports sent');
select tests.ok(send_scheduled_reports((select d from monday)) = 0, 'not twice on the same day');
select tests.ok(send_scheduled_reports((select d + 1 from monday)) = 1, 'Tuesday: only the daily one');
select tests.logout();
select tests.ok((select count(*) = 3 and bool_and(channel = 'email' and user_id = '00000000-0000-0000-0000-000000001210') from notifications where template = 'analytics_report'), 'emailed to the analyst');
select tests.ok((select payload ->> 'summary' like 'Orders: %Success rate:%Top failure reasons:%COD now:%' and payload ->> 'link' like '%/analytics?from=%'
                 from notifications where template = 'analytics_report' and payload ->> 'frequency' = 'Weekly'), 'report text: orders, success, failures, COD, link to the charts');
select tests.ok((select payload ->> 'summary' like '%By city:%Kumasi%' from notifications where template = 'analytics_report' and payload ->> 'frequency' = 'Weekly'),
                'all-cities report lists each city');
select tests.ok((select payload ->> 'scope' = 'Accra' and payload ->> 'summary' not like '%By city%' from notifications where template = 'analytics_report' and payload ->> 'frequency' = 'Daily' limit 1),
                'city report covers that city');

rollback;
