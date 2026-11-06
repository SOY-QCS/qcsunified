-- The website's cities, areas and hubs (rate calculator and hub pages).
\set QUIET on
begin;
\ir 01_helpers.sql

select tests.ok(jsonb_array_length(public.public_places()) = (select count(*) from cities where is_active), 'one entry per active city');
select tests.ok((select bool_and(jsonb_array_length(c -> 'zones') > 0 and jsonb_array_length(c -> 'hubs') > 0) from jsonb_array_elements(public.public_places()) c),
                'every seeded city has areas and a hub');
select tests.ok((select bool_and(st_covers(z.area, st_setsrid(st_makepoint((e ->> 'lng')::float8, (e ->> 'lat')::float8), 4326)::geography))
                 from jsonb_array_elements(public.public_places()) c, jsonb_array_elements(c -> 'zones') e join zones z on z.id = (e ->> 'id')::uuid),
                'each area''s point lies inside the area (so its price is the area''s price)');
update zones set is_active = false where id = (select id from zones order by name limit 1);
select tests.ok(not exists (select 1 from jsonb_array_elements(public.public_places()) c, jsonb_array_elements(c -> 'zones') e
                            where (e ->> 'id')::uuid = (select id from zones where not is_active limit 1)), 'switched-off areas are hidden');
select tests.ok(not has_function_privilege('anon', 'public.public_places()', 'execute')
                and not has_function_privilege('authenticated', 'public.public_places()', 'execute'), 'only the server calls it');

rollback;
