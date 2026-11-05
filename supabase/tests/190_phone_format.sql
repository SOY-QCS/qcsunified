-- Phone numbers on profiles always get the "+" (Supabase's sign-in service saves them without it).
\set QUIET on
begin;
\ir 01_helpers.sql

insert into auth.users (id, phone) values ('00000000-0000-0000-0000-000000001901', '233200001901');
select tests.ok((select phone from profiles where id = '00000000-0000-0000-0000-000000001901') = '+233200001901', 'new phone sign-in: profile number gets the +');
insert into auth.users (id, phone) values ('00000000-0000-0000-0000-000000001902', '+233200001902');
select tests.ok((select phone from profiles where id = '00000000-0000-0000-0000-000000001902') = '+233200001902', 'a number that already has the + is kept');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000001903', 'staff1903@example.com');
select tests.ok((select phone from profiles where id = '00000000-0000-0000-0000-000000001903') is null, 'email-only staff have no phone');
update auth.users set phone = '233200001999' where id = '00000000-0000-0000-0000-000000001901';
select tests.ok((select phone from profiles where id = '00000000-0000-0000-0000-000000001901') = '+233200001999', 'changing the sign-in number updates the profile');

-- the WhatsApp rider backup now finds a rider who signed in by phone
insert into vehicles (id, type, plate_number) values ('50000000-0000-0000-0000-000000001901', 'bike', 'GR-1901');
insert into riders (id, rider_type, status, city_id, vehicle_id)
select '00000000-0000-0000-0000-000000001901', 'fleet', 'active', id, '50000000-0000-0000-0000-000000001901' from cities where code = 'ACC';
select tests.ok(public.whatsapp_rider_command('233200001999', 'HELP') like 'Send:%', 'WhatsApp backup recognises the rider');

rollback;
