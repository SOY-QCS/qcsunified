-- =====================================================================
-- Phase 2 tests: vendor sign-up, rider application + review, staff roles, KYC storage.
-- =====================================================================
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone, email) values
  ('00000000-0000-0000-0000-000000000101', '+233200000101', null),            -- new vendor
  ('00000000-0000-0000-0000-000000000102', '+233200000102', null),            -- new rider
  ('00000000-0000-0000-0000-000000000103', null, 'admin@qcs.test'),           -- Accra admin
  ('00000000-0000-0000-0000-000000000104', null, 'kadmin@qcs.test'),          -- Kumasi admin
  ('00000000-0000-0000-0000-000000000105', '+233200000105', null);            -- nosy customer
insert into user_roles (user_id, role, city_id)
select '00000000-0000-0000-0000-000000000103', 'city_admin', id from cities where code = 'ACC';
insert into user_roles (user_id, role, city_id)
select '00000000-0000-0000-0000-000000000104', 'city_admin', id from cities where code = 'KSI';

-- ---------- vendor sign-up ----------
select tests.login('00000000-0000-0000-0000-000000000101');
select tests.expect_error($$select register_vendor(jsonb_build_object('business_name', 'Kente Hub', 'category', 'fashion', 'city_code', 'ACC', 'id_type', 'ghana_card', 'id_number', 'GHA-1',
  'pickup', jsonb_build_object('formatted_address', 'Osu', 'lng', -0.178, 'lat', 5.556)))$$, 'terms', 'business sign-up needs the Terms & Conditions accepted');
select tests.expect_error($$update profiles set terms_accepted_at = now() where id = auth.uid()$$, 'accept_terms', 'terms acceptance cannot be faked');
select tests.ok(accept_terms() = '2026-11', 'client accepts the current Terms & Conditions');
select tests.ok((select terms_accepted_at is not null and terms_version = '2026-11' from profiles where id = auth.uid()), 'acceptance time and version recorded');
select tests.expect_error($$select register_vendor('{"business_name":"","category":"fashion","city_code":"ACC"}')$$, 'business name', 'business name required');
select tests.expect_error($$select register_vendor('{"business_name":"Kente Hub","category":"fashion","city_code":"ACC","id_type":"ghana_card","id_number":"GHA-1"}')$$, 'pickup address', 'pickup pin required');
select tests.expect_error($$select register_vendor('{"business_name":"Kente Hub","category":"fashion","city_code":"ACC","id_type":"ghana_card","id_number":"GHA-1","id_doc_path":"someone-else/id.jpg","pickup":{"formatted_address":"Osu","lng":-0.178,"lat":5.556}}')$$, 'own folder', 'ID file must be in own folder');
select register_vendor(jsonb_build_object(
  'business_name', 'Kente Hub', 'category', 'fashion', 'city_code', 'ACC',
  'id_type', 'ghana_card', 'id_number', 'GHA-123456789-0', 'id_doc_path', '00000000-0000-0000-0000-000000000101/ghana-card.jpg',
  'pickup', jsonb_build_object('formatted_address', 'Oxford St, Osu', 'lng', -0.178, 'lat', 5.556, 'ghana_post_gps', 'ga-123-4567', 'landmark', 'Near Koala')));
select tests.ok((select count(*) from vendors where owner_id = '00000000-0000-0000-0000-000000000101' and kyc_status = 'pending' and crm_stage = 'trial') = 1, 'vendor created as trial, ID pending review');
select tests.ok((select a.zone_id = (select id from zones where code = 'ACC-CEN') and a.ghana_post_gps = 'GA-123-4567'
                 from vendors v join addresses a on a.id = v.default_pickup_address_id where v.owner_id = '00000000-0000-0000-0000-000000000101'),
                'pickup address saved, matched to the Osu zone, GPS code tidied');
