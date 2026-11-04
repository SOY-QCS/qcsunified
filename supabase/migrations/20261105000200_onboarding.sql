-- =====================================================================
-- QCS Unified — Phase 2: sign-up and onboarding
--   • Vendor sign-up: business name, category, pickup address, ID
--   • Rider application: Ghana Card, licence, vehicle + photos, guarantor, MoMo
--     Status: applicant (filling in) → pending (submitted) → active (approved) / rejected
--   • KYC documents in a private storage bucket
-- =====================================================================

-- Our own database functions can switch on "system" mode for a single step (see submit_rider_application).
-- System mode is a counter, so a database function that switches it on and off
-- inside another one that also needs it doesn't switch it off too early.
create or replace function public._sys(p_delta int) returns void
language sql as $$
  select set_config('qcs.system', greatest(0, coalesce(nullif(current_setting('qcs.system', true), '')::int, 0) + p_delta)::text, true);
$$;
revoke execute on function public._sys(int) from public, anon, authenticated;

create or replace function public.is_trusted() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('qcs.system', true), '')::int, 0) > 0
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'trusted')
         in ('service_role', 'trusted');
$$;

-- Rider documents must point to the rider's own folder in storage.
drop policy rider_docs_upload on public.rider_documents;
create policy rider_docs_upload on public.rider_documents for insert to authenticated
  with check (rider_id = (select auth.uid()) and status = 'pending' and reviewed_by is null
              and split_part(storage_path, '/', 1) = (select auth.uid())::text);

-- ---------- vendor sign-up fields ----------
alter table public.vendors
  add column category                  text,
  add column default_pickup_address_id uuid references public.addresses(id),
  add column id_type                   text check (id_type in ('ghana_card', 'business_registration', 'passport', 'drivers_license')),
  add column id_number                 text,
  add column id_doc_path               text,          -- storage path in the "kyc" bucket
  add column kyc_status                public.review_status not null default 'pending',
  add column kyc_reviewed_by           uuid references public.profiles(id),
  add column kyc_reviewed_at           timestamptz;

