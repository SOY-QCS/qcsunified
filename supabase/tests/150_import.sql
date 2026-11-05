-- =====================================================================
-- Phase 13 tests: importing existing clients and riders (tools/import → import_client / import_rider).
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

-- logins as the Supabase admin API creates them (phone, name)
insert into auth.users (id, phone, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000001501', '233241500001', '{"full_name":"Ama Owusu"}'),
  ('00000000-0000-0000-0000-000000001502', '233201500002', '{"full_name":"Kofi Mensah"}'),
  ('00000000-0000-0000-0000-000000001503', '233551500003', '{"full_name":"Esi Boateng"}'),
  ('00000000-0000-0000-0000-000000001504', '233244500004', '{"full_name":"Yaw Asante"}'),
  ('00000000-0000-0000-0000-000000001505', '233277500005', '{"full_name":"Kwame Ofori"}'),
  ('00000000-0000-0000-0000-000000001506', '233509500006', '{"full_name":"Abena Sarpong"}');

-- only the server may import
select tests.login('00000000-0000-0000-0000-000000001501');
select tests.expect_error($$select public.import_client('00000000-0000-0000-0000-000000001501', '{}')$$, 'permission denied', 'apps cannot call the import');
select tests.login(null);
select tests.expect_error($$select public.import_rider('00000000-0000-0000-0000-000000001504', '{}')$$, 'permission denied', 'visitors cannot call the import');
select tests.service();

-- clients
select public.import_client('00000000-0000-0000-0000-000000001501', '{"name":"Ama Owusu","email":"AMA@Example.com","city":"ACC","type":"individual","marketing_opt_in":true,"source":"old-clients.csv"}');
select public.import_client('00000000-0000-0000-0000-000000001502', '{"name":"Kofi Mensah","email":"kofi@kentehub.com","city":"ACC","type":"vendor","business_name":"Kente Hub","tags":["fashion","instagram"],"notes":"20+ a week","momo_number":"+233201500002","momo_network":"Telecel","cod_payout":"daily","source":"old-clients.csv"}');
select public.import_client('00000000-0000-0000-0000-000000001503', '{"name":"Esi Boateng","city":"KSI","type":"corporate","business_name":"Gold Fields Logistics","source":"old-clients.csv"}');
select tests.expect_error($$select public.import_client('00000000-0000-0000-0000-000000001501', '{"city":"XYZ"}')$$, 'unknown city', 'unknown city refused');
select tests.expect_error($$select public.import_client(gen_random_uuid(), '{}')$$, 'login not found', 'needs the login first');
select tests.logout();

select tests.ok((select email = 'ama@example.com' and marketing_opt_in and imported_at is not null and city_id = (select id from cities where code = 'ACC') and terms_accepted_at is null
                 from profiles where id = '00000000-0000-0000-0000-000000001501'), 'individual: details saved, marked imported, terms NOT accepted for them');
select tests.ok((select business_name = 'Kente Hub' and account_type = 'vendor' and tags = '{fashion,instagram}' and payout_momo_network = 'Telecel'
                        and cod_payout_schedule = 'daily' and crm_stage = 'active' and contact_phone = '233201500002'
                 from vendors where owner_id = '00000000-0000-0000-0000-000000001502'), 'vendor created with payout details and tags');
select tests.ok(exists (select 1 from user_roles where user_id = '00000000-0000-0000-0000-000000001502' and role = 'vendor_owner'), 'vendor owner role given');
select tests.ok(exists (select 1 from wallets w join vendors v on v.id = w.owner_id where v.owner_id = '00000000-0000-0000-0000-000000001502'), 'vendor wallet created');
select tests.ok(exists (select 1 from user_roles where user_id = '00000000-0000-0000-0000-000000001503' and role = 'corporate'), 'corporate account role given');
select tests.ok((select count(*) from audit_log where table_name = 'vendors' and reason = 'Imported from old-clients.csv') = 2, 'imports are in the audit log');

-- riders
select tests.service();
select public.import_rider('00000000-0000-0000-0000-000000001504', '{"name":"Yaw Asante","city":"ACC","rider_type":"fleet","status":"active","vehicle_type":"bike","plate":"m-24-gr 1234","make_model":"Haojue 125","momo_number":"+233244500004","momo_network":"MTN","source":"riders.csv"}');
select public.import_rider('00000000-0000-0000-0000-000000001505', '{"name":"Kwame Ofori","city":"KSI","rider_type":"commission","status":"active","vehicle_type":"bike","commission_pct":15,"source":"riders.csv"}');
select public.import_rider('00000000-0000-0000-0000-000000001506', '{"name":"Abena Sarpong","city":"TKD","rider_type":"fleet","status":"pending","vehicle_type":"ebike","source":"riders.csv"}');
select tests.expect_error($$select public.import_rider('00000000-0000-0000-0000-000000001501', '{"name":"x"}')$$, 'unknown city', 'riders need a city');
select tests.logout();

select tests.ok((select r.status = 'active' and r.rider_type = 'fleet' and v.plate_number = 'M-24-GR 1234' and v.owned_by_qcs and r.payout_momo_network = 'MTN'
                        and r.commission_rate_bp is null and r.rating = 5 and not r.is_online
                 from riders r join vehicles v on v.id = r.vehicle_id where r.id = '00000000-0000-0000-0000-000000001504'), 'fleet rider: active, QCS bike, MoMo for pay');
select tests.ok((select commission_rate_bp = 1500 and not v.owned_by_qcs and v.owner_rider_id = r.id from riders r join vehicles v on v.id = r.vehicle_id
                 where r.id = '00000000-0000-0000-0000-000000001505'), 'independent rider: 15% commission, own bike');
select tests.ok((select array_agg(role::text order by role::text) from user_roles where user_id = '00000000-0000-0000-0000-000000001504') = array['customer', 'fleet_rider']
                and exists (select 1 from user_roles where user_id = '00000000-0000-0000-0000-000000001505' and role = 'commission_rider'), 'active riders can use the Rider app straight away');
select tests.ok((select status = 'pending' from riders where id = '00000000-0000-0000-0000-000000001506')
                and not exists (select 1 from user_roles where user_id = '00000000-0000-0000-0000-000000001506' and role in ('fleet_rider', 'commission_rider')),
                'pending rider waits for review in Rider applications');
select tests.ok(exists (select 1 from wallets where owner_type = 'rider' and owner_id = '00000000-0000-0000-0000-000000001504'), 'rider earnings wallet created');

rollback;
