-- =====================================================================
-- Google road-time ranking (optional) and WhatsApp message log
-- =====================================================================

-- Ranking: the dispatch-rank Edge Function ranks the 5 nearest riders by motorbike road time (one Google call per job).
-- While it's switched on, a new job waits up to 4 seconds for that ranking before the first offer.
alter table public.trips add column ranked_at timestamptz;
insert into public.app_settings (key, value, description) values
  ('dispatch_google_ranking', 'false', 'Rank the 5 nearest riders by Google road time before offering (needs the dispatch-rank function)')
on conflict do nothing;

create or replace function public.set_dispatch_ranking(p_trip uuid, p_riders uuid[]) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  update public.trips set dispatch_ranking = p_riders, ranked_at = now() where id = p_trip;
end $$;
revoke execute on function public.set_dispatch_ranking(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.set_dispatch_ranking(uuid, uuid[]) to service_role;

-- Trips the ranking function should look at.
create or replace function public.trips_to_rank() returns table (trip_id uuid, pickup_lat double precision, pickup_lng double precision)
language sql stable security definer set search_path = public, extensions as $$
  select t.id, st_y(t.pickup_location::geometry), st_x(t.pickup_location::geometry)
  from public.trips t where t.dispatch_state in ('queued', 'offering') and t.ranked_at is null and t.rider_id is null and t.pickup_location is not null
  order by t.created_at limit 20;
$$;
revoke execute on function public.trips_to_rank() from public, anon, authenticated;
grant execute on function public.trips_to_rank() to service_role;

create or replace function public.rider_positions(p_riders uuid[]) returns table (rider_id uuid, lat double precision, lng double precision)
language sql stable security definer set search_path = public, extensions as $$
  select id, st_y(last_location::geometry), st_x(last_location::geometry) from public.riders where id = any (p_riders) and last_location is not null;
$$;
revoke execute on function public.rider_positions(uuid[]) from public, anon, authenticated;
grant execute on function public.rider_positions(uuid[]) to service_role;

-- dispatch_tick waits briefly for the ranking when it's switched on.
create or replace function public.dispatch_tick() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare off record; t record; expired int := 0; offered int := 0; pen int := public.setting_int('reject_score_penalty', 2)::int;
        ranking boolean := coalesce((select (value #>> '{}')::boolean from public.app_settings where key = 'dispatch_google_ranking' and city_id is null), false);
begin
  for off in update public.job_offers set status = 'expired', answered_at = now()
             where status = 'offered' and expires_at < now() returning trip_id, rider_id loop
    update public.trips set dispatch_misses = dispatch_misses + 1 where id = off.trip_id;
    perform public._sys(1);
    update public.riders set score = score - pen where id = off.rider_id;
    perform public._sys(-1);
    expired := expired + 1;
  end loop;

  for t in select id from public.trips where dispatch_state = 'queued' and dispatch_started_at is null and coalesce(ready_at, now()) <= now()
             and (not ranking or ranked_at is not null or created_at < now() - interval '4 seconds') loop
    perform public.start_dispatch(t.id);
  end loop;

  for t in select id from public.trips where dispatch_state in ('queued', 'offering') and rider_id is null and dispatch_started_at is not null
             and coalesce(ready_at, now()) <= now()
             and not exists (select 1 from public.job_offers o where o.trip_id = trips.id and o.status = 'offered') loop
    if public.offer_next(t.id) is not null then offered := offered + 1; end if;
  end loop;
  return jsonb_build_object('expired', expired, 'offered', offered);
end $$;
revoke execute on function public.dispatch_tick() from public, anon, authenticated;
grant execute on function public.dispatch_tick() to service_role;

-- ---------- WhatsApp: every incoming message kept once ----------
create table public.inbound_messages (
  id          text primary key,               -- WhatsApp message id (Meta retries with the same id)
  channel     text not null default 'whatsapp',
  from_number text not null,
  body        text,
  reply       text,
  received_at timestamptz not null default now()
);
alter table public.inbound_messages enable row level security;
create policy inbound_read on public.inbound_messages for select to authenticated using (public.is_ops());

create or replace function public.handle_whatsapp_message(p_id text, p_from text, p_body text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare r text;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  insert into public.inbound_messages (id, from_number, body) values (p_id, p_from, p_body) on conflict (id) do nothing;
  if not found then return null; end if;            -- seen before: don't act or reply twice
  r := public.whatsapp_rider_command(p_from, coalesce(p_body, ''));
  update public.inbound_messages set reply = r where id = p_id;
  return r;
end $$;
revoke execute on function public.handle_whatsapp_message(text, text, text) from public, anon, authenticated;
grant execute on function public.handle_whatsapp_message(text, text, text) to service_role;

-- ---------- Dispatcher review of flagged deliveries (e.g. WhatsApp backup with no signature) ----------
alter table public.orders add column pod_reviewed_by uuid references public.profiles(id), add column pod_reviewed_at timestamptz;

create or replace function public.review_pod_flag(p_order uuid, p_note text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if not (public.is_trusted() or public.has_role(array['super_admin','city_admin','dispatcher','support']::public.app_role[], o.city_id)) then
    raise exception 'Only dispatch or support can review deliveries';
  end if;
  if o.pod_flagged is null then raise exception 'This delivery is not flagged'; end if;
  if coalesce(length(trim(p_note)), 0) < 5 then raise exception 'Write a short note on how you checked it'; end if;
  perform set_config('qcs.audit_reason', 'delivery reviewed: ' || trim(p_note), true);
  perform public._sys(1);
  update public.orders set pod_flagged = null, pod_reviewed_by = auth.uid(), pod_reviewed_at = now() where id = p_order;
  perform public._sys(-1);
end $$;
revoke all on function public.review_pod_flag(uuid, text) from public;
grant execute on function public.review_pod_flag(uuid, text) to authenticated;
-- Clearing a delivery flag is a status-like decision, so it goes in the audit log too.
create trigger audit_orders_pod_review after update of pod_flagged, pod_reviewed_by on public.orders
  for each row execute function public.audit_row();
