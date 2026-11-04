-- =====================================================================
-- QCS Unified — sample data for local development (runs on `supabase db reset`).
-- ⚠ Zone shapes, hub locations and ALL prices below are SAMPLES so the system
--   can be tested. Ops must redraw zones and Finance must set real prices in admin.
-- =====================================================================

insert into public.cities (code, name, same_day_cutoff) values
  ('ACC', 'Accra',    '09:00'),
  ('KSI', 'Kumasi',   '09:00'),
  ('TKD', 'Takoradi', '09:00'),
  ('TML', 'Tamale',   '09:00');

-- Rectangles as rough sample zones: (city, code, name, west, south, east, north)
with z(city, code, name, w, s, e, n) as (values
  ('ACC','ACC-CEN','Accra Central / Osu',           -0.235, 5.530, -0.165, 5.580),
  ('ACC','ACC-ELG','East Legon / Airport',          -0.190, 5.580, -0.130, 5.660),
  ('ACC','ACC-ACH','Achimota / Dome / Kwabenya',    -0.260, 5.580, -0.190, 5.700),
  ('ACC','ACC-TEM','Tema / Spintex',                -0.130, 5.600,  0.030, 5.700),
  ('ACC','ACC-WST','Kaneshie / Dansoman / Weija',   -0.330, 5.530, -0.235, 5.600),
  ('KSI','KSI-CEN','Kumasi Central / Adum',         -1.650, 6.670, -1.590, 6.710),
  ('KSI','KSI-NTH','Kumasi North / Tafo / Suame',   -1.660, 6.710, -1.580, 6.760),
  ('KSI','KSI-STH','Kumasi South / Asokwa / Ahodwo',-1.660, 6.620, -1.580, 6.670),
  ('TKD','TKD-CEN','Takoradi Central / Market Circle', -1.780, 4.880, -1.730, 4.920),
  ('TKD','TKD-SEK','Sekondi / Kojokrom',            -1.730, 4.920, -1.680, 4.970),
  ('TML','TML-CEN','Tamale Central',                -0.870, 9.380, -0.810, 9.430),
  ('TML','TML-NTH','Tamale North / Kalpohin',       -0.880, 9.430, -0.800, 9.480)
)
insert into public.zones (city_id, code, name, area)
select c.id, z.code, z.name,
       st_multi(st_makeenvelope(z.w, z.s, z.e, z.n, 4326))::geography
from z join public.cities c on c.code = z.city;

insert into public.hubs (city_id, code, name, address, location, phone, capacity, opening_hours)
select c.id, h.code, h.name, h.address, st_setsrid(st_makepoint(h.lng, h.lat), 4326)::geography, null, h.capacity,
       '{"mon":["08:00","18:00"],"tue":["08:00","18:00"],"wed":["08:00","18:00"],"thu":["08:00","18:00"],"fri":["08:00","18:00"],"sat":["09:00","15:00"]}'::jsonb
from (values
  ('ACC','ACC-HUB','Accra Hub',    'Address to be confirmed', -0.2050, 5.6050, 2000),
  ('KSI','KSI-HUB','Kumasi Hub',   'Address to be confirmed', -1.6200, 6.6900,  800),
  ('TKD','TKD-HUB','Takoradi Hub', 'Address to be confirmed', -1.7550, 4.9000,  500),
  ('TML','TML-HUB','Tamale Hub',   'Address to be confirmed', -0.8400, 9.4050,  500)
) h(city, code, name, address, lng, lat, capacity)
join public.cities c on c.code = h.city;

-- ---------- SAMPLE prices (pesewas: 100 = GHS 1) ----------
-- Express, one rule per city.
insert into public.pricing_rules (rule_kind, name, city_id, config)
select 'express', 'Express — ' || c.name, c.id, jsonb_build_object(
  'baseFee', 1000, 'perKm', 300, 'perMinute', 20,
  'weightSurcharges', jsonb_build_array(
     jsonb_build_object('maxG', 5000,  'feePesewas', 0),
     jsonb_build_object('maxG', 10000, 'feePesewas', 500),
     jsonb_build_object('maxG', 15000, 'feePesewas', 1000)),
  'fragileSurcharge', 300, 'nightSurcharge', 500, 'minimumFee', 1500)
from public.cities c;

-- E-commerce: fixed fee per stop by weight band, one rule per zone.
insert into public.pricing_rules (rule_kind, name, city_id, zone_id, config)
select 'ecommerce_zone', 'E-commerce — ' || z.name, z.city_id, z.id, jsonb_build_object('bands', jsonb_build_array(
  jsonb_build_object('maxG', 2000,  'feePesewas', 2500),
  jsonb_build_object('maxG', 5000,  'feePesewas', 3000),
  jsonb_build_object('maxG', 10000, 'feePesewas', 4000),
  jsonb_build_object('maxG', 25000, 'feePesewas', 5500)))
from public.zones z;

-- Inter-city lanes between every pair of hubs (longer lanes cost more).
insert into public.pricing_rules (rule_kind, name, city_id, origin_hub_id, dest_hub_id, config)
select 'intercity_lane', o.name || ' → ' || d.name, o.city_id, o.id, d.id, jsonb_build_object(
  'bands', jsonb_build_array(
     jsonb_build_object('maxG', 2000,  'feePesewas', 4000 + f.extra),
     jsonb_build_object('maxG', 5000,  'feePesewas', 5000 + f.extra),
     jsonb_build_object('maxG', 10000, 'feePesewas', 7000 + f.extra),
     jsonb_build_object('maxG', 30000, 'feePesewas', 10000 + f.extra)),
  'doorstepFee', 1500)
from public.hubs o
join public.hubs d on d.id <> o.id
cross join lateral (select case when 'TML-HUB' in (o.code, d.code) then 2000 else 0 end as extra) f;

-- Flat-rate promo example (switched off).
insert into public.pricing_rules (rule_kind, name, city_id, config, is_active, valid_from, valid_to)
select 'flat_promo', 'GHS 25 anywhere in Accra (example)', id, '{"flatFee": 2500}', false, now(), now() + interval '30 days'
from public.cities where code = 'ACC';

-- Fulfilment, customer-service handling and fleet rider pay (one default each).
insert into public.pricing_rules (rule_kind, name, config) values
  ('fulfilment', 'Fulfilment — default', '{"storagePerItemMonthly": 200, "storagePerBinMonthly": 5000, "pickPackPerOrder": 500}'),
  ('cs_service', 'Customer-service handling — default', '{"feePerDeliveredOrder": 300}'),
  ('rider_pay',  'Fleet rider pay — default', '{"pickupFee": 300, "perStopFee": 700}');

-- Sample promo code (switched off).
insert into public.promo_codes (code, kind, value, max_discount, max_uses, is_active)
values ('WELCOME10', 'percent', 10, 1000, 1000, false);
