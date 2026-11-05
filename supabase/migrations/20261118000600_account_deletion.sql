-- Phase 13 · Account deletion (required by Google Play and the App Store for apps with sign-up).
-- A person asks to delete their account in the app (or by contacting support, see the website's /delete-account page).
-- Support checks nothing is still owed either way (wallet money, parcels on the way, rider cash), then deletes it:
-- name, phone, email, saved addresses, phone records and settings are erased; the login is removed (by the dashboard,
-- with the Supabase admin API). Orders, payments and the audit log stay, without the personal details, because QCS
-- must keep business and tax records. The privacy notice / T&C should say so.

create table public.account_deletions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.profiles(id),
  reason       text,
  status       text        not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  requested_at timestamptz not null default now(),
  processed_by uuid        references public.profiles(id),
  processed_at timestamptz,
  note         text,
  login_removed_at timestamptz             -- set by the dashboard once the Supabase login is gone
);
create unique index account_deletions_one_pending on public.account_deletions (user_id) where status = 'pending';
alter table public.account_deletions enable row level security;
create policy account_deletions_read on public.account_deletions for select to authenticated
  using (user_id = (select auth.uid()) or public.has_role(array['super_admin', 'support']::public.app_role[]));
create trigger audit_account_deletions after insert or update of status on public.account_deletions for each row execute function public.audit_row();

-- What must be settled first, in plain words (empty = nothing in the way).
create or replace function public._deletion_blockers(p_user uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select array_remove(array[
    (select format('GHS %s is still in the wallet: withdraw it first (Wallet → Withdraw).', to_char(balance / 100.0, 'FM999,999,990.00'))
       from public.wallets where owner_type in ('customer', 'rider') and owner_id = p_user and balance > 0 limit 1),
    (select format('%s parcel(s) are still on the way.', count(*)) from public.orders
      where customer_id = p_user and status not in ('DRAFT', 'DELIVERED', 'COLLECTED', 'CANCELLED', 'RETURNED', 'LOST', 'DAMAGED') having count(*) > 0),
    (select format('%s job(s) are still assigned to you as a rider.', count(*)) from public.trips where rider_id = p_user and status in ('ASSIGNED', 'IN_PROGRESS') having count(*) > 0),
    (select format('GHS %s of COD cash is still to be handed in.', to_char(cod_float_balance / 100.0, 'FM999,999,990.00'))
       from public.riders where id = p_user and cod_float_balance > 0),
    (select format('You own the business account "%s": QCS support will close it with you first.', business_name)
       from public.vendors where owner_id = p_user limit 1)
  ], null) $$;

create or replace function public.request_account_deletion(p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); req public.account_deletions;
begin
  perform public._need(me is not null, 'Please sign in');
  select * into req from public.account_deletions where user_id = me and status = 'pending';
  if not found then
    insert into public.account_deletions (user_id, reason) values (me, left(nullif(trim(p_reason), ''), 500)) returning * into req;
  end if;
  return jsonb_build_object('id', req.id, 'status', req.status, 'requested_at', req.requested_at, 'blockers', to_jsonb(public._deletion_blockers(me)));
end $$;

create or replace function public.my_account_deletion() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'status', status, 'requested_at', requested_at, 'blockers', to_jsonb(public._deletion_blockers(user_id)))
  from public.account_deletions where user_id = auth.uid() and status = 'pending' $$;

create or replace function public.cancel_account_deletion() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.account_deletions set status = 'cancelled', processed_at = now(), note = 'Cancelled by the account holder'
  where user_id = auth.uid() and status = 'pending';
end $$;

