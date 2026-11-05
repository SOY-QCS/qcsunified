-- Phase 14 · Running QCS safely: forced app updates, pausing bookings per city, system health + alerts, deployment check.

-- =====================================================================
-- 1. App versions: tell old apps to update (before sign-in too)
-- =====================================================================
insert into public.app_settings (key, value, description) values
  ('app_min_version_client',  '"1.0.0"', 'QCS app: versions older than this must update before they can be used'),
  ('app_min_version_rider',   '"1.0.0"', 'QCS Rider app: versions older than this must update before they can be used'),
  ('app_latest_version_client', '"1.0.0"', 'QCS app: newest version in the stores (older ones see a gentle "update available")'),
  ('app_latest_version_rider',  '"1.0.0"', 'QCS Rider app: newest version in the stores'),
  ('app_store_url_client_android', '"https://play.google.com/store/apps/details?id=gh.qcs.client"', 'QCS app on Google Play'),
  ('app_store_url_rider_android',  '"https://play.google.com/store/apps/details?id=gh.qcs.rider"', 'QCS Rider on Google Play'),
  ('app_store_url_client_ios', '""', 'QCS app on the App Store (paste the link once the app is live)'),
  ('app_store_url_rider_ios',  '""', 'QCS Rider on the App Store (paste the link once the app is live)'),
  ('app_notice', '""', 'Optional message shown at the top of both apps (e.g. "Public holiday: deliveries until 3pm"). Empty = none.')
on conflict do nothing;

-- "1.2.10" vs "1.10.0": compares number by number; "2.0" = "2.0.0"; anything after the numbers ("1.0.0 (45)") is ignored
create or replace function public._version_parts(v text) returns int[]
language sql immutable as $$
  select array_agg(coalesce(nullif(split_part(coalesce(substring(v from '^[0-9]+(?:\.[0-9]+)*'), '0'), '.', i), ''), '0')::int order by i)
  from generate_series(1, 4) i $$;
create or replace function public._version_lt(a text, b text) returns boolean
language sql immutable as $$ select public._version_parts(a) < public._version_parts(b) $$;

-- =====================================================================
-- 2. Pause new bookings in a city (Hubtel outage, flooding, hub closed …)
-- =====================================================================
alter table public.cities add column if not exists bookings_paused_until timestamptz, add column if not exists pause_message text;
comment on column public.cities.bookings_paused_until is 'While in the future, nobody can book in this city (set from Ops → Cities & zones).';
create trigger audit_city_pause after update of bookings_paused_until on public.cities for each row execute function public.audit_row();

create or replace function public._pause_text(c public.cities) returns text
language sql stable as $$
  select format('Bookings in %s are paused until %s%s', c.name,
    case when (c.bookings_paused_until at time zone 'Africa/Accra')::date = (now() at time zone 'Africa/Accra')::date
         then to_char(c.bookings_paused_until at time zone 'Africa/Accra', 'HH24:MI')
         else to_char(c.bookings_paused_until at time zone 'Africa/Accra', 'FMDD Mon, HH24:MI') end,
    coalesce(': ' || nullif(trim(c.pause_message), ''), '.')) $$;

