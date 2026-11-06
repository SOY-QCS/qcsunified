-- Public website: the cities, delivery areas and hubs shown on the rate calculator and hub pages.
-- Called by the portal's server (service role) only; visitors get the result through /api/v1/public.
-- Each area comes with a point inside it, so the calculator can price "area A → area B" without an address.

create or replace function public.public_places() returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', c.code, 'name', c.name, 'cutoff', to_char(c.same_day_cutoff, 'HH24:MI'),
           'zones', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', z.id, 'name', z.name,
                        'lat', st_y(st_pointonsurface(z.area::geometry)), 'lng', st_x(st_pointonsurface(z.area::geometry)))
                      order by z.name)
                      from zones z where z.city_id = c.id and z.is_active), '[]'::jsonb),
           'hubs', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', h.id, 'code', h.code, 'name', h.name, 'address', h.address, 'phone', h.phone,
                        'opening_hours', h.opening_hours,
                        'lat', st_y(h.location::geometry), 'lng', st_x(h.location::geometry))
                      order by h.name)
                      from hubs h where h.city_id = c.id and h.is_active), '[]'::jsonb))
         order by c.name), '[]'::jsonb)
  from cities c where c.is_active
$$;
revoke execute on function public.public_places() from public, anon, authenticated;
grant execute on function public.public_places() to service_role;
