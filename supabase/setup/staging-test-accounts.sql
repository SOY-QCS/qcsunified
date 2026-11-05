-- =====================================================================
-- STAGING ONLY: ready-made test accounts, one for every kind of user.
--
-- Normally run by the Deploy button (tick "Add test accounts"; staging only), which puts a fresh
-- random password in place of the placeholder below and shows it in the run's summary.
-- By hand: Supabase → SQL editor → paste this file → replace the placeholder with a password
-- of at least 12 characters → Run. Safe to run again: nothing is duplicated, and the staff
-- password is reset to the new one.
--
-- Dashboard staff sign in with email + that password:
--   test.superadmin / test.cityadmin / test.dispatcher / test.hubmanager / test.finance /
--   test.support / test.analyst  @test.qcsghana.com   (everyone except Super Admin works in Accra)
-- Phone accounts sign in with code 123456 once these numbers are added under Supabase →
-- Authentication → Sign In / Providers → Phone → "Test phone numbers and OTPs"
-- (233200000001=123456, 233200000002=123456, … up to 233200000008):
--   020 000 0001  customer (QCS app)            020 000 0005  corporate account (portal)
--   020 000 0002  QCS fleet rider, Accra         020 000 0006  commission rider, Accra
--   020 000 0003  hub handler, Accra hub         020 000 0007  QCS fleet rider, Kumasi
--   020 000 0004  vendor owner "Test Shop"       020 000 0008  hub handler, Kumasi hub
-- =====================================================================
do $staging$
declare
  pw   text := '__TEST_PASSWORD__';
  acc  uuid := (select id from public.cities where code = 'ACC');
  ksi  uuid := (select id from public.cities where code = 'KSI');
  acc_hub uuid := (select id from public.hubs where city_id = (select id from public.cities where code = 'ACC') order by created_at limit 1);
  ksi_hub uuid := (select id from public.hubs where city_id = (select id from public.cities where code = 'KSI') order by created_at limit 1);
  u    record;
  uid  uuid;
  shop uuid;
  addr uuid;
