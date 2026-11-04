-- Fix: a rider update sent without a phone time was stamped 2 days in the past
-- (greatest() ignores an empty value). Now it uses the server time, as intended.
create or replace function public.rider_action(p_key uuid, p_action jsonb, p_occurred_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); prior jsonb; o public.orders; res jsonb; t text := p_action ->> 'type'; ok boolean; due timestamptz;
begin
  if me is null or not exists (select 1 from public.riders where id = me and status = 'active') then raise exception 'Active riders only'; end if;
  select result into prior from public.rider_action_log where key = p_key and rider_id = me;
  if found then return coalesce(prior, '{}'::jsonb) || '{"replayed": true}'; end if;

  select * into o from public.orders where id = (p_action ->> 'order_id')::uuid for update;
  if not found or o.rider_id is distinct from me then raise exception 'This parcel is not on your job'; end if;

  if t = 'status' then
    if o.status = (p_action ->> 'to')::public.order_status then
      res := jsonb_build_object('ok', true, 'status', o.status, 'note', 'already done');
    else
      -- the phone's time can't be later than now, or more than 2 days old
      perform set_config('qcs.occurred_at', case when p_occurred_at is null then '' else least(greatest(p_occurred_at, now() - interval '2 days'), now())::text end, true);
      perform public.transition_order(o.id, (p_action ->> 'to')::public.order_status,
        nullif(p_action ->> 'lng', '')::float8, nullif(p_action ->> 'lat', '')::float8,
        p_action ->> 'note', p_action ->> 'photo_path', p_action ->> 'reason');
      perform set_config('qcs.occurred_at', '', true);
      res := jsonb_build_object('ok', true, 'status', p_action ->> 'to');
    end if;

  elsif t = 'code' then
    ok := public._check_delivery_code(o, p_action ->> 'code');
    res := jsonb_build_object('ok', ok, 'attempts_left', greatest(0, 5 - (select pod_otp_attempts from public.orders where id = o.id)));

  elsif t = 'pickup_code' then
    ok := upper(trim(p_action ->> 'code')) = o.tracking_number;
    if ok then
      perform public._sys(1);
      update public.orders set pickup_verified_at = now() where id = o.id;
      perform public._sys(-1);
    end if;
    res := jsonb_build_object('ok', ok);

  elsif t = 'pod' then
    if coalesce(p_action ->> 'signature_path', p_action ->> 'photo_path') is null then raise exception 'Nothing to save'; end if;
    perform public._sys(1);
    update public.orders set pod_signature_path = coalesce(p_action ->> 'signature_path', pod_signature_path),
                             pod_photo_path = coalesce(p_action ->> 'photo_path', pod_photo_path), pod_method = coalesce(pod_method, 'app')
     where id = o.id;
    perform public._sys(-1);
    res := jsonb_build_object('ok', true);

  elsif t = 'cod' then
    if o.cod_amount = 0 then raise exception 'This parcel has no cash to collect'; end if;
    if (p_action ->> 'amount')::bigint <> o.cod_amount then
      raise exception 'Collect exactly GHS % (or report a failed attempt: "no cash")', to_char(o.cod_amount / 100.0, 'FM999,990.00');
    end if;
    due := ((now() at time zone 'Africa/Accra')::date + 1)::timestamp at time zone 'Africa/Accra' - interval '1 minute';   -- end of today, Accra
    perform public._sys(1);   -- the COD float on the rider is updated by the system
    insert into public.cod_collections (order_id, rider_id, vendor_id, city_id, amount, remit_due_by)
    values (o.id, me, o.vendor_id, o.city_id, o.cod_amount, due) on conflict (order_id) do nothing;
    perform public._sys(-1);
    res := jsonb_build_object('ok', true, 'remit_by', due);

  elsif t = 'override' then
    if coalesce(trim(p_action ->> 'reason'), '') = '' or coalesce(p_action ->> 'photo_path', '') = '' then
      raise exception 'An override needs a reason and a photo';
    end if;
    insert into public.pod_overrides (order_id, rider_id, reason, photo_path) values (o.id, me, p_action ->> 'reason', p_action ->> 'photo_path')
    on conflict do nothing;
    insert into public.notifications (user_id, channel, template, payload)
    select distinct ur.user_id, 'push'::public.notification_channel, 'override_requested', jsonb_build_object('order_id', o.id, 'tracking_number', o.tracking_number)
    from public.user_roles ur where ur.role in ('dispatcher', 'support') and (ur.city_id = o.city_id or ur.city_id is null);
    res := jsonb_build_object('ok', true, 'status', 'override_requested');

  else
    raise exception 'Unknown action %', t;
  end if;

  insert into public.rider_action_log (key, rider_id, action, result, occurred_at) values (p_key, me, p_action, res, p_occurred_at);
  return res;
end $$;
