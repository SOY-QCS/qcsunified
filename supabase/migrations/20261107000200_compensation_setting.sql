-- Uninsured lost parcels are compensated at 3× the delivery fee (Finance can change the multiplier).
insert into public.app_settings (key, value, description) values
  ('uninsured_compensation_multiplier', '3', 'Lost uninsured parcels: compensation = this × the delivery fee')
on conflict do nothing;

drop policy settings_pricing_write on public.app_settings;
create policy settings_pricing_write on public.app_settings for all to authenticated
  using ((key in ('night_window', 'surge_multiplier') and (public.is_finance() or (city_id is not null and public.is_admin(city_id))))
         or (key in ('insurance_rate', 'high_value_threshold', 'uninsured_compensation_multiplier') and city_id is null and public.is_finance()))
  with check ((key in ('night_window', 'surge_multiplier') and (public.is_finance() or (city_id is not null and public.is_admin(city_id))))
         or (key in ('insurance_rate', 'high_value_threshold', 'uninsured_compensation_multiplier') and city_id is null and public.is_finance()));