begin
  -- safety checks
  if pw like '\_\_%' or length(pw) < 12 then
    raise exception 'Put a test password (12+ characters) in place of __TEST_PASSWORD__ first.';
  end if;
  if (select count(*) from public.orders where status = 'DELIVERED') > 100 then
    raise exception 'This database already has real deliveries. Test accounts are for STAGING only. Nothing was changed.';
  end if;
  if acc is null or ksi is null or acc_hub is null or ksi_hub is null then
    raise exception 'Accra/Kumasi or their hubs are missing: run the Deploy button first (it loads the starting data).';
  end if;

  -- 1. Dashboard staff: email + password
  for u in select * from (values
      ('superadmin', 'super_admin', 'Test Super Admin'), ('cityadmin', 'city_admin', 'Test City Admin'),
      ('dispatcher', 'dispatcher',  'Test Dispatcher'),  ('hubmanager', 'hub_manager', 'Test Hub Manager'),
      ('finance',    'finance',     'Test Finance'),     ('support', 'support', 'Test Support'),
      ('analyst',    'analyst',     'Test Analyst')) v(handle, role, name)
  loop
    select id into uid from auth.users where email = 'test.' || u.handle || '@test.qcsghana.com';
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                              confirmation_token, email_change, email_change_token_new, recovery_token)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
              'test.' || u.handle || '@test.qcsghana.com', extensions.crypt(pw, extensions.gen_salt('bf')), now(),
              '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', u.name), now(), now(), '', '', '', '');
      insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), uid, uid::text, 'email',
              jsonb_build_object('sub', uid::text, 'email', 'test.' || u.handle || '@test.qcsghana.com', 'email_verified', true), now(), now(), now());
    else
      update auth.users set encrypted_password = extensions.crypt(pw, extensions.gen_salt('bf')), updated_at = now() where id = uid;
    end if;
    update public.profiles set full_name = u.name, city_id = acc where id = uid;
    insert into public.user_roles (user_id, role, city_id, hub_id)
    values (uid, u.role::public.app_role, case when u.role = 'super_admin' then null else acc end,
            case when u.role = 'hub_manager' then acc_hub end)
    on conflict do nothing;
  end loop;

  -- 2. Phone accounts (code 123456 via Supabase's test numbers)
  for u in select * from (values
      ('233200000001', 'Ama Test (customer)',          'customer',   'ACC'),
      ('233200000002', 'Kojo Test (fleet rider)',      'fleet',      'ACC'),
      ('233200000003', 'Esi Test (hub handler)',       'hub',        'ACC'),
      ('233200000004', 'Efua Test (Test Shop owner)',  'vendor',     'ACC'),
      ('233200000005', 'Kwame Test (corporate)',       'corporate',  'ACC'),
      ('233200000006', 'Yaw Test (commission rider)',  'commission', 'ACC'),
      ('233200000007', 'Kofi Test (Kumasi rider)',     'fleet',      'KSI'),
      ('233200000008', 'Abena Test (Kumasi hub)',      'hub',        'KSI')) v(phone, name, kind, city)
  loop
    select id into uid from auth.users where phone in (u.phone, '+' || u.phone) limit 1;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, encrypted_password,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                              confirmation_token, email_change, email_change_token_new, recovery_token)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', u.phone, now(), '',
              '{"provider":"phone","providers":["phone"]}', jsonb_build_object('full_name', u.name), now(), now(), '', '', '', '');
      insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), uid, uid::text, 'phone',
              jsonb_build_object('sub', uid::text, 'phone', u.phone, 'phone_verified', true), now(), now(), now());
    end if;
    update public.profiles set full_name = u.name, city_id = (select id from public.cities where code = u.city) where id = uid;

    if u.kind in ('fleet', 'commission') then
      insert into public.vehicles (id, type, plate_number)
      values (uid, 'bike', 'TEST-' || right(u.phone, 4)) on conflict (id) do nothing;
      insert into public.riders (id, rider_type, status, city_id, vehicle_id, commission_rate_bp)
      values (uid, u.kind::public.rider_type, 'active', (select id from public.cities where code = u.city), uid,
              case when u.kind = 'commission' then 2000 end)
      on conflict (id) do nothing;
      insert into public.user_roles (user_id, role, city_id)
      values (uid, (u.kind || '_rider')::public.app_role, (select id from public.cities where code = u.city)) on conflict do nothing;
    elsif u.kind = 'hub' then
      insert into public.user_roles (user_id, role, city_id, hub_id)
      values (uid, 'hub_handler', (select id from public.cities where code = u.city), case when u.city = 'KSI' then ksi_hub else acc_hub end)
      on conflict do nothing;
    elsif u.kind in ('vendor', 'corporate') then
      select id into shop from public.vendors where owner_id = uid;
      if shop is null then
        insert into public.vendors (owner_id, account_type, business_name, city_id, contact_phone, kyc_status)
        values (uid, u.kind::public.vendor_account_type, case when u.kind = 'vendor' then 'Test Shop' else 'Test Corporate Ltd' end,
                acc, '+' || u.phone, 'approved')
        returning id into shop;
        insert into public.addresses (vendor_id, label, contact_name, contact_phone, formatted_address, location, city_id)
        values (shop, 'Shop', split_part(u.name, ' ', 1), '+' || u.phone, 'Oxford Street, Osu, Accra',
                st_setsrid(st_makepoint(-0.178, 5.556), 4326)::geography, acc)
        returning id into addr;
        update public.vendors set default_pickup_address_id = addr where id = shop;
      end if;
      insert into public.user_roles (user_id, role)
      values (uid, case when u.kind = 'vendor' then 'vendor_owner' else 'corporate' end::public.app_role) on conflict do nothing;
    end if;
  end loop;

  raise notice 'Test accounts ready.';
end $staging$;
