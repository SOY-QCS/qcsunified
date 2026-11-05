-- Phone numbers on profiles always start with "+" (e.g. +233241234567).
-- Supabase's sign-in service saves phone numbers WITHOUT the "+" (233241234567). Our rules look people up by
-- "+233…" (WhatsApp rider commands, support tickets from WhatsApp, staff look-ups), so without this a rider's
-- "DELIVERED …" WhatsApp backup would not be matched to them on the real system.

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.profiles (id, phone, email, full_name)
  values (new.id, public._phone(new.phone), new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'customer') on conflict do nothing;
  insert into public.wallets (owner_type, owner_id) values ('customer', new.id) on conflict do nothing;
  return new;
end $$;

-- When someone changes their sign-in phone number, the profile follows.
create or replace function public.sync_profile_phone() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.profiles set phone = public._phone(new.phone)
   where id = new.id and phone is distinct from public._phone(new.phone);
  return new;
end $$;
revoke execute on function public.sync_profile_phone() from public, anon, authenticated;
drop trigger if exists on_auth_user_phone_changed on auth.users;
create trigger on_auth_user_phone_changed after update of phone on auth.users
  for each row when (old.phone is distinct from new.phone) execute function public.sync_profile_phone();

-- Fix numbers already saved without the "+".
update public.profiles set phone = public._phone(phone) where phone is not null and phone !~ '^\+';
