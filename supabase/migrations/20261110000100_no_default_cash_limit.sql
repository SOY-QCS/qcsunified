-- Founder decision (2026-11-04): riders have NO cash-on-delivery limit by default.
-- Ops can still set a limit for an individual rider. The end-of-day remittance rule still applies:
-- a rider who hasn't remitted yesterday's cash gets no new COD jobs until they do.
alter table public.riders alter column cod_float_limit drop not null, alter column cod_float_limit set default null;
comment on column public.riders.cod_float_limit is 'Max COD cash a rider may carry, in pesewas. Empty = no limit.';
-- Riders still on the old automatic GHS 500 default get no limit.
update public.riders set cod_float_limit = null where cod_float_limit = 50000;

create or replace function public.candidate_riders(p_trip uuid, p_limit int default 5)
returns table (rider_id uuid, distance_m integer)
language sql stable security definer set search_path = public, extensions as $$
  select r.id, round(st_distance(r.last_location, t.pickup_location))::int
  from public.trips t
  join public.riders r on r.city_id = t.city_id
  left join public.vehicles v on v.id = r.vehicle_id
  where t.id = p_trip
    and r.status = 'active' and r.is_online and r.last_location is not null
    and r.last_location_at > now() - make_interval(secs => public.setting_int('rider_location_fresh_s', 180)::int)
    and r.rating >= coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'dispatch_min_rating' and city_id is null), 0)
    and coalesce(v.max_weight_g, 15000) >= t.max_weight_g
    and (t.trip_type <> 'express' or coalesce(v.type, 'bike') in ('bike', 'ebike'))
    and (t.cod_total = 0 or (not r.cod_blocked and (r.cod_float_limit is null or r.cod_float_balance + t.cod_total <= r.cod_float_limit)))
    and not exists (select 1 from public.trips a where a.rider_id = r.id and a.status in ('ASSIGNED', 'IN_PROGRESS'))
    and not exists (select 1 from public.job_offers o where o.rider_id = r.id and o.status = 'offered')
    and not exists (select 1 from public.job_offers o where o.rider_id = r.id and o.trip_id = t.id)
    and not exists (select 1 from public.rider_documents d where d.rider_id = r.id and d.status = 'approved' and d.expires_on < current_date)
  order by r.last_location <-> t.pickup_location
  limit p_limit;
$$;

create or replace function public.track_cod_float() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    update public.riders
       set cod_float_balance = cod_float_balance + new.amount,
           cod_blocked = (cod_float_balance + new.amount)  >= coalesce(cod_float_limit, 9223372036854775807)
     where id = new.rider_id;
  elsif old.status = 'collected' and new.status <> 'collected' then
    update public.riders
       set cod_float_balance = greatest(0, cod_float_balance - new.amount),
           cod_blocked = (greatest(0, cod_float_balance - new.amount))  >= coalesce(cod_float_limit, 9223372036854775807)
                         or exists (select 1 from public.cod_collections c
                                    where c.rider_id = new.rider_id and c.status = 'collected'
                                      and c.id <> new.id and c.remit_due_by < now())
     where id = new.rider_id;
  end if;
  return new;
end $$;

create or replace function public.rider_signup_defaults() returns trigger language plpgsql as $$
begin
  if public.is_trusted() or public.is_ops_writer(new.city_id) then return new; end if;
  new.status := 'applicant';
  new.commission_rate_bp := null;
  new.cod_float_limit := null;   -- no cash limit unless ops sets one for this rider
  new.cod_float_balance := 0;
  new.cod_blocked := false;
  new.rating := 5.00;
  new.score := 100;
  new.offers_received := 0;
  new.offers_accepted := 0;
  new.is_online := false;
  new.vehicle_id := null;
  return new;
end $$;
