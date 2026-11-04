-- Test helpers (included by each test file inside its transaction).
create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Act as a signed-in user (or anon when p_user is null).
create function tests.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', case when p_user is null then 'anon' else 'authenticated' end)::text, true);
end $$;
-- Back to the database owner (no JWT = trusted server).
create function tests.logout() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end $$;
-- Run a statement and require that it fails with a message containing p_needle.
create function tests.expect_error(p_sql text, p_needle text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_needle) in lower(sqlerrm)) = 0 then
      raise exception 'FAIL [%]: wrong error: %', p_label, sqlerrm;
    end if;
    raise notice 'ok  %', p_label;
    return;
  end;
  raise exception 'FAIL [%]: expected an error containing "%"', p_label, p_needle;
end $$;
create function tests.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok  %', p_label;
end $$;
-- Number of rows a statement changed (0 = RLS silently blocked it).
create function tests.rows(p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute p_sql; get diagnostics n = row_count; return n; end $$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Act as our booking server (service-role key).
create function tests.service() returns void language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;
grant execute on function tests.service() to anon, authenticated;
