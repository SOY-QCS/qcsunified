-- Minimal stand-in for what Supabase provides (roles, auth schema, extensions schema).
-- ONLY used to test migrations on plain Postgres. Never run this against Supabase.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

create schema if not exists extensions;
create schema if not exists auth;
grant usage on schema extensions, auth, public to anon, authenticated, service_role;
set search_path = "$user", public, extensions;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text, phone text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Supabase grants table access to these roles by default; RLS then decides row by row.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