-- KYC fields are QCS-controlled once set (the vendor can't approve themselves).
create or replace function public.protect_vendor_kyc() returns trigger language plpgsql as $$
begin
  if public.is_trusted() or public.is_ops_writer(old.city_id) then return new; end if;
  if (new.kyc_status, new.kyc_reviewed_by, new.kyc_reviewed_at) is distinct from (old.kyc_status, old.kyc_reviewed_by, old.kyc_reviewed_at) then
    raise exception 'Only QCS staff can review vendor documents';
  end if;
  return new;
end $$;
create trigger vendors_protect_kyc before update on public.vendors for each row execute function public.protect_vendor_kyc();

-- ---------- rider application fields ----------
alter table public.riders
  add column submitted_at timestamptz,
  add column reviewed_by  uuid references public.profiles(id),
  add column reviewed_at  timestamptz,
  add column review_note  text;

alter table public.vehicles
  add column owner_rider_id uuid references public.riders(id) on delete set null,   -- set when the rider owns it
  add column colour         text,
  add column year           integer check (year between 1980 and 2100);

create table public.rider_guarantors (
  id                uuid primary key default gen_random_uuid(),
  rider_id          uuid not null unique references public.riders(id) on delete cascade,
  full_name         text not null,
  phone             text not null,
  relationship      text not null,
  address           text not null,
  ghana_card_number text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger rider_guarantors_updated before update on public.rider_guarantors for each row execute function public.set_updated_at();
alter table public.rider_guarantors enable row level security;

create policy guarantors_read on public.rider_guarantors for select to authenticated using (
  rider_id = (select auth.uid())
  or exists (select 1 from public.riders r where r.id = rider_guarantors.rider_id and public.is_ops(r.city_id))
);
-- Written through submit_rider_application() only.

-- Riders can see the vehicle they own (in addition to the one assigned to them).
drop policy vehicles_read on public.vehicles;
create policy vehicles_read on public.vehicles for select to authenticated using (
  public.is_ops()
  or owner_rider_id = (select auth.uid())
  or exists (select 1 from public.riders r where r.vehicle_id = vehicles.id and r.id = (select auth.uid()))
);

-- Riders may replace their own documents while still applying (not after approval).
create policy rider_docs_replace on public.rider_documents for delete to authenticated using (
  rider_id = (select auth.uid()) and status = 'pending'
  and exists (select 1 from public.riders r where r.id = rider_documents.rider_id and r.status in ('applicant', 'rejected'))
);

-- Track profile kind for ops staff invited by email.
alter table public.profiles add column invited_by uuid references public.profiles(id);

-- ---------- vendor sign-up ----------
-- One call creates the vendor account, its pickup address and ID details.
-- p = {business_name, category, city_code, contact_phone, contact_email,
--      pickup: {formatted_address, lng, lat, ghana_post_gps, landmark, contact_name, contact_phone},
--      id_type, id_number, id_doc_path, account_type ('vendor'|'corporate')}
create or replace function public.register_vendor(p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  uid uuid := auth.uid();
  v_city uuid;
  v_id uuid;
  a_id uuid;
  pk jsonb := p -> 'pickup';
begin
  if uid is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from public.vendors where owner_id = uid) then
    raise exception 'You already have a business account';
  end if;
  if coalesce(trim(p ->> 'business_name'), '') = '' then raise exception 'Business name is required'; end if;
  if coalesce(trim(p ->> 'category'), '') = '' then raise exception 'Business category is required'; end if;
  if pk is null or pk ->> 'lng' is null or pk ->> 'lat' is null or coalesce(trim(pk ->> 'formatted_address'), '') = '' then
    raise exception 'Pickup address with a map pin is required';
  end if;
  if coalesce(p ->> 'id_type', '') = '' or coalesce(trim(p ->> 'id_number'), '') = '' then
    raise exception 'ID type and number are required';
  end if;
  if coalesce(p ->> 'id_doc_path', '') <> '' and split_part(p ->> 'id_doc_path', '/', 1) <> uid::text then
    raise exception 'ID document must be uploaded to your own folder';
  end if;

  select id into v_city from public.cities where code = upper(p ->> 'city_code') and is_active;
  if v_city is null then raise exception 'Unknown city'; end if;

  insert into public.vendors (owner_id, account_type, business_name, category, city_id, contact_phone, contact_email,
                              id_type, id_number, id_doc_path, crm_stage)
  values (uid, coalesce(p ->> 'account_type', 'vendor')::public.vendor_account_type, trim(p ->> 'business_name'),
          p ->> 'category', v_city, coalesce(p ->> 'contact_phone', (select phone from public.profiles where id = uid)),
          p ->> 'contact_email', p ->> 'id_type', trim(p ->> 'id_number'), nullif(p ->> 'id_doc_path', ''), 'trial')
  returning id into v_id;

  insert into public.addresses (vendor_id, label, contact_name, contact_phone, formatted_address, ghana_post_gps, landmark, location, city_id, zone_id)
  values (v_id, 'Pickup', pk ->> 'contact_name', pk ->> 'contact_phone', pk ->> 'formatted_address',
          nullif(upper(pk ->> 'ghana_post_gps'), ''), pk ->> 'landmark',
          st_setsrid(st_makepoint((pk ->> 'lng')::float8, (pk ->> 'lat')::float8), 4326)::geography, v_city,
          (select z.id from public.zones z where z.city_id = v_city and z.is_active
             and st_intersects(z.area, st_setsrid(st_makepoint((pk ->> 'lng')::float8, (pk ->> 'lat')::float8), 4326)::geography) limit 1))
  returning id into a_id;

  update public.vendors set default_pickup_address_id = a_id where id = v_id;
  update public.profiles set city_id = coalesce(city_id, v_city) where id = uid;
  return v_id;
end $$;

-- ---------- rider application ----------
-- Saves the whole form and submits it for review. Documents are uploaded first (rider_documents rows).
-- p = {full_name, city_code, rider_type ('fleet'|'commission'),
--      vehicle: {type, plate_number, make_model, colour, year},
--      guarantor: {full_name, phone, relationship, address, ghana_card_number},
--      momo: {number, network}}
create or replace function public.submit_rider_application(p jsonb) returns public.rider_status
language plpgsql security definer set search_path = public, extensions as $$
declare
  uid uuid := auth.uid();
  r public.riders;
  v_city uuid;
  veh uuid;
  g jsonb := p -> 'guarantor';
  vh jsonb := p -> 'vehicle';
  missing text[] := '{}';
  had_rider boolean;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  select id into v_city from public.cities where code = upper(p ->> 'city_code') and is_active;
  if v_city is null then raise exception 'Unknown city'; end if;

  select * into r from public.riders where id = uid for update;
  had_rider := found;
  if had_rider and r.status in ('active', 'suspended', 'offboarded', 'pending') then
    raise exception 'Your application cannot be changed now (status: %)', r.status;
  end if;

  -- required fields
  if coalesce(trim(p ->> 'full_name'), '') = '' then missing := array_append(missing, 'full name'::text); end if;
  if vh is null or coalesce(vh ->> 'type', '') = '' then missing := array_append(missing, 'vehicle type'::text); end if;
  if (vh ->> 'type') in ('bike', 'tricycle', 'car', 'van') and coalesce(trim(vh ->> 'plate_number'), '') = '' then missing := array_append(missing, 'plate number'::text); end if;
  if g is null or coalesce(trim(g ->> 'full_name'), '') = '' or coalesce(trim(g ->> 'phone'), '') = ''
     or coalesce(trim(g ->> 'relationship'), '') = '' or coalesce(trim(g ->> 'address'), '') = '' then
    missing := array_append(missing, 'guarantor details'::text);
  end if;
  if coalesce(p #>> '{momo,number}', '') !~ '^\+233\d{9}$' then missing := array_append(missing, 'MoMo number (+233…)'::text); end if;
  if cardinality(missing) > 0 then raise exception 'Missing: %', array_to_string(missing, ', '); end if;

  update public.profiles set full_name = trim(p ->> 'full_name'), city_id = v_city where id = uid;

  if not had_rider then
    insert into public.riders (id, rider_type, city_id) values (uid, coalesce(p ->> 'rider_type', 'commission')::public.rider_type, v_city);
  end if;

  -- vehicle owned by the rider
  select id into veh from public.vehicles where owner_rider_id = uid limit 1;
  if veh is null then
    insert into public.vehicles (owned_by_qcs, owner_rider_id, type, plate_number, make_model, colour, year, max_weight_g)
    values (false, uid, (vh ->> 'type')::public.vehicle_type, nullif(upper(trim(vh ->> 'plate_number')), ''), vh ->> 'make_model',
            vh ->> 'colour', nullif(vh ->> 'year', '')::int,
            case (vh ->> 'type') when 'car' then 100000 when 'van' then 500000 when 'tricycle' then 150000 else 15000 end)
    returning id into veh;
  else
    update public.vehicles set type = (vh ->> 'type')::public.vehicle_type, plate_number = nullif(upper(trim(vh ->> 'plate_number')), ''),
           make_model = vh ->> 'make_model', colour = vh ->> 'colour', year = nullif(vh ->> 'year', '')::int
     where id = veh;
  end if;

  insert into public.rider_guarantors (rider_id, full_name, phone, relationship, address, ghana_card_number)
  values (uid, trim(g ->> 'full_name'), trim(g ->> 'phone'), trim(g ->> 'relationship'), trim(g ->> 'address'), g ->> 'ghana_card_number')
  on conflict (rider_id) do update set full_name = excluded.full_name, phone = excluded.phone, relationship = excluded.relationship,
                                       address = excluded.address, ghana_card_number = excluded.ghana_card_number;

  -- required documents must already be uploaded
  missing := '{}';
  if not exists (select 1 from public.rider_documents where rider_id = uid and doc_type = 'ghana_card') then missing := array_append(missing, 'Ghana Card'::text); end if;
  if (vh ->> 'type') <> 'ebike' and not exists (select 1 from public.rider_documents where rider_id = uid and doc_type = 'drivers_license') then missing := array_append(missing, 'driver''s licence'::text); end if;
  if not exists (select 1 from public.rider_documents where rider_id = uid and doc_type = 'vehicle_photo') then missing := array_append(missing, 'vehicle photo'::text); end if;
  if not exists (select 1 from public.rider_documents where rider_id = uid and doc_type = 'photo') then missing := array_append(missing, 'your photo'::text); end if;
  if cardinality(missing) > 0 then raise exception 'Please upload: %', array_to_string(missing, ', '); end if;

  perform public._sys(1);   -- this function is allowed to set the status
  update public.riders
     set status = 'pending', submitted_at = now(), city_id = v_city, vehicle_id = veh,
         rider_type = coalesce(p ->> 'rider_type', rider_type::text)::public.rider_type,
         payout_momo_number = p #>> '{momo,number}', payout_momo_network = p #>> '{momo,network}',
         review_note = null
   where id = uid;
  perform public._sys(-1);
  return 'pending';
end $$;

-- ---------- admin review ----------
-- Approve or reject a rider application. Approving grants the rider role for their city.
create or replace function public.review_rider_application(
  p_rider_id uuid, p_approve boolean, p_note text default null,
  p_rider_type public.rider_type default null, p_commission_rate_bp integer default null
) returns public.rider_status
language plpgsql security definer set search_path = public, extensions as $$
declare r public.riders; new_status public.rider_status;
begin
  select * into r from public.riders where id = p_rider_id for update;
  if not found then raise exception 'Rider not found'; end if;
  if not (public.is_trusted() or public.is_admin(r.city_id)) then
    raise exception 'Only a Super Admin or the City Admin can review rider applications';
  end if;
  if r.status <> 'pending' then raise exception 'This application is not waiting for review (status: %)', r.status; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'Give a reason when rejecting'; end if;

  new_status := case when p_approve then 'active' else 'rejected' end;
  update public.riders
     set status = new_status,
         rider_type = coalesce(p_rider_type, rider_type),
         commission_rate_bp = case when coalesce(p_rider_type, rider_type) = 'commission' then coalesce(p_commission_rate_bp, commission_rate_bp, 2000) else null end,
         reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
   where id = r.id;

  update public.rider_documents
     set status = case when p_approve then 'approved' else status end, reviewed_by = auth.uid(), reviewed_at = now()
   where rider_id = r.id and status = 'pending';

  if p_approve then
    insert into public.user_roles (user_id, role, city_id, granted_by)
    values (r.id, case when coalesce(p_rider_type, r.rider_type) = 'fleet' then 'fleet_rider' else 'commission_rider' end::public.app_role,
            r.city_id, auth.uid())
    on conflict do nothing;
  end if;

  insert into public.notifications (user_id, channel, template, payload)
  values (r.id, 'sms', case when p_approve then 'rider_approved' else 'rider_rejected' end, jsonb_build_object('note', p_note));
  return new_status;
end $$;

-- Vendor KYC review (Super Admin / City Admin / Support can review).
create or replace function public.review_vendor_kyc(p_vendor_id uuid, p_approve boolean, p_note text default null)
returns public.review_status language plpgsql security definer set search_path = public, extensions as $$
declare v public.vendors; s public.review_status;
begin
  select * into v from public.vendors where id = p_vendor_id for update;
  if not found then raise exception 'Vendor not found'; end if;
  if not (public.is_trusted() or public.is_admin(v.city_id) or public.has_role(array['support']::public.app_role[], v.city_id)) then
    raise exception 'Not allowed to review this vendor';
  end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'Give a reason when rejecting'; end if;
  s := case when p_approve then 'approved' else 'rejected' end;
  update public.vendors set kyc_status = s, kyc_reviewed_by = auth.uid(), kyc_reviewed_at = now(),
         notes = case when p_note is null then notes else concat_ws(E'\n', notes, 'KYC: ' || p_note) end
   where id = v.id;
  return s;
end $$;

-- What the apps need to know about the signed-in user, in one call.
create or replace function public.my_account() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) - 'invited_by' from public.profiles p where p.id = auth.uid()),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('role', ur.role, 'city_id', ur.city_id, 'hub_id', ur.hub_id,
                                                           'city_code', c.code, 'hub_code', h.code))
                       from public.user_roles ur left join public.cities c on c.id = ur.city_id left join public.hubs h on h.id = ur.hub_id
                       where ur.user_id = auth.uid()), '[]'::jsonb),
    'vendor', (select jsonb_build_object('id', v.id, 'business_name', v.business_name, 'kyc_status', v.kyc_status, 'account_type', v.account_type)
               from public.vendors v where v.id in (select public.my_vendor_ids()) order by (v.owner_id = auth.uid()) desc limit 1),
    'rider', (select jsonb_build_object('status', r.status, 'rider_type', r.rider_type, 'review_note', r.review_note, 'city_id', r.city_id)
              from public.riders r where r.id = auth.uid())
  );
$$;

revoke execute on function public.register_vendor(jsonb) from public, anon;
revoke execute on function public.submit_rider_application(jsonb) from public, anon;
revoke execute on function public.review_rider_application(uuid, boolean, text, public.rider_type, integer) from public, anon;
revoke execute on function public.review_vendor_kyc(uuid, boolean, text) from public, anon;
revoke execute on function public.my_account() from public, anon;
grant execute on function public.register_vendor(jsonb), public.submit_rider_application(jsonb),
  public.review_rider_application(uuid, boolean, text, public.rider_type, integer),
  public.review_vendor_kyc(uuid, boolean, text), public.my_account() to authenticated;

-- ---------- private storage for ID documents and photos ----------
-- Files live at kyc/<user id>/<file>. Users can upload/read only their own folder; ops can read all.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc', 'kyc', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy kyc_upload_own on storage.objects for insert to authenticated
  with check (bucket_id = 'kyc' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy kyc_read_own on storage.objects for select to authenticated
  using (bucket_id = 'kyc' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_ops()));
create policy kyc_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'kyc' and (storage.foldername(name))[1] = (select auth.uid())::text);