select tests.ok((select my_account() -> 'vendor' ->> 'business_name') = 'Kente Hub', 'my_account() returns the vendor');
select tests.ok(exists (select 1 from jsonb_array_elements(my_account() -> 'roles') r where r ->> 'role' = 'vendor_owner'), 'vendor_owner role granted');
select tests.expect_error($$select register_vendor('{"business_name":"Second","category":"x","city_code":"ACC"}')$$, 'already have', 'one business account per owner');
select tests.expect_error($$update vendors set kyc_status = 'approved' where owner_id = '00000000-0000-0000-0000-000000000101'$$, 'only qcs staff', 'vendor cannot approve their own ID');

select tests.login('00000000-0000-0000-0000-000000000103');
select review_vendor_kyc((select id from vendors where business_name = 'Kente Hub'), true);
select tests.ok((select kyc_status = 'approved' from vendors where business_name = 'Kente Hub'), 'Accra admin approves vendor ID');

-- ---------- rider application ----------
select tests.login('00000000-0000-0000-0000-000000000102');
create temp table app as select jsonb_build_object(
  'full_name', 'Kwame Mensah', 'city_code', 'ACC', 'rider_type', 'commission',
  'vehicle', jsonb_build_object('type', 'bike', 'plate_number', 'gr 1234-24', 'make_model', 'Haojue 125', 'colour', 'Red', 'year', 2022),
  'guarantor', jsonb_build_object('full_name', 'Akosua Mensah', 'phone', '+233244444444', 'relationship', 'Sister', 'address', 'Dome'),
  'momo', jsonb_build_object('number', '+233244000102', 'network', 'MTN')) as p;
grant select on app to authenticated;
-- step 1 of the app: start the application (whatever the app sends, it starts as applicant)
insert into riders (id, rider_type, city_id, status) select '00000000-0000-0000-0000-000000000102', 'commission', id, 'active' from cities where code = 'ACC';

select tests.expect_error($$select submit_rider_application(p - 'guarantor') from app$$, 'guarantor', 'guarantor required');
select tests.expect_error($$select submit_rider_application(jsonb_set(p, '{momo,number}', '"0244"')) from app$$, 'momo', 'MoMo number must be +233 format');
select tests.expect_error($$select submit_rider_application(p) from app$$, 'please upload', 'documents required before submitting');
select tests.ok((select status = 'applicant' from riders where id = '00000000-0000-0000-0000-000000000102'), 'unfinished application kept as applicant');

select tests.expect_error($$insert into rider_documents (rider_id, doc_type, storage_path) values ('00000000-0000-0000-0000-000000000102', 'ghana_card', 'other-user/card.jpg')$$, 'row-level security', 'document path must be in own folder');
insert into rider_documents (rider_id, doc_type, storage_path, number) values
  ('00000000-0000-0000-0000-000000000102', 'ghana_card',     '00000000-0000-0000-0000-000000000102/ghana-card.jpg', 'GHA-987654321-0'),
  ('00000000-0000-0000-0000-000000000102', 'drivers_license','00000000-0000-0000-0000-000000000102/licence.jpg', 'DL-55'),
  ('00000000-0000-0000-0000-000000000102', 'vehicle_photo',  '00000000-0000-0000-0000-000000000102/bike.jpg', null),
  ('00000000-0000-0000-0000-000000000102', 'photo',          '00000000-0000-0000-0000-000000000102/selfie.jpg', null);
select tests.ok((select submit_rider_application(p) from app) = 'pending', 'complete application submitted → Pending');
select tests.ok((select status = 'pending' and payout_momo_number = '+233244000102' and vehicle_id is not null from riders where id = '00000000-0000-0000-0000-000000000102'), 'MoMo and vehicle saved');
select tests.ok((select plate_number = 'GR 1234-24' from vehicles where owner_rider_id = '00000000-0000-0000-0000-000000000102'), 'rider sees their own vehicle, plate tidied');
select tests.ok((select count(*) from rider_guarantors) = 1, 'rider sees their guarantor');
select tests.expect_error($$select submit_rider_application(p) from app$$, 'cannot be changed', 'cannot edit while under review');
select tests.expect_error($$select review_rider_application('00000000-0000-0000-0000-000000000102', true)$$, 'only a super admin', 'rider cannot approve themselves');
select tests.expect_error($$update riders set status = 'active' where id = '00000000-0000-0000-0000-000000000102'$$, 'only qcs staff', 'rider cannot set themselves active');