-- Ops: log a request that came by WhatsApp, email or phone (support confirms it's really the account holder first)
create or replace function public.staff_request_account_deletion(p_phone text, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare who uuid; d uuid; digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  perform public._need(public.has_role(array['super_admin', 'support']::public.app_role[]), 'Only Support or a Super Admin can log deletion requests');
  perform public._need(length(trim(coalesce(p_reason, ''))) >= 3, 'Say how they asked (e.g. "WhatsApp from their registered number")');
  -- any Ghana format: 024…, 23324…, +23324…
  digits := case when digits like '0%' and length(digits) = 10 then '233' || substr(digits, 2) else digits end;
  select id into who from public.profiles where regexp_replace(coalesce(phone, ''), '\D', '', 'g') = digits limit 1;
  perform public._need(who is not null, 'No account with that phone number');
  select id into d from public.account_deletions where user_id = who and status = 'pending';
  if d is null then
    insert into public.account_deletions (user_id, reason) values (who, 'Logged by support: ' || trim(p_reason)) returning id into d;
  end if;
  return d;
end $$;

-- Ops: the waiting list, plus deletions whose login removal still has to be retried
create or replace function public.account_deletion_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'user_id', d.user_id, 'name', p.full_name, 'phone', p.phone, 'email', p.email, 'reason', d.reason,
           'requested_at', d.requested_at, 'days_left', 30 - extract(day from now() - d.requested_at)::int, 'stage', case when d.status = 'pending' then 'waiting' else 'login' end,
           'rider', exists (select 1 from public.riders where id = d.user_id), 'blockers', to_jsonb(public._deletion_blockers(d.user_id))) order by d.requested_at), '[]'::jsonb)
  from public.account_deletions d join public.profiles p on p.id = d.user_id
  where (d.status = 'pending' or (d.status = 'done' and d.login_removed_at is null))
    and public.has_role(array['super_admin', 'support']::public.app_role[]) $$;

create or replace function public.mark_login_removed(p_request uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare d public.account_deletions;
begin
  perform public._need(public.has_role(array['super_admin', 'support']::public.app_role[]), 'Only Support or a Super Admin can delete accounts');
  update public.account_deletions set login_removed_at = now() where id = p_request and status = 'done' returning * into d;
  perform public._need(d.id is not null, 'Erase the details first');
  return d.user_id;
end $$;

-- Ops: erase the personal details. The dashboard then removes the login. Returns the user id.
create or replace function public.process_account_deletion(p_request uuid, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare d public.account_deletions; b text[];
begin
  perform public._need(public.has_role(array['super_admin', 'support']::public.app_role[]), 'Only Support or a Super Admin can delete accounts');
  select * into d from public.account_deletions where id = p_request for update;
  perform public._need(found and d.status = 'pending', 'This request is not waiting');
  b := public._deletion_blockers(d.user_id);
  perform public._need(cardinality(b) = 0, 'Settle these first: ' || array_to_string(b, ' '));
  perform set_config('qcs.audit_reason', coalesce(nullif(trim(p_note), ''), 'Account deleted at the holder''s request'), true);
  perform public._sys(1);
  update public.profiles set full_name = 'Deleted account', phone = null, email = null, is_active = false, marketing_opt_in = false where id = d.user_id;
  update public.riders set status = 'offboarded', is_online = false, payout_momo_number = null, last_location = null, push_token = null where id = d.user_id;
  perform public._sys(-1);
  delete from public.addresses where user_id = d.user_id;
  delete from public.push_tokens where user_id = d.user_id;
  delete from public.device_logins where user_id = d.user_id;
  delete from public.notification_preferences where user_id = d.user_id;
  delete from public.report_subscriptions where user_id = d.user_id;
  delete from public.customer_crm where user_id = d.user_id;
  delete from public.crm_notes where customer_id = d.user_id;
  delete from public.user_roles where user_id = d.user_id;
  update public.account_deletions set status = 'done', processed_by = auth.uid(), processed_at = now(), note = nullif(trim(p_note), '') where id = d.id;
  return d.user_id;
end $$;

revoke execute on function public._deletion_blockers(uuid) from public, anon, authenticated;
revoke execute on function public.request_account_deletion(text), public.my_account_deletion(), public.cancel_account_deletion(),
  public.account_deletion_list(), public.process_account_deletion(uuid, text), public.mark_login_removed(uuid) from public, anon;
