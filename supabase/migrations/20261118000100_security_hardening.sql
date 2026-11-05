-- Phase 13 · Security hardening: who may run which database function.
--
-- Supabase's default lets EVERYONE, even people who are not signed in, run every new function.
-- Our functions check the caller inside, but one forgotten check would be a hole. So:
--   1. Signed-out visitors (anon) may run only the few functions the public website needs.
--   2. Internal helpers (names starting with "_") and plumbing functions are for the server only.
--   3. New functions are no longer open to anon by default.
-- supabase/tests/130_security.sql re-checks all of this, so a future change that re-opens a hole fails the tests.

do $$
declare f record;
begin
  for f in
    select p.oid, p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')   -- skip PostGIS etc.
  loop
    -- keep what signed-in users and the server already had (it may have come through PUBLIC) …
    if has_function_privilege('authenticated', f.oid, 'execute') then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if has_function_privilege('service_role', f.oid, 'execute') then execute format('grant execute on function %s to service_role', f.sig); end if;
    -- … then close the door for everyone else
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;

  -- internal helpers: server only (two are used inside row-level security rules, so signed-in users keep them)
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname like '\_%' and p.proname not in ('_need', '_hub_staff')
  loop
    execute format('revoke execute on function %s from authenticated', f.sig);
  end loop;
end $$;

-- plumbing that only other database functions call
revoke execute on function public.next_tracking_number(uuid, uuid, timestamptz), public.sys_wallet(text), public.purge_old_notifications(),
  public.hub_cash_on_hand(uuid) from authenticated;

-- The public website (through the portal's /api/v1 routes, using the anon key):
grant execute on function public.track_order(text, text), public.address_link(text), public.confirm_address(text), public.unsubscribe(text) to anon;
-- Row-level security rules on public tables (cities, zones, hubs, prices, help) call is_ops(), which asks has_role();
-- both simply answer "no" for a visitor.
grant execute on function public.is_ops(uuid), public.has_role(public.app_role[], uuid) to anon;

-- From now on, new functions are open to signed-in users and the server, never to visitors by default.
-- (Postgres has two layers of defaults: the global one gives EVERYONE execute, so it must be revoked too.)
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