select tests.login('00000000-0000-0000-0000-000000000105');
select tests.ok((select count(*) from riders) = 0 and (select count(*) from rider_guarantors) = 0, 'other users cannot see rider applications');

select tests.login('00000000-0000-0000-0000-000000000104');  -- Kumasi admin
select tests.expect_error($$select review_rider_application('00000000-0000-0000-0000-000000000102', true)$$, 'only a super admin', 'Kumasi admin cannot review an Accra rider');

select tests.login('00000000-0000-0000-0000-000000000103');  -- Accra admin
select tests.ok((select count(*) from riders where status = 'pending') = 1, 'Accra admin sees the pending application');
select tests.expect_error($$select review_rider_application('00000000-0000-0000-0000-000000000102', false)$$, 'reason', 'rejection needs a reason');
select review_rider_application('00000000-0000-0000-0000-000000000102', false, 'Licence photo is blurry');

select tests.login('00000000-0000-0000-0000-000000000102');
select tests.ok((my_account() -> 'rider' ->> 'status') = 'rejected' and (my_account() -> 'rider' ->> 'review_note') = 'Licence photo is blurry', 'rider sees rejection and reason');
delete from rider_documents where doc_type = 'drivers_license';
insert into rider_documents (rider_id, doc_type, storage_path) values ('00000000-0000-0000-0000-000000000102', 'drivers_license', '00000000-0000-0000-0000-000000000102/licence-2.jpg');
select tests.ok((select submit_rider_application(p) from app) = 'pending', 'rejected rider fixes the document and resubmits');

select tests.login('00000000-0000-0000-0000-000000000103');
select review_rider_application('00000000-0000-0000-0000-000000000102', true, null, 'commission', 2000);
select tests.ok((select status = 'active' and commission_rate_bp = 2000 and reviewed_by = '00000000-0000-0000-0000-000000000103' from riders where id = '00000000-0000-0000-0000-000000000102'), 'approved: active, 20% commission, reviewer recorded');
select tests.ok(exists (select 1 from user_roles where user_id = '00000000-0000-0000-0000-000000000102' and role = 'commission_rider'), 'approval grants the rider role for their city');
select tests.ok((select count(*) from rider_documents where rider_id = '00000000-0000-0000-0000-000000000102' and status = 'approved') = 4, 'documents marked approved');
select tests.logout();
select tests.ok((select count(*) from audit_log where table_name = 'riders' and record_id = '00000000-0000-0000-0000-000000000102' and after ->> 'status' = 'active') = 1, 'approval written to audit log');
select tests.ok((select count(*) from notifications where user_id = '00000000-0000-0000-0000-000000000102') = 2, 'rider notified of rejection and approval');

select tests.login('00000000-0000-0000-0000-000000000102');
select tests.ok(tests.rows($q$delete from rider_documents$q$) = 0, 'approved documents cannot be deleted by the rider');

-- ---------- KYC storage ----------
select tests.login('00000000-0000-0000-0000-000000000102');
insert into storage.objects (bucket_id, name) values ('kyc', '00000000-0000-0000-0000-000000000102/selfie.jpg');
select tests.expect_error($$insert into storage.objects (bucket_id, name) values ('kyc', '00000000-0000-0000-0000-000000000101/hack.jpg')$$, 'row-level security', 'cannot upload into someone else''s folder');
select tests.login('00000000-0000-0000-0000-000000000105');
select tests.ok((select count(*) from storage.objects) = 0, 'other users cannot see KYC files');
select tests.login('00000000-0000-0000-0000-000000000103');
select tests.ok((select count(*) from storage.objects where bucket_id = 'kyc') = 1, 'ops can view KYC files');
select tests.login(null);
select tests.ok((select count(*) from storage.objects) = 0, 'anonymous visitors see no KYC files');

select tests.logout();
rollback;
