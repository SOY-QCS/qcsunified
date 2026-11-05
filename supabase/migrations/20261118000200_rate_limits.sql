-- Phase 13 · Rate limiting: one simple counter shared by the database, the Edge Functions and the web apps.
-- "At most N hits per bucket per time window." A bucket is a name like 'otp:+233241234567' or 'ip:41.66.1.2:track'.
-- Fixed windows (e.g. 10:00–10:01) keep it cheap: one row per bucket per window, cleaned up hourly.

create table public.rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (bucket, window_start)
);
alter table public.rate_limits enable row level security;   -- no policies: only the server touches it
comment on table public.rate_limits is 'Request counters for rate limiting (see rate_hit). Old windows are deleted hourly.';

-- Counts one hit and answers "still allowed?" (true) or "over the limit" (false).
create or replace function public.rate_hit(p_bucket text, p_limit int, p_window_s int) returns boolean
language plpgsql security definer set search_path = public as $$
declare w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s); n int;
begin
  insert into public.rate_limits as r (bucket, window_start, hits) values (left(p_bucket, 200), w, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into n;
  return n <= p_limit;
end $$;
revoke execute on function public.rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.rate_hit(text, int, int) to service_role;

create or replace function public.purge_rate_limits() returns int
language sql security definer set search_path = public as $$
  with d as (delete from public.rate_limits where window_start < now() - interval '1 day' returning 1) select count(*)::int from d $$;
revoke execute on function public.purge_rate_limits() from public, anon, authenticated;
grant execute on function public.purge_rate_limits() to service_role;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-rate-limits', '7 * * * *', 'select public.purge_rate_limits()');
  end if;
end $$;

-- Delivery codes: each resend gives 5 fresh guesses, so a rider could keep resending to keep guessing.
-- Riders may resend at most 3 times per order per hour; dispatch and support are not limited.
create or replace function public.resend_delivery_code(p_order uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; code text := lpad((floor(random() * 10000))::int::text, 4, '0');
begin
  select * into o from public.orders where id = p_order for update;
  if not (public.is_trusted() or public.is_ops_writer(o.city_id) or o.rider_id = auth.uid()) then raise exception 'Not allowed'; end if;
  if not (public.is_trusted() or public.is_ops_writer(o.city_id)) then
    perform public._need(public.rate_hit('pod-resend:' || o.id, 3, 3600), 'The code was already resent 3 times this hour. Ask dispatch to resend it.');
  end if;
  perform public._sys(1);
  update public.orders set delivery_otp_hash = crypt(code, gen_salt('bf', 6)), pod_otp_attempts = 0 where id = o.id;
  perform public._sys(-1);
  insert into public.notifications (to_address, order_id, channel, template, payload)
  values (o.recipient_phone, o.id, 'sms', 'delivery_code', jsonb_build_object('code', code, 'tracking_number', o.tracking_number, 'resent', true));
end $$;
