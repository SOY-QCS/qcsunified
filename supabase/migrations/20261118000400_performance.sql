-- Phase 13 · Performance fixes found by the load test (supabase/load-test, docs/load-test.md).
-- These are look-ups the app does all the time on tables that grow every day. Without an index Postgres reads the
-- whole table: with 300,000 orders, creating a booking took 0.2 s just to find its own orders, and it would keep
-- getting slower as history grows. With the index it is a few milliseconds, whatever the size.

create index if not exists orders_quote_idx            on public.orders (quote_id) where quote_id is not null;        -- every booking
create index if not exists order_stops_order_idx       on public.order_stops (order_id);                               -- trip planning, rider app
create index if not exists ledger_tx_order_idx         on public.ledger_transactions (order_id) where order_id is not null; -- refunds, statements, order money
create index if not exists notifications_order_idx     on public.notifications (order_id) where order_id is not null;  -- order page messages, delivery codes
create index if not exists cod_collections_payout_idx  on public.cod_collections (payout_id) where payout_id is not null; -- vendor COD payouts
create index if not exists webhook_deliveries_hook_idx on public.webhook_deliveries (webhook_id, created_at desc);    -- developer logs
create index if not exists payments_wallet_idx         on public.payments (wallet_id) where wallet_id is not null;     -- wallet top-up history
create index if not exists trips_rider_idx             on public.trips (rider_id, assigned_at) where rider_id is not null; -- rider reports, rider pages (73 s → see docs/load-test.md)
create index if not exists tickets_assigned_idx        on public.tickets (assigned_to) where assigned_to is not null;  -- "my tickets"

-- BUG found by the load test: from the 100th parcel on the same route in the same minute (e.g. a vendor bulk-uploading
-- 100+ orders to one city), lpad(n, 2) cut "-100" down to "-10", which already existed, so the booking looped forever
-- while holding the route's lock — blocking every booking on that route. Now: -02 … -99, then -100, -101 …
create or replace function public.next_tracking_number(p_from_city uuid, p_to_city uuid, p_at timestamptz default now())
returns text language plpgsql security definer set search_path = public, extensions as $$
declare base text; candidate text; n int := 1;
begin
  base := (select tracking_code from public.cities where id = p_from_city) || '-'
       || to_char(p_at at time zone 'Africa/Accra', 'YYYYMMDDHH24MI') || '-'
       || (select tracking_code from public.cities where id = coalesce(p_to_city, p_from_city));
  -- one booking at a time per route-minute, so two people can't get the same number
  perform pg_advisory_xact_lock(hashtext(base));
  candidate := base;
  while exists (select 1 from public.orders where tracking_number = candidate) loop
    n := n + 1;
    candidate := base || '-' || case when n < 10 then '0' || n else n::text end;
  end loop;
  return candidate;
end $$;
revoke execute on function public.next_tracking_number(uuid, uuid, timestamptz) from public, anon, authenticated;

-- Load test (flash sale: 300 Express bookings at the same moment): one dispatch round took 4.6 s, close to its 5-second
-- schedule. Each round now starts and offers at most 150 jobs, oldest first; the rest follow 5 seconds later.
CREATE OR REPLACE FUNCTION public.dispatch_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
             and (not ranking or ranked_at is not null or created_at < now() - interval '4 seconds')
             order by created_at limit 150 loop
    perform public.start_dispatch(t.id);
  end loop;

  for t in select id from public.trips where dispatch_state in ('queued', 'offering') and rider_id is null and dispatch_started_at is not null
             and coalesce(ready_at, now()) <= now()
             and not exists (select 1 from public.job_offers o where o.trip_id = trips.id and o.status = 'offered')
             order by dispatch_started_at limit 150 loop
    if public.offer_next(t.id) is not null then offered := offered + 1; end if;
  end loop;
  return jsonb_build_object('expired', expired, 'offered', offered);
end $function$;