create or replace function public.set_city_pause(p_city uuid, p_until timestamptz, p_message text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._need(public.has_role(array['super_admin', 'city_admin']::public.app_role[], p_city), 'Only a Super Admin or the City Admin can pause bookings');
  perform public._need(p_until is null or (p_until > now() and p_until <= now() + interval '7 days'), 'Pause for up to 7 days');
  perform public._need(p_until is null or length(trim(coalesce(p_message, ''))) >= 3, 'Write a short message for customers (it is shown in the apps)');
  perform set_config('qcs.audit_reason', coalesce(nullif(trim(p_message), ''), 'Bookings resumed'), true);
  update public.cities set bookings_paused_until = p_until, pause_message = case when p_until is null then null else trim(p_message) end where id = p_city;
end $$;

-- the guard: a draft can't become a booking while its city is paused (orders already booked carry on as normal)
create or replace function public.check_city_pause() returns trigger
language plpgsql security definer set search_path = public as $$
declare c public.cities;
begin
  if old.status = 'DRAFT' and new.status in ('PENDING_PAYMENT', 'CONFIRMED') then
    select * into c from public.cities where id = new.city_id;
    if c.bookings_paused_until > now() then raise exception '%', public._pause_text(c); end if;
  end if;
  return new;
end $$;
create trigger orders_city_pause before update of status on public.orders for each row execute function public.check_city_pause();

-- What the apps ask at start-up and every time they come back to the screen (works before sign-in).
create or replace function public.app_status(p_app text, p_version text, p_platform text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select public._setting('app_min_version_' || p_app, '"0"') #>> '{}' min_v,
                    public._setting('app_latest_version_' || p_app, '"0"') #>> '{}' latest_v,
                    nullif(public._setting('app_store_url_' || p_app || '_' || coalesce(p_platform, 'android'), '""') #>> '{}', '') store,
                    nullif(trim(public._setting('app_notice', '""') #>> '{}'), '') notice)
  select jsonb_build_object(
    'update_required', public._version_lt(p_version, s.min_v),
    'update_available', public._version_lt(p_version, s.latest_v),
    'store_url', coalesce(s.store, case when p_platform = 'ios' then 'https://apps.apple.com/gh/search?term=QCS%20Ghana' end),
    'notice', s.notice,
    'pauses', (select coalesce(jsonb_agg(jsonb_build_object('city_id', c.id, 'city', c.name, 'until', c.bookings_paused_until, 'text', public._pause_text(c)) order by c.name), '[]')
               from public.cities c where c.bookings_paused_until > now()))
  from s
  where p_app in ('client', 'rider') $$;

-- =====================================================================
-- 3. System health: is anything quietly broken?
-- =====================================================================
create table public.health_alerts (
  key           text primary key,
  status        text not null,
  value         text,
  first_bad_at  timestamptz,
  last_alert_at timestamptz,
  resolved_at   timestamptz
);
alter table public.health_alerts enable row level security;   -- server only

insert into public.notification_templates (key, channel, audience, subject, body, wa_template, essential, description) values
  ('system_alert', 'email', 'staff', 'QCS system alert: {{count}} problem(s)',
   'Something on the QCS platform needs attention:\n\n{{summary}}\n\nOpen the System health page: {{link}}\n\nYou will get this again every 3 hours until it is fixed.',
   null, true, 'A health check is red (to Super Admins)')
on conflict do nothing;

-- One line per check: status ok / warn / bad, with the number behind it and where to look.
create or replace function public._health_checks() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare out jsonb := '[]'; n int; m int; r record; hour_accra int := extract(hour from now() at time zone 'Africa/Accra');
  add_check text := null;
begin
  -- messages: the sender runs every 10 s, so anything waiting 10+ minutes means it has stopped
  select count(*) into n from public.notifications where status = 'queued' and coalesce(next_attempt_at, created_at) < now() - interval '10 minutes';
  out := out || jsonb_build_object('key', 'messages_waiting', 'label', 'Messages waiting to be sent', 'value', n,
    'status', case when n >= 20 then 'bad' when n > 0 then 'warn' else 'ok' end,
    'detail', case when n > 0 then 'SMS / WhatsApp / email / push messages are overdue: is the send-notifications job running and are the Hubtel / Meta / Resend keys valid?' end, 'link', '/notifications');
  select count(*) filter (where status = 'failed'), count(*) filter (where status in ('sent', 'failed')) into n, m
    from public.notifications where created_at > now() - interval '24 hours';
  out := out || jsonb_build_object('key', 'messages_failed', 'label', 'Messages failed (24 h)', 'value', format('%s of %s', n, m),
    'status', case when m >= 20 and n * 5 >= m then 'bad' when n >= 10 then 'warn' else 'ok' end,
    'detail', case when n > 0 then 'Open Messages and filter "failed" to see the reason (wrong number, no credit on Hubtel, template not approved …).' end, 'link', '/notifications');

  -- vendor webhooks
  select count(*) into n from public.webhook_deliveries where status = 'queued' and coalesce(next_attempt_at, created_at) < now() - interval '30 minutes';
  out := out || jsonb_build_object('key', 'webhooks_waiting', 'label', 'Vendor webhooks overdue', 'value', n,
    'status', case when n >= 50 then 'bad' when n > 0 then 'warn' else 'ok' end,
    'detail', case when n > 0 then 'Is the send-webhooks job running?' end);

  -- payments
  select count(*) filter (where state = 'failed'), count(*) filter (where state in ('paid', 'failed')) into n, m
    from public.payments where created_at > now() - interval '24 hours';
  out := out || jsonb_build_object('key', 'payments_failed', 'label', 'Card / MoMo payments failed (24 h)', 'value', format('%s of %s', n, m),
    'status', case when m >= 10 and n * 10 >= m * 4 then 'bad' when m >= 10 and n * 5 >= m then 'warn' else 'ok' end,
    'detail', case when n > 0 then 'Many failures at once usually means a Hubtel problem: check the Hubtel dashboard.' end, 'link', '/finance');
  select count(*) into n from public.payments where state = 'pending' and created_at < now() - interval '1 hour';
  out := out || jsonb_build_object('key', 'payments_unconfirmed', 'label', 'Payments waiting for Hubtel''s answer (1 h+)', 'value', n,
    'status', case when n >= 10 then 'bad' when n > 0 then 'warn' else 'ok' end,
    'detail', case when n > 0 then 'Hubtel''s callback is not arriving: check the callback URL and token in Hubtel, and that the payment-check job (portal /api/v1/payments/reconcile) is scheduled.' end, 'link', '/finance');

  -- payouts
  select count(*) into n from public.payouts where status = 'failed' and requested_at > now() - interval '7 days';
  select count(*) into m from public.payouts where status = 'processing' and requested_at < now() - interval '24 hours';
  out := out || jsonb_build_object('key', 'payouts', 'label', 'Rider / vendor payouts with problems', 'value', format('%s failed (7 days), %s stuck', n, m),
    'status', case when m > 0 or n >= 5 then 'bad' when n > 0 then 'warn' else 'ok' end,
    'detail', case when n + m > 0 then 'Failed payouts went back to the wallet; stuck ones need checking in Hubtel (send-money).' end, 'link', '/finance');

  -- dispatch
  select count(*) into n from public.trips t where t.rider_id is null and t.status not in ('COMPLETED', 'CANCELLED')
     and t.dispatch_state in ('queued', 'offering', 'escalated') and t.created_at < now() - interval '15 minutes';
  out := out || jsonb_build_object('key', 'dispatch_backlog', 'label', 'Jobs without a rider for 15+ minutes', 'value', n,
    'status', case when n >= 10 then 'bad' when n > 0 then 'warn' else 'ok' end,
    'detail', case when n > 0 then 'Not enough riders online, or the dispatch job has stopped. See Exceptions.' end, 'link', '/exceptions');

  -- riders online during working hours (07:00–20:00 Accra)
  if hour_accra between 7 and 19 then
    for r in select c.name, (select count(*) from public.riders x where x.city_id = c.id and x.is_online and x.status = 'active') online
             from public.cities c where c.is_active and exists (select 1 from public.riders x where x.city_id = c.id and x.status = 'active') loop
      if r.online = 0 then add_check := concat_ws(', ', add_check, r.name); end if;
    end loop;
  end if;
  out := out || jsonb_build_object('key', 'riders_online', 'label', 'Cities with no rider online (working hours)', 'value', coalesce(add_check, 'none'),
    'status', case when add_check is not null then 'warn' else 'ok' end, 'link', '/map');

  -- scheduled jobs (Supabase: pg_cron)
  if to_regclass('cron.job_run_details') is null then
    out := out || jsonb_build_object('key', 'scheduled_jobs', 'label', 'Scheduled jobs', 'value', 'scheduler not installed', 'status', 'bad',
      'detail', 'Turn on the pg_cron extension and run supabase/setup/schedule-jobs.sql (docs/go-live.md).');
  else
    execute $q$
      select count(*) filter (where d.status = 'failed'), string_agg(distinct j.jobname, ', ') filter (where d.status = 'failed')
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid where d.start_time > now() - interval '24 hours' $q$ into n, add_check;
    out := out || jsonb_build_object('key', 'scheduled_jobs', 'label', 'Scheduled job runs that failed (24 h)', 'value', n,
      'status', case when n >= 20 then 'bad' when n > 0 then 'warn' else 'ok' end,
      'detail', case when n > 0 then 'Failing: ' || add_check || '. Supabase → Integrations → Cron shows the error.' end);
    execute $q$
      select string_agg(e, ', ') from unnest(array['dispatch-tick', 'send-notifications', 'send-webhooks', 'payments-reconcile', 'expire-unpaid-orders', 'ticket-sla', 'campaigns', 'health-check']) e
      where not exists (select 1 from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                        where j.jobname = e and d.status = 'succeeded' and d.start_time > now() - interval '30 minutes') $q$ into add_check;
    out := out || jsonb_build_object('key', 'frequent_jobs', 'label', 'Frequent jobs not running', 'value', coalesce(add_check, 'none'),
      'status', case when add_check is not null then 'bad' else 'ok' end,
      'detail', case when add_check is not null then 'These run every few seconds or minutes and have not succeeded in 30 minutes. Re-run supabase/setup/schedule-jobs.sql and check the Vault secrets.' end);
  end if;
  return out;
end $$;

create or replace function public.system_health() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c jsonb;
begin
  perform public._need(public.is_trusted() or public.has_role(array['super_admin', 'city_admin', 'finance', 'dispatcher']::public.app_role[]), 'Not allowed');
  c := public._health_checks();
  return jsonb_build_object('checked_at', now(), 'checks', c,
    'bad', (select count(*) from jsonb_array_elements(c) x where x ->> 'status' = 'bad'),
    'warn', (select count(*) from jsonb_array_elements(c) x where x ->> 'status' = 'warn'),
    'alerts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.key), '[]') from public.health_alerts a));
end $$;

-- Every 10 minutes: email the Super Admins about red checks (at most every 3 hours per problem).
create or replace function public.health_check() returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb := public._health_checks(); x jsonb; due jsonb := '[]'; u record;
begin
  for x in select * from jsonb_array_elements(c) loop
    if x ->> 'status' = 'bad' then
      insert into public.health_alerts as a (key, status, value, first_bad_at) values (x ->> 'key', 'bad', x ->> 'value', now())
      on conflict (key) do update set status = 'bad', value = excluded.value, resolved_at = null,
        first_bad_at = case when a.status = 'bad' then a.first_bad_at else now() end;
      if not exists (select 1 from public.health_alerts where key = x ->> 'key' and last_alert_at > now() - interval '3 hours') then
        due := due || x;
        update public.health_alerts set last_alert_at = now() where key = x ->> 'key';
      end if;
    else
      update public.health_alerts set status = x ->> 'status', value = x ->> 'value', resolved_at = now(), last_alert_at = null
       where key = x ->> 'key' and status = 'bad';
    end if;
  end loop;
  if jsonb_array_length(due) > 0 then
    for u in select distinct user_id from public.user_roles where role = 'super_admin' loop
      perform public._enqueue(u.user_id, null, null, 'system_alert', jsonb_build_object('count', jsonb_array_length(due),
        'summary', (select string_agg(format('• %s: %s%s', d ->> 'label', d ->> 'value', coalesce(E'\n  ' || (d ->> 'detail'), '')), E'\n') from jsonb_array_elements(due) d),
        'link', rtrim(public._setting('ops_dashboard_url', '"https://ops.qcsghana.com"') #>> '{}', '/') || '/health'));
    end loop;
  end if;
  return jsonb_build_object('bad', (select count(*) from jsonb_array_elements(c) e where e ->> 'status' = 'bad'), 'alerted', jsonb_array_length(due));
end $$;

-- For the uptime checker (portal /api/health, server key): only "is the database answering, and is anything red?"
create or replace function public.health_ping() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', not exists (select 1 from jsonb_array_elements(public._health_checks()) x where x ->> 'status' = 'bad'),
    'bad', (select coalesce(jsonb_agg(x ->> 'key'), '[]') from jsonb_array_elements(public._health_checks()) x where x ->> 'status' = 'bad'), 'at', now()) $$;

-- =====================================================================
-- 4. Deployment check: is a new environment set up completely? (pnpm check:deploy)
-- =====================================================================
create or replace function public.deployment_check() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare out jsonb := '[]'; jobs text[] := array['dispatch-tick', 'send-notifications', 'send-webhooks', 'payments-reconcile', 'expire-unpaid-orders', 'block-overdue-cod',
  'purge-idle-pings', 'purge-old-notifications', 'prepare-payouts', 'bill-storage', 'ticket-sla', 'campaigns', 'crm-daily', 'purge-api-data', 'analytics-reports',
  'purge-rate-limits', 'fraud-scan', 'health-check']; missing text; v text;
begin
  perform public._need(public.is_trusted(), 'Server only');
  out := out || jsonb_build_object('item', 'pg_cron extension (scheduled jobs)', 'ok', exists (select 1 from pg_extension where extname = 'pg_cron'),
                                   'fix', 'Supabase → Database → Extensions → pg_cron');
  out := out || jsonb_build_object('item', 'pg_net extension (jobs that call Edge Functions)', 'ok', exists (select 1 from pg_extension where extname = 'pg_net'),
                                   'fix', 'Supabase → Database → Extensions → pg_net');
  if to_regclass('cron.job') is not null then
    execute 'select string_agg(j, '', '') from unnest($1) j where not exists (select 1 from cron.job where jobname = j)' into missing using jobs;
  else missing := array_to_string(jobs, ', '); end if;
  out := out || jsonb_build_object('item', 'all 18 scheduled jobs registered (+ dispatch-rank only if Google road-time ranking is on)', 'ok', missing is null, 'detail', missing,
                                   'fix', 'Run supabase/setup/schedule-jobs.sql in the SQL editor');
  if to_regclass('vault.secrets') is not null then
    execute $q$ select string_agg(s, ', ') from unnest(array['project_url', 'notify_secret', 'portal_url', 'cron_secret']) s
                where not exists (select 1 from vault.secrets where name = s) $q$ into missing;
  else missing := 'Vault not available'; end if;
  out := out || jsonb_build_object('item', 'Vault secrets for the job → Edge Function calls', 'ok', missing is null, 'detail', missing,
                                   'fix', 'Create them in Supabase → Project settings → Vault (docs/go-live.md step 4)');
  select string_agg(key, ', ') into missing from public.app_settings where city_id is null and key in ('public_site_url', 'ops_dashboard_url')
     and (value #>> '{}' like '%localhost%' or value #>> '{}' like '%127.0.0.1%');
  out := out || jsonb_build_object('item', 'website and dashboard addresses set', 'ok', missing is null, 'detail', missing, 'fix', 'Ops → Settings');
  out := out || jsonb_build_object('item', 'at least one Super Admin', 'ok', exists (select 1 from public.user_roles where role = 'super_admin'),
                                   'fix', 'docs/go-live.md step 6');
  select string_agg(name, ', ') into missing from public.cities c where c.is_active and not exists (select 1 from public.zones z where z.city_id = c.id);
  out := out || jsonb_build_object('item', 'every active city has zones', 'ok', missing is null, 'detail', missing, 'fix', 'Ops → Cities & zones');
  select string_agg(name, ', ') into missing from public.cities c where c.is_active and not exists (select 1 from public.pricing_rules p where p.city_id = c.id or p.city_id is null);
  out := out || jsonb_build_object('item', 'prices exist for every active city', 'ok', missing is null, 'detail', missing, 'fix', 'Ops → Pricing');
  select string_agg(b, ', ') into missing from unnest(array['kyc', 'pod', 'support']) b where not exists (select 1 from storage.buckets where id = b);
  out := out || jsonb_build_object('item', 'storage buckets', 'ok', missing is null, 'detail', missing, 'fix', 'Re-run the migrations');
  v := public._setting('app_min_version_client', '"1.0.0"') #>> '{}';
  out := out || jsonb_build_object('item', 'minimum app versions set', 'ok', v is not null, 'detail', 'client ' || v || ', rider ' || (public._setting('app_min_version_rider', '"1.0.0"') #>> '{}'),
                                   'fix', 'Ops → Settings → app_min_version_…');
  return jsonb_build_object('ok', not exists (select 1 from jsonb_array_elements(out) x where not (x ->> 'ok')::boolean), 'items', out);
end $$;

revoke execute on function public._version_lt(text, text), public._version_parts(text), public._pause_text(public.cities), public._health_checks() from public, anon, authenticated;
revoke execute on function public.health_check(), public.health_ping(), public.deployment_check() from public, anon, authenticated;
grant execute on function public.health_check(), public.health_ping(), public.deployment_check() to service_role;
grant execute on function public.app_status(text, text, text) to anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('health-check', '*/10 * * * *', 'select public.health_check()');
  end if;
end $$;
