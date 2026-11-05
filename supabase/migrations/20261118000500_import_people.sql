-- Phase 13 · Importing existing clients and riders (tools/import).
-- The import tool creates each person's login (phone number) with the Supabase admin API, then calls one of these
-- server-only functions to fill in the rest. Imported people sign in with their phone as usual and accept the
-- Terms & Conditions themselves the first time (we never accept terms on someone's behalf).

alter table public.profiles add column if not exists imported_at timestamptz;
comment on column public.profiles.imported_at is 'Set when the person was brought over from the old system by the import tool (tools/import).';

-- p: {name, email, city, type: individual|vendor|corporate, business_name, marketing_opt_in, notes, tags[], momo_number, momo_network, cod_payout, source}
create or replace function public.import_client(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare city uuid := (select id from public.cities where code = upper(p ->> 'city')); v uuid; kind text := coalesce(p ->> 'type', 'individual');
begin
  perform public._need(public.is_trusted(), 'Server only');
  perform public._need(exists (select 1 from public.profiles where id = p_user), 'Login not found');
  perform public._need(kind in ('individual', 'vendor', 'corporate'), 'Type must be individual, vendor or corporate');
  perform public._need(p ->> 'city' is null or city is not null, 'Unknown city');
  perform set_config('qcs.audit_reason', 'Imported from ' || coalesce(p ->> 'source', 'the old system'), true);
  update public.profiles set full_name = coalesce(nullif(trim(p ->> 'name'), ''), full_name),
         email = coalesce(nullif(lower(trim(p ->> 'email')), ''), email), city_id = coalesce(city, city_id),
         marketing_opt_in = coalesce((p ->> 'marketing_opt_in')::boolean, false), imported_at = now()
   where id = p_user;
  if kind <> 'individual' then
    insert into public.vendors (owner_id, account_type, business_name, contact_phone, contact_email, city_id, notes, tags,
                                payout_momo_number, payout_momo_network, cod_payout_schedule, crm_stage)
    select p_user, case when kind = 'corporate' then 'corporate' else 'vendor' end::public.vendor_account_type,
           coalesce(nullif(trim(p ->> 'business_name'), ''), nullif(trim(p ->> 'name'), '')), pr.phone, nullif(lower(trim(p ->> 'email')), ''), city,
           nullif(trim(p ->> 'notes'), ''), coalesce(array(select jsonb_array_elements_text(p -> 'tags')), '{}'),
           nullif(p ->> 'momo_number', ''), nullif(p ->> 'momo_network', ''), coalesce(nullif(p ->> 'cod_payout', ''), 'weekly')::public.payout_schedule, 'active'
    from public.profiles pr where pr.id = p_user
    returning id into v;
  end if;
  return jsonb_build_object('user_id', p_user, 'vendor_id', v);
end $$;

-- p: {name, email, city, rider_type: fleet|commission, status: active|pending, vehicle_type, plate, make_model, momo_number, momo_network, commission_pct, source}
create or replace function public.import_rider(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare city uuid := (select id from public.cities where code = upper(p ->> 'city')); veh uuid; st public.rider_status := coalesce(p ->> 'status', 'active')::public.rider_status;
        rt public.rider_type := coalesce(p ->> 'rider_type', 'fleet')::public.rider_type;
begin
  perform public._need(public.is_trusted(), 'Server only');
  perform public._need(exists (select 1 from public.profiles where id = p_user), 'Login not found');
  perform public._need(city is not null, 'Unknown city');
  perform public._need(st in ('active', 'pending'), 'Status must be active or pending');
  perform set_config('qcs.audit_reason', 'Imported from ' || coalesce(p ->> 'source', 'the old system'), true);
  update public.profiles set full_name = coalesce(nullif(trim(p ->> 'name'), ''), full_name), email = coalesce(nullif(lower(trim(p ->> 'email')), ''), email),
         city_id = city, imported_at = now()
   where id = p_user;
  insert into public.riders (id, rider_type, status, city_id, commission_rate_bp, payout_momo_number, payout_momo_network, submitted_at, reviewed_at, review_note)
  values (p_user, rt, st, city, case when rt = 'commission' then coalesce(round((p ->> 'commission_pct')::numeric * 100)::int, 2000) end,
          nullif(p ->> 'momo_number', ''), nullif(p ->> 'momo_network', ''), now(), case when st = 'active' then now() end,
          'Imported from ' || coalesce(p ->> 'source', 'the old system'));
  -- the vehicle points at its rider, so it comes second
  insert into public.vehicles (type, plate_number, make_model, max_weight_g, owned_by_qcs, owner_rider_id)
  values (coalesce(p ->> 'vehicle_type', 'bike')::public.vehicle_type, nullif(upper(trim(p ->> 'plate')), ''), nullif(trim(p ->> 'make_model'), ''),
          case coalesce(p ->> 'vehicle_type', 'bike') when 'car' then 100000 when 'van' then 500000 when 'tricycle' then 200000 else 15000 end,
          rt = 'fleet', case when rt = 'commission' then p_user end)
  returning id into veh;
  update public.riders set vehicle_id = veh where id = p_user;
  if st = 'active' then
    insert into public.user_roles (user_id, role, city_id)
    values (p_user, case when rt = 'fleet' then 'fleet_rider' else 'commission_rider' end::public.app_role, city) on conflict do nothing;
  end if;
  return jsonb_build_object('user_id', p_user, 'vehicle_id', veh);
end $$;

revoke execute on function public.import_client(uuid, jsonb), public.import_rider(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_client(uuid, jsonb), public.import_rider(uuid, jsonb) to service_role;
