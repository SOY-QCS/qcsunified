-- =====================================================================
-- Phase 10 — CRM & support (CLAUDE.md §12, plus §11 fulfilment customer service)
--   1. Settings + working-hours clock for SLA timers
--   2. Support tickets: open from the app/portal/rider app, staff, or WhatsApp; replies, internal notes,
--      canned replies, assignment, SLA timers and alerts
--   3. WhatsApp inbox: incoming messages become tickets (rider DELIVERED commands still work); STOP/START
--   4. 360 profiles: customer + vendor numbers, notes, tags, account manager
--   5. Leads pipeline (New → Contacted → Trial → Active → Churn risk), linked automatically on sign-up
--   6. Churn alerts (daily): this week ≥ 30% below the 4-week average
--   7. Segments + broadcast campaigns (opted-in only, unsubscribe link / STOP on every message)
--   8. Help centre articles (public)
--   9. Customer service for vendors who bought it: contact log, "QCS on behalf of <vendor>" messages, fee per delivered order
-- Every change of status, assignment, stage or money goes through a function and the audit log.
-- =====================================================================

-- ---------- 1. settings ----------
insert into public.app_settings (key, value, description) values
  ('support_hours',            '{"days":[1,2,3,4,5,6],"start":"08:00","end":"18:00"}', 'Support working hours (Accra time). days: 1 = Monday … 7 = Sunday. SLA timers only count these hours'),
  ('support_hours_text',       '"Mon–Sat, 8am–6pm"', 'Working hours as told to customers'),
  ('sla_first_reply_minutes',  '60',   'Support: first reply due within this many working minutes'),
  ('sla_resolve_hours',        '24',   'Support: ticket resolved within this many working hours'),
  ('ticket_autoclose_days',    '7',    'Resolved tickets close automatically after this many days (the customer can reopen until then)'),
  ('churn_min_weekly_orders',  '5',    'Churn alerts only for vendors averaging at least this many orders a week'),
  ('lead_active_after_orders', '5',    'A trial vendor becomes "active" after this many delivered orders'),
  ('cs_fee_per_order',         '200',  'Customer-service service: fee per delivered order, in pesewas (billed to the vendor wallet)')
on conflict do nothing;

/** Adds p_minutes of WORKING time to p_from (Accra clock, support_hours). Used for SLA due times. */
create or replace function public._work_add(p_from timestamptz, p_minutes int) returns timestamptz
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  h jsonb := coalesce(public.get_setting('support_hours'), '{"days":[1,2,3,4,5,6],"start":"08:00","end":"18:00"}');
  days int[] := array(select jsonb_array_elements_text(h -> 'days')::int);
  st time := (h ->> 'start')::time; en time := (h ->> 'end')::time;
  t timestamp := p_from at time zone 'Africa/Accra'; left_min numeric := greatest(p_minutes, 0); avail numeric; i int := 0;
begin
  if coalesce(array_length(days, 1), 0) = 0 or en <= st then return p_from + make_interval(mins => p_minutes); end if;
  loop
    i := i + 1; exit when i > 400;
    if not (extract(isodow from t)::int = any (days)) or t::time >= en then
      t := (t::date + 1) + st; continue;
    end if;
    if t::time < st then t := t::date + st; end if;
    avail := extract(epoch from ((t::date + en) - t)) / 60;
    if left_min <= avail then return (t + make_interval(secs => left_min * 60)) at time zone 'Africa/Accra'; end if;
    left_min := left_min - avail;
    t := (t::date + 1) + st;
  end loop;
  return p_from + make_interval(mins => p_minutes);
end $$;

-- ---------- 2. tickets ----------
alter table public.tickets
  add column opened_as             text not null default 'client' check (opened_as in ('client', 'vendor', 'rider', 'public', 'staff')),
  add column requester_name        text,
  add column requester_phone       text,                -- who to answer on WhatsApp/phone (may have no account)
  add column last_customer_at      timestamptz,
  add column last_staff_at         timestamptz,
  add column first_breach_alerted  boolean not null default false,
  add column resolve_breach_alerted boolean not null default false,
  add column closed_at             timestamptz;
create index tickets_phone_idx on public.tickets (requester_phone, created_at desc) where requester_phone is not null;
create index tickets_customer_idx on public.tickets (customer_id, created_at desc);
create index tickets_vendor_idx on public.tickets (vendor_id, created_at desc) where vendor_id is not null;
create index tickets_city_status_idx on public.tickets (city_id, status, created_at desc);

alter table public.ticket_messages
  add column author_kind     text not null default 'customer' check (author_kind in ('customer', 'staff', 'system')),
  add column attachment_path text,                       -- photo in the private "support" bucket
  add column sent_via        text;                       -- app, whatsapp, sms, phone, email

-- Tickets and messages are only written through the functions below (SLA, notifications, audit).
drop policy if exists tickets_open on public.tickets;
drop policy if exists tickets_update_ops on public.tickets;
drop policy if exists ticket_msgs_write on public.ticket_messages;
create trigger audit_tickets after update of status, assigned_to, priority, category, order_id on public.tickets
  for each row execute function public.audit_row();

-- Canned replies: short answers support staff reuse.
create table public.canned_replies (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  category   text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.canned_replies enable row level security;
create policy canned_read on public.canned_replies for select to authenticated using (public.is_ops());
create policy canned_write on public.canned_replies for all to authenticated
  using (public.has_role(array['super_admin', 'city_admin', 'support']::public.app_role[]))
  with check (public.has_role(array['super_admin', 'city_admin', 'support']::public.app_role[]));
insert into public.canned_replies (title, body, category) values
  ('Checking with the rider', 'Thank you for letting us know. We are checking with the rider now and will update you shortly.', 'delay'),
  ('Parcel on the way', 'Your parcel is on its way. You can follow it live with your tracking link. The rider will call when they arrive.', 'delay'),
  ('Damaged item: photos', 'We are sorry about this. Please send clear photos of the parcel and the item so we can open a claim for you.', 'damaged'),
  ('COD payout timing', 'COD money is paid out on your payout schedule once the rider has handed the cash in. We will confirm the date for this order shortly.', 'cod_money'),
  ('Resolved – thank you', 'We have resolved this for you. If anything else comes up, just reply to this message.', null);

-- Private photos customers attach (support/<user id>/... from apps, support/wa/... from WhatsApp).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support', 'support', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;
create policy support_upload_own on storage.objects for insert to authenticated
  with check (bucket_id = 'support' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy support_read on storage.objects for select to authenticated
  using (bucket_id = 'support' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_ops()));

/** Which categories are top priority (§12: COD money and lost/damaged parcels). */
create or replace function public._ticket_priority(p_category text) returns public.ticket_priority
language sql immutable as $$
  select case when p_category in ('cod_money', 'damaged', 'missing') then 'urgent'
              when p_category in ('delay', 'rider', 'address') then 'high' else 'normal' end::public.ticket_priority;
$$;

create or replace function public._ticket_payload(t public.tickets, p_message text default null) returns jsonb
language sql stable as $$
  select jsonb_build_object('ticket_id', t.id, 'ticket_number', t.number, 'subject', t.subject, 'category', t.category,
           'message', left(coalesce(p_message, ''), 300),
           'tracking_number', (select tracking_number from public.orders where id = t.order_id));
$$;

/** Push to the support team of the ticket's city (urgent ones also to the City Admin). */
create or replace function public._notify_support(t public.tickets, p_key text, p_extra jsonb default '{}') returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if t.assigned_to is not null and p_key <> 'ticket_new' then
    perform public._enqueue(t.assigned_to, null, t.order_id, p_key, public._ticket_payload(t) || p_extra);
    return;
  end if;
  perform public._enqueue(ur.user_id, null, t.order_id, p_key, public._ticket_payload(t) || p_extra)
  from (select distinct user_id from public.user_roles
        where (role = 'support' or (role = 'city_admin' and t.priority = 'urgent'))
          and (city_id is null or t.city_id is null or city_id = t.city_id)) ur;
end $$;

/** Create a ticket + its first message. Internal: callers check who may do it. */
create or replace function public._new_ticket(p jsonb, p_body text, p_attachment text, p_author uuid, p_author_kind text, p_via text)
returns public.tickets
language plpgsql security definer set search_path = public, extensions as $$
declare t public.tickets; cat text := coalesce(nullif(p ->> 'category', ''), 'general');
begin
  insert into public.tickets (order_id, vendor_id, customer_id, city_id, opened_by, channel, category, priority, subject,
                              opened_as, requester_name, requester_phone, first_response_due, resolution_due, last_customer_at)
  values ((p ->> 'order_id')::uuid, (p ->> 'vendor_id')::uuid, (p ->> 'customer_id')::uuid, (p ->> 'city_id')::uuid, p_author,
          (p ->> 'channel')::public.ticket_channel, cat, public._ticket_priority(cat),
          left(coalesce(nullif(trim(p ->> 'subject'), ''), left(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g'), 80), 'Help request'), 120),
          coalesce(p ->> 'opened_as', 'client'), p ->> 'requester_name', p ->> 'requester_phone',
          public._work_add(now(), public.setting_int('sla_first_reply_minutes', 60)::int),
          public._work_add(now(), public.setting_int('sla_resolve_hours', 24)::int * 60),
          case when p_author_kind = 'customer' then now() end)
  returning * into t;
  if coalesce(trim(p_body), '') <> '' or p_attachment is not null then
    insert into public.ticket_messages (ticket_id, author_id, body, author_kind, attachment_path, sent_via)
    values (t.id, p_author, coalesce(nullif(trim(p_body), ''), '(photo)'), p_author_kind, p_attachment, p_via);
  end if;
  perform public._notify_support(t, 'ticket_new');
  return t;
end $$;

/**
 * "Report a problem" / "Contact support" from the client app, the portal or the rider app.
 * p_tracking is optional (a general question); when given, it must be one of the caller's own orders/jobs.
 */
create or replace function public.open_ticket(p_category text, p_body text, p_tracking text default null,
                                              p_subject text default null, p_attachment text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); o public.orders; prof public.profiles; t public.tickets; kind text; v uuid; recent int;
begin
  perform public._need(me is not null, 'Sign in first');
  perform public._need(p_category in ('delay', 'damaged', 'missing', 'cod_money', 'rider', 'billing', 'address', 'account', 'payout', 'app', 'other'),
                       'Choose what the problem is about');
  perform public._need(length(coalesce(trim(p_body), '')) >= 5, 'Tell us a little more (at least a few words)');
  perform public._need(length(p_body) <= 4000, 'Message is too long');
  perform public._need(p_attachment is null or p_attachment like me::text || '/%', 'Upload the photo first');
  select count(*) into recent from public.tickets where opened_by = me and created_at > now() - interval '1 hour';
  perform public._need(recent < 10, 'You have opened many tickets in the last hour. Please wait for our reply.');
  select * into prof from public.profiles where id = me;

  if p_tracking is not null and trim(p_tracking) <> '' then
    select * into o from public.orders where tracking_number = upper(trim(p_tracking));
    perform public._need(found and (o.customer_id = me or o.rider_id = me or o.vendor_id in (select public.my_vendor_ids())),
                         'We couldn''t find that delivery on your account');
  end if;
  kind := case when exists (select 1 from public.riders where id = me) and (o.id is null or o.rider_id = me) then 'rider'
               when o.vendor_id is not null and o.vendor_id in (select public.my_vendor_ids()) then 'vendor'
               when o.id is null and exists (select 1 from public.my_vendor_ids()) then 'vendor'
               else 'client' end;
  v := case when kind = 'vendor' then coalesce(o.vendor_id, (select x from public.my_vendor_ids() x limit 1)) end;

  -- the same problem on the same order while a ticket is still open: add to that ticket instead of a duplicate
  if o.id is not null then
    select * into t from public.tickets
     where order_id = o.id and opened_by = me and category = p_category and status in ('open', 'pending') order by created_at desc limit 1;
    if found then
      perform public.reply_ticket(t.id, p_body, false, p_attachment);
      return jsonb_build_object('id', t.id, 'number', t.number, 'existing', true);
    end if;
  end if;

  t := public._new_ticket(jsonb_build_object('order_id', o.id, 'vendor_id', v, 'customer_id', me,
         'city_id', coalesce(o.city_id, prof.city_id, (select city_id from public.riders where id = me)),
         'channel', 'app', 'category', p_category, 'subject', p_subject, 'opened_as', kind,
         'requester_name', prof.full_name, 'requester_phone', prof.phone), p_body, p_attachment, me, 'customer', 'app');
  perform public._enqueue(me, null, o.id, 'ticket_received', public._ticket_payload(t) ||
    jsonb_build_object('hours', public.get_setting('support_hours_text') #>> '{}'));
  return jsonb_build_object('id', t.id, 'number', t.number, 'existing', false);
end $$;

/** Support staff log a ticket (phone call, walk-in, email) for a customer. */
create or replace function public.staff_open_ticket(p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; cust public.profiles; t public.tickets; ph text; city uuid := (p ->> 'city_id')::uuid;
begin
  if nullif(p ->> 'tracking_number', '') is not null then
    select * into o from public.orders where tracking_number = upper(trim(p ->> 'tracking_number'));
    perform public._need(found, 'No delivery with that tracking number');
    city := o.city_id;
  end if;
  ph := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '\D', '', 'g'), '');
  if ph is not null then
    ph := case when ph ~ '^0\d{9}$' then '+233' || substr(ph, 2) when ph ~ '^233\d{9}$' then '+' || ph when ph ~ '^\d{9}$' then '+233' || ph else '+' || ph end;
    select * into cust from public.profiles where phone = ph;
  end if;
  city := coalesce(city, cust.city_id);
  perform public._need(public.has_role(array['super_admin', 'city_admin', 'support', 'dispatcher']::public.app_role[], city), 'Only support staff can log tickets');
  perform public._need(coalesce(p ->> 'channel', 'phone') in ('phone', 'staff', 'email'), 'Channel must be phone, staff or email');
  perform public._need(length(coalesce(trim(p ->> 'body'), '')) >= 5, 'Write what the customer said');
  t := public._new_ticket(jsonb_build_object('order_id', o.id, 'vendor_id', case when cust.id is not null and o.vendor_id in
           (select v.id from public.vendors v where v.owner_id = cust.id) then o.vendor_id end,
         'customer_id', cust.id, 'city_id', city, 'channel', coalesce(p ->> 'channel', 'phone'), 'category', coalesce(p ->> 'category', 'general'),
         'subject', p ->> 'subject', 'opened_as', 'staff', 'requester_name', coalesce(nullif(p ->> 'name', ''), cust.full_name),
         'requester_phone', coalesce(ph, cust.phone)), p ->> 'body', null, auth.uid(), 'customer', coalesce(p ->> 'channel', 'phone'));
  update public.tickets set assigned_to = auth.uid() where id = t.id;
  return t.id;
end $$;

/** Who is the customer side of this ticket? */
create or replace function public._is_ticket_customer(t public.tickets) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(auth.uid() is not null and (t.customer_id = auth.uid() or t.opened_by = auth.uid()
         or (t.vendor_id is not null and t.vendor_id in (select public.my_vendor_ids()))), false);
$$;

/**
 * Add a message. Customers reply to their own tickets (reopens a resolved one); staff reply to the customer
 * (by push/email, or WhatsApp for WhatsApp tickets) or write an internal note the customer never sees.
 */
create or replace function public.reply_ticket(p_ticket uuid, p_body text, p_internal boolean default false, p_attachment text default null,
                                               p_resolve boolean default false) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare t public.tickets; staff boolean; mid bigint; pl jsonb; window_open boolean;
begin
  select * into t from public.tickets where id = p_ticket for update;
  perform public._need(found, 'Ticket not found');
  staff := public.is_ops_writer(t.city_id);
  perform public._need(staff or public._is_ticket_customer(t), 'Not your ticket');
  perform public._need(length(coalesce(trim(p_body), '')) >= 1 or p_attachment is not null, 'Write a message');
  perform public._need(length(coalesce(p_body, '')) <= 4000, 'Message is too long');
  perform public._need(staff or (p_attachment is null or p_attachment like auth.uid()::text || '/%'), 'Upload the photo first');

  if staff and not public._is_ticket_customer(t) then
    perform public._need(t.status <> 'closed' or p_internal, 'This ticket is closed');
    insert into public.ticket_messages (ticket_id, author_id, body, is_internal, author_kind, attachment_path, sent_via)
    values (t.id, auth.uid(), coalesce(nullif(trim(p_body), ''), '(photo)'), p_internal, 'staff', p_attachment,
            case when p_internal then null when t.channel = 'whatsapp' then 'whatsapp' else 'app' end)
    returning id into mid;
    if not p_internal then
      update public.tickets set first_responded_at = coalesce(first_responded_at, now()), last_staff_at = now(),
             assigned_to = coalesce(assigned_to, auth.uid()),
             status = case when p_resolve then 'resolved' else 'pending' end::public.ticket_status,
             resolved_at = case when p_resolve then now() end
       where id = t.id returning * into t;
      pl := public._ticket_payload(t, trim(p_body));
      if t.channel = 'whatsapp' and t.requester_phone is not null then
        -- WhatsApp lets us answer in free text for 24 h after the customer's last message; after that, an approved template
        window_open := t.last_customer_at > now() - interval '23 hours 50 minutes';
        insert into public.notifications (user_id, to_address, order_id, channel, template, payload)
        values (null, t.requester_phone, t.order_id, 'whatsapp', 'ticket_reply_wa', pl || jsonb_build_object('wa_text', window_open));
      elsif t.customer_id is not null then
        perform public._enqueue(t.customer_id, null, t.order_id, 'ticket_reply', pl);
      elsif t.requester_phone is not null then
        insert into public.notifications (to_address, order_id, channel, template, payload)
        values (t.requester_phone, t.order_id, 'sms', 'ticket_reply', pl);
      end if;
    elsif p_resolve then
      update public.tickets set status = 'resolved', resolved_at = now() where id = t.id;
    end if;
  else
    perform public._need(not p_internal, 'Only staff can write internal notes');
    perform public._need(t.status <> 'closed', 'This ticket is closed. Please open a new one.');
    insert into public.ticket_messages (ticket_id, author_id, body, author_kind, attachment_path, sent_via)
    values (t.id, auth.uid(), coalesce(nullif(trim(p_body), ''), '(photo)'), 'customer', p_attachment, 'app') returning id into mid;
    update public.tickets set last_customer_at = now(), status = 'open', resolved_at = null,
           -- a reopened ticket gets a fresh resolution clock
           resolution_due = case when t.status = 'resolved' then public._work_add(now(), public.setting_int('sla_resolve_hours', 24)::int * 60) else resolution_due end,
           resolve_breach_alerted = case when t.status = 'resolved' then false else resolve_breach_alerted end
     where id = t.id returning * into t;
    perform public._notify_support(t, 'ticket_customer_reply', jsonb_build_object('message', left(trim(p_body), 200)));
  end if;
  return mid;
end $$;

/** Staff: assign, change status/priority/category, link an order. Audited. */
create or replace function public.update_ticket(p_ticket uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare t public.tickets; o public.orders; st public.ticket_status;
begin
  select * into t from public.tickets where id = p_ticket for update;
  perform public._need(found and public.is_ops_writer(t.city_id), 'Only support staff can change tickets');
  if p ? 'assigned_to' and nullif(p ->> 'assigned_to', '') is not null then
    perform public._need(exists (select 1 from public.user_roles where user_id = (p ->> 'assigned_to')::uuid
      and role in ('super_admin', 'city_admin', 'support', 'dispatcher', 'finance', 'hub_manager')), 'Assign to a staff member');
  end if;
  if nullif(p ->> 'tracking_number', '') is not null then
    select * into o from public.orders where tracking_number = upper(trim(p ->> 'tracking_number'));
    perform public._need(found, 'No delivery with that tracking number');
  end if;
  st := coalesce((p ->> 'status')::public.ticket_status, t.status);
  if p ? 'category' then perform public._need(p ->> 'category' in ('general', 'delay', 'damaged', 'missing', 'cod_money', 'rider', 'billing', 'address', 'account', 'payout', 'app', 'other'), 'Unknown category'); end if;
  perform set_config('qcs.audit_reason', coalesce(nullif(trim(p ->> 'reason'), ''), 'ticket updated'), true);
  update public.tickets set
    assigned_to = case when p ? 'assigned_to' then nullif(p ->> 'assigned_to', '')::uuid else assigned_to end,
    status = st,
    priority = coalesce((p ->> 'priority')::public.ticket_priority, case when p ? 'category' then public._ticket_priority(p ->> 'category') end, priority),
    category = coalesce(p ->> 'category', category),
    order_id = coalesce(o.id, order_id),
    city_id = coalesce(o.city_id, city_id),
    resolved_at = case when st = 'resolved' and t.status <> 'resolved' then now() when st in ('open', 'pending') then null else resolved_at end,
    closed_at = case when st = 'closed' then now() else null end
  where id = p_ticket;
end $$;

-- ---------- 3. WhatsApp inbox ----------
alter table public.inbound_messages add column ticket_id uuid references public.tickets(id), add column media jsonb;

/** Incoming WhatsApp from anyone who is not running a rider command: STOP/START, or a support ticket. */
create or replace function public._whatsapp_inbox(p_from text, p_body text, p_name text, p_media jsonb) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  ph text := '+' || regexp_replace(p_from, '\D', '', 'g');
  word text := upper(trim(coalesce(p_body, '')));
  prof public.profiles; t public.tickets; o public.orders; tn text; cat text; is_rider boolean;
  body text := coalesce(nullif(trim(p_body), ''), case when p_media is not null then '(' || coalesce(p_media ->> 'kind', 'file') || ')' end, '(empty message)');
begin
  select * into prof from public.profiles where phone = ph;
  if word in ('STOP', 'UNSUBSCRIBE', 'STOP ALL') then
    perform public._sys(1);
    update public.profiles set marketing_opt_in = false where phone = ph;
    perform public._sys(-1);
    return 'You won''t receive QCS offers any more. Delivery updates still come through. Reply START to get offers again.';
  elsif word = 'START' then
    if prof.id is null then return 'Download the QCS app or sign up at qcsghana.com to get offers.'; end if;
    perform public._sys(1);
    update public.profiles set marketing_opt_in = true where id = prof.id;
    perform public._sys(-1);
    return 'Thanks! You will receive QCS offers again. Reply STOP any time to opt out.';
  end if;

  -- continue this person's open conversation (or one resolved in the last 3 days)
  select * into t from public.tickets
   where requester_phone = ph and channel = 'whatsapp'
     and (status in ('open', 'pending') or (status = 'resolved' and resolved_at > now() - interval '3 days'))
   order by created_at desc limit 1 for update;
  if found then
    insert into public.ticket_messages (ticket_id, author_id, body, author_kind, attachment_path, sent_via)
    values (t.id, prof.id, body, 'customer', p_media ->> 'path', 'whatsapp');
    update public.tickets set last_customer_at = now(), status = 'open', resolved_at = null,
           resolution_due = case when t.status = 'resolved' then public._work_add(now(), public.setting_int('sla_resolve_hours', 24)::int * 60) else resolution_due end
     where id = t.id returning * into t;
    if t.last_staff_at is not null then
      perform public._notify_support(t, 'ticket_customer_reply', jsonb_build_object('message', left(body, 200)));
    end if;
    update public.inbound_messages set ticket_id = t.id where id = (select id from public.inbound_messages where from_number = p_from order by received_at desc limit 1);
    return null;     -- no auto-reply in the middle of a conversation
  end if;

  tn := substring(upper(coalesce(p_body, '')) from '[A-Z]{3}-\d{12}-[A-Z]{3}(?:-\d{2})?');
  if tn is not null then select * into o from public.orders where tracking_number = tn; end if;
  cat := case when body ~* '\m(cod|cash|money|payment|paid|momo|refund|payout)\M' then 'cod_money'
              when body ~* '\m(damaged?|broken|spoil|spoilt|crushed|wet)\M' then 'damaged'
              when body ~* '\m(lost|missing|stolen|not received|never received)\M' then 'missing'
              when body ~* '\m(late|delay|delayed|waiting|where is|still not)\M' then 'delay'
              else 'general' end;
  is_rider := exists (select 1 from public.riders where id = prof.id);
  t := public._new_ticket(jsonb_build_object('order_id', o.id, 'customer_id', prof.id, 'city_id', coalesce(o.city_id, prof.city_id),
         'channel', 'whatsapp', 'category', cat, 'opened_as', case when is_rider then 'rider' when prof.id is null then 'public' else 'client' end,
         'requester_name', coalesce(nullif(trim(p_name), ''), prof.full_name), 'requester_phone', ph), body, p_media ->> 'path', prof.id, 'customer', 'whatsapp');
  update public.inbound_messages set ticket_id = t.id where id = (select id from public.inbound_messages where from_number = p_from order by received_at desc limit 1);
  return format('Thanks for contacting QCS. Your ticket number is #%s. An agent will reply here soon (%s).',
                t.number, coalesce(public.get_setting('support_hours_text') #>> '{}', 'working hours'));
end $$;

-- The webhook now also passes the sender's WhatsApp name and any photo/document (already saved to storage).
drop function if exists public.handle_whatsapp_message(text, text, text);
create or replace function public.handle_whatsapp_message(p_id text, p_from text, p_body text, p_name text default null, p_media jsonb default null) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare r text; word text := upper(split_part(trim(coalesce(p_body, '')), ' ', 1)); rider boolean;
begin
  if not public.is_trusted() then raise exception 'Server only'; end if;
  insert into public.inbound_messages (id, from_number, body, media) values (p_id, p_from, p_body, p_media) on conflict (id) do nothing;
  if not found then return null; end if;            -- seen before: don't act or reply twice
  rider := exists (select 1 from public.riders rd join public.profiles p on p.id = rd.id
                   where p.phone = '+' || regexp_replace(p_from, '\D', '', 'g') and rd.status = 'active');
  if word = 'DELIVERED' or (rider and word = 'HELP' and length(trim(p_body)) <= 5) then
    r := public.whatsapp_rider_command(p_from, coalesce(p_body, ''));
  else
    r := public._whatsapp_inbox(p_from, p_body, p_name, p_media);
  end if;
  update public.inbound_messages set reply = r where id = p_id;
  return r;
end $$;
revoke execute on function public.handle_whatsapp_message(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.handle_whatsapp_message(text, text, text, text, jsonb) to service_role;

-- ---------- 4. 360 profiles: tags, account manager, notes ----------
create table public.customer_crm (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  tags               text[] not null default '{}',
  account_manager_id uuid references public.profiles(id),
  updated_at         timestamptz not null default now()
);
alter table public.customer_crm enable row level security;
create policy customer_crm_read on public.customer_crm for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = customer_crm.user_id and public.is_ops(p.city_id)));

create table public.crm_notes (
  id          bigint generated always as identity primary key,
  vendor_id   uuid references public.vendors(id) on delete cascade,
  customer_id uuid references public.profiles(id) on delete cascade,
  lead_id     uuid,
  author_id   uuid references public.profiles(id),
  body        text not null check (length(body) between 1 and 4000),
  created_at  timestamptz not null default now(),
  check (num_nonnulls(vendor_id, customer_id, lead_id) = 1)
);
create index crm_notes_vendor_idx on public.crm_notes (vendor_id, created_at desc);
create index crm_notes_customer_idx on public.crm_notes (customer_id, created_at desc);
create index crm_notes_lead_idx on public.crm_notes (lead_id, created_at desc);
alter table public.crm_notes enable row level security;   -- read via the policy below; written by add_crm_note()

/** Notes are a timeline: add only, never edit. */
create or replace function public.add_crm_note(p_subject text, p_id uuid, p_body text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare city uuid; nid bigint;
begin
  perform public._need(p_subject in ('vendor', 'customer', 'lead'), 'Unknown subject');
  city := case p_subject when 'vendor' then (select city_id from public.vendors where id = p_id)
                         when 'customer' then (select city_id from public.profiles where id = p_id)
                         else (select city_id from public.leads where id = p_id) end;
  perform public._need(public.is_ops_writer(city), 'Only staff can add notes');
  perform public._need(length(coalesce(trim(p_body), '')) >= 2, 'Write a note');
  insert into public.crm_notes (vendor_id, customer_id, lead_id, author_id, body)
  values (case when p_subject = 'vendor' then p_id end, case when p_subject = 'customer' then p_id end,
          case when p_subject = 'lead' then p_id end, auth.uid(), trim(p_body)) returning id into nid;
  return nid;
end $$;

-- CRM stage, account manager, tags and the paid services a vendor has switched on are audited too.
create trigger audit_vendors_crm after update of crm_stage, account_manager_id, tags, cs_service_enabled, fulfilment_enabled on public.vendors
  for each row execute function public.audit_row();

/** Tags and account manager for a vendor or an individual customer. */
create or replace function public.set_crm_profile(p_subject text, p_id uuid, p_tags text[], p_manager uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare city uuid; clean text[];
begin
  clean := array(select distinct lower(left(trim(x), 30)) from unnest(coalesce(p_tags, '{}')) x where trim(x) <> '' limit 20);
  if p_manager is not null then
    perform public._need(exists (select 1 from public.user_roles where user_id = p_manager and role in ('super_admin', 'city_admin', 'support')), 'Account manager must be staff');
  end if;
  if p_subject = 'vendor' then
    select city_id into city from public.vendors where id = p_id;
    perform public._need(found and (public.is_admin(city) or public.has_role(array['support']::public.app_role[], city)), 'Only support or an admin can change this');
    perform set_config('qcs.audit_reason', 'CRM profile', true);
    perform public._sys(1);
    update public.vendors set tags = clean, account_manager_id = p_manager where id = p_id;
    perform public._sys(-1);
  elsif p_subject = 'customer' then
    select city_id into city from public.profiles where id = p_id;
    perform public._need(found and public.is_ops_writer(city), 'Only staff can change this');
    insert into public.customer_crm (user_id, tags, account_manager_id) values (p_id, clean, p_manager)
    on conflict (user_id) do update set tags = excluded.tags, account_manager_id = excluded.account_manager_id, updated_at = now();
  else
    raise exception 'Unknown subject';
  end if;
end $$;

/** Everything about one individual customer, for the 360 page. */
create or replace function public.customer_360(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = p_user;
  perform public._need(found and public.is_ops(p.city_id), 'Staff only');
  return jsonb_build_object(
    'orders', (select count(*) from public.orders where customer_id = p_user and status not in ('DRAFT')),
    'delivered', (select count(*) from public.orders where customer_id = p_user and status in ('DELIVERED', 'COLLECTED')),
    'failed', (select count(*) from public.orders where customer_id = p_user and status in ('FAILED_ATTEMPT', 'RETURNED', 'RETURNING_TO_SENDER')),
    'spend', (select coalesce(sum(quoted_fee + coalesce(extra_fee, 0)), 0) from public.orders where customer_id = p_user and status not in ('DRAFT', 'CANCELLED', 'PENDING_PAYMENT')),
    'cod', (select coalesce(sum(cod_amount), 0) from public.orders where customer_id = p_user and status not in ('DRAFT', 'CANCELLED')),
    'last_order_at', (select max(created_at) from public.orders where customer_id = p_user and status <> 'DRAFT'),
    'wallet_balance', (select balance from public.wallets where owner_type = 'customer' and owner_id = p_user limit 1),
    'tickets_open', (select count(*) from public.tickets where customer_id = p_user and status in ('open', 'pending')),
    'tickets_total', (select count(*) from public.tickets where customer_id = p_user),
    'avg_rating_given', (select round(avg(score), 1) from public.ratings where rater_id = p_user),
    'tags', coalesce((select tags from public.customer_crm where user_id = p_user), '{}'),
    'account_manager_id', (select account_manager_id from public.customer_crm where user_id = p_user),
    'is_vendor', exists (select 1 from public.vendors where owner_id = p_user),
    'is_rider', exists (select 1 from public.riders where id = p_user));
end $$;

-- Vendor 360: add spend, complaints and the churn threshold from settings to the existing vendor_stats.
create or replace function public.vendor_stats(p_vendor uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v public.vendors; wk int; avg4 numeric; drop_pct numeric;
begin
  select * into v from public.vendors where id = p_vendor;
  perform public._need(found and public.is_ops(v.city_id), 'Staff only');
  drop_pct := public._num_setting('churn_drop_percent', v.city_id, 30);
  select count(*) into wk from public.orders where vendor_id = p_vendor and created_at >= now() - interval '7 days' and status not in ('DRAFT','CANCELLED');
  select count(*) / 4.0 into avg4 from public.orders where vendor_id = p_vendor and created_at >= now() - interval '35 days'
     and created_at < now() - interval '7 days' and status not in ('DRAFT','CANCELLED');
  return jsonb_build_object(
    'orders_7d', wk, 'weekly_avg_4w', round(avg4, 1),
    'churn_risk', avg4 > 0 and wk <= avg4 * (1 - drop_pct / 100),
    'delivered_30d', (select count(*) from public.orders where vendor_id = p_vendor and status in ('DELIVERED','COLLECTED') and delivered_at > now() - interval '30 days'),
    'failed_30d', (select count(*) from public.orders where vendor_id = p_vendor and status in ('FAILED_ATTEMPT','RETURNED','RETURNING_TO_SENDER') and updated_at > now() - interval '30 days'),
    'orders_total', (select count(*) from public.orders where vendor_id = p_vendor and status not in ('DRAFT')),
    'spend_30d', (select coalesce(sum(quoted_fee + coalesce(extra_fee, 0)), 0) from public.orders where vendor_id = p_vendor
                  and status not in ('DRAFT','CANCELLED','PENDING_PAYMENT') and created_at > now() - interval '30 days'),
    'spend_total', (select coalesce(sum(quoted_fee + coalesce(extra_fee, 0)), 0) from public.orders where vendor_id = p_vendor and status not in ('DRAFT','CANCELLED','PENDING_PAYMENT')),
    'cod_collected_30d', (select coalesce(sum(c.amount), 0) from public.cod_collections c join public.orders o on o.id = c.order_id
                          where o.vendor_id = p_vendor and c.collected_at > now() - interval '30 days'),
    'cod_collected_not_paid', coalesce((select sum(amount) from public.cod_collections c join public.orders o on o.id = c.order_id
                                        where o.vendor_id = p_vendor and c.status <> 'paid_out'), 0),
    'tickets_open', (select count(*) from public.tickets t where (t.vendor_id = p_vendor or t.order_id in (select id from public.orders where vendor_id = p_vendor))
                       and t.status in ('open','pending')),
    'complaints_90d', (select count(*) from public.tickets t where (t.vendor_id = p_vendor or t.order_id in (select id from public.orders where vendor_id = p_vendor))
                       and t.created_at > now() - interval '90 days'),
    'wallet_balance', (select balance from public.wallets where owner_type = 'vendor' and owner_id = p_vendor limit 1),
    'pickup_rating', (select round(avg(score), 1) from public.ratings where vendor_id = p_vendor and kind = 'rider'));
end $$;

-- ---------- 5. leads pipeline ----------
create table public.leads (
  id               uuid primary key default gen_random_uuid(),
  business_name    text not null check (length(trim(business_name)) >= 2),
  contact_name     text,
  phone            text,
  email            text,
  city_id          uuid references public.cities(id),
  source           text not null default 'other',   -- instagram, referral, walk_in, field_sales, website, other
  stage            public.crm_stage not null default 'new',
  owner_id         uuid references public.profiles(id),          -- the account manager working it
  expected_weekly  integer check (expected_weekly >= 0),          -- parcels a week they say they send
  next_action      text,
  next_action_at   date,
  vendor_id        uuid unique references public.vendors(id),     -- set when they sign up
  lost_reason      text,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index leads_city_stage_idx on public.leads (city_id, stage);
create index leads_phone_idx on public.leads (phone);
create trigger leads_updated before update on public.leads for each row execute function public.set_updated_at();
create trigger audit_leads after insert or update of stage, owner_id, vendor_id or delete on public.leads for each row execute function public.audit_row();
alter table public.leads enable row level security;
create policy leads_read on public.leads for select to authenticated using (public.is_ops(city_id));
alter table public.crm_notes add constraint crm_notes_lead_fk foreign key (lead_id) references public.leads(id) on delete cascade;
create policy crm_notes_read on public.crm_notes for select to authenticated using (
  (vendor_id is not null and exists (select 1 from public.vendors v where v.id = crm_notes.vendor_id and public.is_ops(v.city_id)))
  or (customer_id is not null and exists (select 1 from public.profiles p where p.id = crm_notes.customer_id and public.is_ops(p.city_id)))
  or (lead_id is not null and exists (select 1 from public.leads l where l.id = crm_notes.lead_id and public.is_ops(l.city_id))));

create or replace function public._phone(p text) returns text language sql immutable as $$
  select case when d ~ '^0\d{9}$' then '+233' || substr(d, 2) when d ~ '^233\d{9}$' then '+' || d when d ~ '^\d{9}$' then '+233' || d
              when d = '' then null else '+' || d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') d) x;
$$;

create or replace function public._can_sell(p_city uuid) returns boolean language sql stable as $$
  select public.has_role(array['super_admin', 'city_admin', 'support']::public.app_role[], p_city);
$$;

/** Create or edit a lead (not its stage: use move_lead). */
create or replace function public.save_lead(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare l public.leads; city uuid := coalesce(nullif(p ->> 'city_id', '')::uuid, (select city_id from public.leads where id = p_id)); nid uuid := p_id;
begin
  perform public._need(public._can_sell(city), 'Only support or an admin can manage leads');
  if p ? 'source' then perform public._need(p ->> 'source' in ('instagram', 'facebook', 'tiktok', 'referral', 'walk_in', 'field_sales', 'website', 'whatsapp', 'other'), 'Unknown source'); end if;
  if p_id is null then
    perform public._need(length(coalesce(trim(p ->> 'business_name'), '')) >= 2, 'Business name is required');
    perform public._need(not exists (select 1 from public.leads where phone = public._phone(p ->> 'phone') and stage not in ('lost', 'churned')),
                         'A lead with this phone number already exists');
    insert into public.leads (business_name, contact_name, phone, email, city_id, source, owner_id, expected_weekly, next_action, next_action_at, created_by)
    values (trim(p ->> 'business_name'), p ->> 'contact_name', public._phone(p ->> 'phone'), nullif(p ->> 'email', ''), city,
            coalesce(p ->> 'source', 'other'), coalesce(nullif(p ->> 'owner_id', '')::uuid, auth.uid()), nullif(p ->> 'expected_weekly', '')::int,
            p ->> 'next_action', nullif(p ->> 'next_action_at', '')::date, auth.uid())
    returning id into nid;
    -- already a QCS vendor? link straight away
    update public.leads set vendor_id = v.id, stage = 'trial' from public.vendors v
     where leads.id = nid and v.owner_id is not null and public._phone(v.contact_phone) = leads.phone
       and not exists (select 1 from public.leads x where x.vendor_id = v.id);
  else
    select * into l from public.leads where id = p_id for update;
    perform public._need(found, 'Lead not found');
    update public.leads set
      business_name = coalesce(nullif(trim(p ->> 'business_name'), ''), business_name),
      contact_name = case when p ? 'contact_name' then p ->> 'contact_name' else contact_name end,
      phone = case when p ? 'phone' then public._phone(p ->> 'phone') else phone end,
      email = case when p ? 'email' then nullif(p ->> 'email', '') else email end,
      city_id = city, source = coalesce(p ->> 'source', source),
      owner_id = case when p ? 'owner_id' then nullif(p ->> 'owner_id', '')::uuid else owner_id end,
      expected_weekly = case when p ? 'expected_weekly' then nullif(p ->> 'expected_weekly', '')::int else expected_weekly end,
      next_action = case when p ? 'next_action' then p ->> 'next_action' else next_action end,
      next_action_at = case when p ? 'next_action_at' then nullif(p ->> 'next_action_at', '')::date else next_action_at end
    where id = p_id;
  end if;
  return nid;
end $$;

/** Move a lead along the pipeline. A note is kept on the lead's timeline. Linked vendors move with it. */
create or replace function public.move_lead(p_id uuid, p_stage public.crm_stage, p_note text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare l public.leads;
begin
  select * into l from public.leads where id = p_id for update;
  perform public._need(found and public._can_sell(l.city_id), 'Only support or an admin can manage leads');
  perform public._need(p_stage <> 'lost' or length(coalesce(trim(p_note), '')) >= 3, 'Say why the lead was lost');
  perform public._need(p_stage not in ('active', 'churn_risk', 'churned') or l.vendor_id is not null,
                       'A lead becomes Active once they have signed up as a vendor');
  perform set_config('qcs.audit_reason', coalesce(nullif(trim(p_note), ''), 'lead moved'), true);
  update public.leads set stage = p_stage, lost_reason = case when p_stage = 'lost' then trim(p_note) else lost_reason end where id = p_id;
  if l.vendor_id is not null then
    perform public._sys(1);
    update public.vendors set crm_stage = p_stage where id = l.vendor_id;
    perform public._sys(-1);
  end if;
  insert into public.crm_notes (lead_id, author_id, body)
  values (p_id, auth.uid(), 'Moved to ' || replace(p_stage::text, '_', ' ') || coalesce(': ' || nullif(trim(p_note), ''), ''));
end $$;

/** A new vendor sign-up whose phone matches a lead: link it and move both to Trial. */
create or replace function public.link_lead_on_signup() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare lid uuid;
begin
  if new.owner_id is null or (tg_op = 'UPDATE' and old.owner_id is not null) then return new; end if;
  select id into lid from public.leads
   where vendor_id is null and stage not in ('lost') and (phone = public._phone(new.contact_phone)
         or phone = (select phone from public.profiles where id = new.owner_id))
   order by created_at desc limit 1;
  if lid is not null then
    perform public._sys(1);
    update public.leads set vendor_id = new.id, stage = 'trial' where id = lid;
    update public.vendors set crm_stage = 'trial',
           account_manager_id = coalesce(account_manager_id, (select owner_id from public.leads where id = lid)) where id = new.id;
    perform public._sys(-1);
  end if;
  return new;
end $$;
create trigger vendors_link_lead after insert or update of owner_id on public.vendors for each row execute function public.link_lead_on_signup();

-- ---------- 6. churn alerts + automatic stages (daily) ----------
create table public.crm_alerts (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors(id) on delete cascade,
  city_id      uuid references public.cities(id),
  kind         text not null default 'churn' check (kind in ('churn')),
  week_start   date not null,
  this_week    integer not null,
  weekly_avg   numeric(8, 1) not null,
  drop_percent integer not null,
  status       text not null default 'open' check (status in ('open', 'done')),
  handled_by   uuid references public.profiles(id),
  handled_note text,
  handled_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (vendor_id, kind, week_start)
);
create index crm_alerts_open_idx on public.crm_alerts (city_id, status, created_at desc);
alter table public.crm_alerts enable row level security;
create policy crm_alerts_read on public.crm_alerts for select to authenticated using (public.is_ops(city_id));

create or replace function public.handle_crm_alert(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a public.crm_alerts;
begin
  select * into a from public.crm_alerts where id = p_id for update;
  perform public._need(found and public._can_sell(a.city_id), 'Only support or an admin can handle alerts');
  perform public._need(length(coalesce(trim(p_note), '')) >= 5, 'Write what you did (e.g. called the owner)');
  update public.crm_alerts set status = 'done', handled_by = auth.uid(), handled_note = trim(p_note), handled_at = now() where id = p_id;
  insert into public.crm_notes (vendor_id, author_id, body) values (a.vendor_id, auth.uid(), 'Churn alert handled: ' || trim(p_note));
end $$;

/**
 * Daily (05:30): flags vendors whose orders this week are ≥ churn_drop_percent below their 4-week average
 * (and who send at least churn_min_weekly_orders a week), notifies their account manager, moves stages:
 * new → trial on first order, trial → active after lead_active_after_orders deliveries, churn risk → active on recovery,
 * churn risk → churned after 5 weeks without orders.
 */
create or replace function public.crm_daily() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r record; flagged int := 0; recovered int := 0; wk date := date_trunc('week', now() at time zone 'Africa/Accra')::date;
        min_avg numeric := public.setting_int('churn_min_weekly_orders', 5); active_after int := public.setting_int('lead_active_after_orders', 5)::int;
        a public.crm_alerts;
begin
  perform public._sys(1);
  for r in
    select v.id, v.city_id, v.business_name, v.crm_stage, v.account_manager_id,
           (select count(*) from public.orders o where o.vendor_id = v.id and o.created_at >= now() - interval '7 days' and o.status not in ('DRAFT','CANCELLED')) wk,
           (select count(*) / 4.0 from public.orders o where o.vendor_id = v.id and o.created_at >= now() - interval '35 days'
              and o.created_at < now() - interval '7 days' and o.status not in ('DRAFT','CANCELLED')) avg4,
           (select count(*) from public.orders o where o.vendor_id = v.id and o.status in ('DELIVERED','COLLECTED')) delivered,
           (select count(*) from public.orders o where o.vendor_id = v.id and o.status not in ('DRAFT','CANCELLED')) total,
           public._num_setting('churn_drop_percent', v.city_id, 30) drop_pct
    from public.vendors v where v.owner_id is not null
  loop
    if r.avg4 >= min_avg and r.wk <= r.avg4 * (1 - r.drop_pct / 100) then
      if r.crm_stage <> 'churn_risk' then update public.vendors set crm_stage = 'churn_risk' where id = r.id; end if;
      insert into public.crm_alerts (vendor_id, city_id, week_start, this_week, weekly_avg, drop_percent)
      values (r.id, r.city_id, wk, r.wk, round(r.avg4, 1), round(100 - r.wk * 100 / r.avg4))
      on conflict (vendor_id, kind, week_start) do nothing returning * into a;
      if a.id is not null then
        flagged := flagged + 1;
        perform public._enqueue(u.user_id, null, null, 'churn_alert', jsonb_build_object('vendor', r.business_name, 'vendor_id', r.id,
                  'this_week', r.wk, 'weekly_avg', round(r.avg4, 1), 'drop_percent', a.drop_percent))
        from (select r.account_manager_id user_id where r.account_manager_id is not null
              union select user_id from public.user_roles where r.account_manager_id is null and role in ('support', 'city_admin')
                    and (city_id is null or city_id = r.city_id)) u;
      end if;
      a := null;
    elsif r.crm_stage = 'churn_risk' and r.avg4 > 0 and r.wk > r.avg4 * (1 - r.drop_pct / 100) then
      update public.vendors set crm_stage = 'active' where id = r.id; recovered := recovered + 1;
      update public.crm_alerts set status = 'done', handled_note = coalesce(handled_note, 'Recovered by itself'), handled_at = coalesce(handled_at, now())
       where vendor_id = r.id and status = 'open';
    elsif r.crm_stage = 'churn_risk' and r.wk = 0 and r.avg4 = 0 then
      update public.vendors set crm_stage = 'churned' where id = r.id;
    elsif r.crm_stage = 'new' and r.total > 0 then
      update public.vendors set crm_stage = case when r.delivered >= active_after then 'active' else 'trial' end::public.crm_stage where id = r.id;
    elsif r.crm_stage = 'trial' and r.delivered >= active_after then
      update public.vendors set crm_stage = 'active' where id = r.id;
    end if;
  end loop;
  -- leads follow their vendor
  update public.leads l set stage = v.crm_stage from public.vendors v where v.id = l.vendor_id and l.stage is distinct from v.crm_stage;
  perform public._sys(-1);
  return jsonb_build_object('flagged', flagged, 'recovered', recovered);
end $$;

-- ---------- 7. segments & broadcast campaigns ----------
alter table public.profiles add column unsubscribe_token text unique default encode(extensions.gen_random_bytes(12), 'hex');
update public.profiles set unsubscribe_token = encode(extensions.gen_random_bytes(12), 'hex') where unsubscribe_token is null;

create table public.segments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  audience   text not null check (audience in ('customers', 'vendors')),
  city_id    uuid references public.cities(id),
  filters    jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.segments enable row level security;
create policy segments_read on public.segments for select to authenticated using (public.is_ops(city_id));

create table public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  segment_id    uuid not null references public.segments(id),
  city_id       uuid references public.cities(id),
  channels      text[] not null check (channels <@ array['push', 'sms', 'whatsapp', 'email'] and cardinality(channels) > 0),
  title         text not null default 'QCS',          -- push title / email subject
  message       text not null check (length(message) between 5 and 600),
  wa_template   text,                                  -- Meta-approved marketing template; the message fills its {{1}}
  status        text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at  timestamptz,
  approved_by   uuid references public.profiles(id),
  created_by    uuid references public.profiles(id),
  recipients    integer not null default 0,
  messages      integer not null default 0,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index campaigns_due_idx on public.campaigns (scheduled_at) where status in ('scheduled', 'sending');
alter table public.campaigns enable row level security;
create policy campaigns_read on public.campaigns for select to authenticated using (public.is_ops(city_id));
create trigger audit_campaigns after insert or update of status, approved_by, scheduled_at on public.campaigns for each row execute function public.audit_row();

create table public.campaign_recipients (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (campaign_id, user_id)
);
alter table public.campaign_recipients enable row level security;
create policy campaign_recipients_read on public.campaign_recipients for select to authenticated
  using (exists (select 1 from public.campaigns c where c.id = campaign_recipients.campaign_id and public.is_ops(c.city_id)));

/**
 * Who is in a segment. ONLY people who ticked "send me offers" (marketing_opt_in) are ever returned.
 * Filters (all optional): ordered_within_days, inactive_days (ordered before, but not in N days), min_orders,
 * account_type (vendor/corporate, vendors only), stages (vendors only), tags, service (express/ecommerce/intercity).
 */
create or replace function public.segment_members(p_audience text, p_filters jsonb, p_city uuid)
returns table (user_id uuid, full_name text, phone text, email text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare f jsonb := coalesce(p_filters, '{}');
        within int := nullif(f ->> 'ordered_within_days', '')::int; idle int := nullif(f ->> 'inactive_days', '')::int;
        min_o int := nullif(f ->> 'min_orders', '')::int; f_tags text[] := array(select jsonb_array_elements_text(coalesce(f -> 'tags', '[]')));
        f_stages text[] := array(select jsonb_array_elements_text(coalesce(f -> 'stages', '[]'))); svc text := nullif(f ->> 'service', '');
begin
  if not (public.is_trusted() or public.is_ops(p_city)) then raise exception 'Staff only'; end if;
  if p_audience = 'vendors' then
    return query
    select p.id, p.full_name, p.phone, p.email
    from public.vendors v join public.profiles p on p.id = v.owner_id
    where p.marketing_opt_in and p.is_active and (p_city is null or v.city_id = p_city)
      and (nullif(f ->> 'account_type', '') is null or v.account_type::text = f ->> 'account_type')
      and (cardinality(f_stages) = 0 or v.crm_stage::text = any (f_stages))
      and (cardinality(f_tags) = 0 or v.tags && f_tags)
      and (within is null or exists (select 1 from public.orders o where o.vendor_id = v.id and o.status <> 'DRAFT' and o.created_at > now() - make_interval(days => within)))
      and (idle is null or (exists (select 1 from public.orders o where o.vendor_id = v.id and o.status <> 'DRAFT')
                            and not exists (select 1 from public.orders o where o.vendor_id = v.id and o.created_at > now() - make_interval(days => idle))))
      and (min_o is null or (select count(*) from public.orders o where o.vendor_id = v.id and o.status not in ('DRAFT', 'CANCELLED')) >= min_o)
      and (svc is null or exists (select 1 from public.orders o where o.vendor_id = v.id and o.service_type::text = svc));
  else
    return query
    select p.id, p.full_name, p.phone, p.email
    from public.profiles p
    where p.marketing_opt_in and p.is_active and (p_city is null or p.city_id = p_city)
      and not exists (select 1 from public.vendors v where v.owner_id = p.id)
      and not exists (select 1 from public.riders r where r.id = p.id)
      and not exists (select 1 from public.user_roles ur where ur.user_id = p.id and ur.role not in ('customer'))
      and (cardinality(f_tags) = 0 or coalesce((select c.tags from public.customer_crm c where c.user_id = p.id), '{}') && f_tags)
      and (within is null or exists (select 1 from public.orders o where o.customer_id = p.id and o.status <> 'DRAFT' and o.created_at > now() - make_interval(days => within)))
      and (idle is null or (exists (select 1 from public.orders o where o.customer_id = p.id and o.status <> 'DRAFT')
                            and not exists (select 1 from public.orders o where o.customer_id = p.id and o.created_at > now() - make_interval(days => idle))))
      and (min_o is null or (select count(*) from public.orders o where o.customer_id = p.id and o.status not in ('DRAFT', 'CANCELLED')) >= min_o)
      and (svc is null or exists (select 1 from public.orders o where o.customer_id = p.id and o.service_type::text = svc));
  end if;
end $$;
revoke execute on function public.segment_members(text, jsonb, uuid) from public, anon, authenticated;

/** How many people a segment reaches, per channel, before anything is sent (SMS costs money per message). */
create or replace function public.segment_preview(p_audience text, p_filters jsonb, p_city uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public._need(public.is_ops(p_city), 'Staff only');
  perform public._need(p_audience in ('customers', 'vendors'), 'Choose customers or vendors');
  return (select jsonb_build_object(
    'people', count(*),
    'push', count(*) filter (where exists (select 1 from public.push_tokens t where t.user_id = m.user_id)),
    'sms', count(*) filter (where m.phone is not null),
    'whatsapp', count(*) filter (where m.phone is not null),
    'email', count(*) filter (where m.email is not null),
    'sample', coalesce((select jsonb_agg(x.full_name) from (select full_name from public.segment_members(p_audience, p_filters, p_city) limit 5) x), '[]'))
    from public.segment_members(p_audience, p_filters, p_city) m);
end $$;

create or replace function public.save_segment(p_id uuid, p_name text, p_audience text, p_filters jsonb, p_city uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare nid uuid := p_id;
begin
  perform public._need(public._can_sell(p_city) and (p_city is not null or public.has_role(array['super_admin', 'support']::public.app_role[])),
                       'Only support or an admin can make segments');
  perform public._need(length(coalesce(trim(p_name), '')) >= 2, 'Give the segment a name');
  perform public._need(p_audience in ('customers', 'vendors'), 'Choose customers or vendors');
  if p_id is null then
    insert into public.segments (name, audience, city_id, filters, created_by) values (trim(p_name), p_audience, p_city, coalesce(p_filters, '{}'), auth.uid()) returning id into nid;
  else
    update public.segments set name = trim(p_name), audience = p_audience, city_id = p_city, filters = coalesce(p_filters, '{}'), updated_at = now()
     where id = p_id and public.is_ops(city_id);
    perform public._need(found, 'Segment not found');
  end if;
  return nid;
end $$;

/** Create or edit a draft campaign. */
create or replace function public.save_campaign(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare s public.segments; c public.campaigns; nid uuid := p_id; chans text[] := array(select jsonb_array_elements_text(coalesce(p -> 'channels', '[]')));
begin
  select * into s from public.segments where id = (p ->> 'segment_id')::uuid;
  perform public._need(found, 'Choose a segment');
  perform public._need(public._can_sell(s.city_id), 'Only support or an admin can prepare campaigns');
  perform public._need(cardinality(chans) > 0 and chans <@ array['push', 'sms', 'whatsapp', 'email'], 'Choose at least one channel');
  perform public._need(length(coalesce(trim(p ->> 'message'), '')) between 5 and 600, 'Message must be 5–600 characters');
  perform public._need(not ('whatsapp' = any (chans)) or nullif(trim(p ->> 'wa_template'), '') is not null,
                       'WhatsApp offers need a Meta-approved template name');
  if p_id is null then
    insert into public.campaigns (name, segment_id, city_id, channels, title, message, wa_template, created_by)
    values (coalesce(nullif(trim(p ->> 'name'), ''), 'Campaign'), s.id, s.city_id, chans, coalesce(nullif(trim(p ->> 'title'), ''), 'QCS'),
            trim(p ->> 'message'), nullif(trim(p ->> 'wa_template'), ''), auth.uid()) returning id into nid;
  else
    select * into c from public.campaigns where id = p_id for update;
    perform public._need(found and c.status = 'draft', 'Only drafts can be edited');
    update public.campaigns set name = coalesce(nullif(trim(p ->> 'name'), ''), name), segment_id = s.id, city_id = s.city_id, channels = chans,
           title = coalesce(nullif(trim(p ->> 'title'), ''), title), message = trim(p ->> 'message'), wa_template = nullif(trim(p ->> 'wa_template'), ''), updated_at = now()
     where id = p_id;
  end if;
  return nid;
end $$;

/** Approve and schedule (or send now). Only an Admin: support can prepare, an admin presses send. */
create or replace function public.schedule_campaign(p_id uuid, p_at timestamptz default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c public.campaigns;
begin
  select * into c from public.campaigns where id = p_id for update;
  perform public._need(found, 'Campaign not found');
  perform public._need(public.is_admin(c.city_id) and (c.city_id is not null or public.has_role(array['super_admin']::public.app_role[])),
                       'Only an Admin can send campaigns');
  perform public._need(c.status = 'draft', 'This campaign was already scheduled or sent');
  perform public._need(p_at is null or p_at > now() - interval '5 minutes', 'Pick a time in the future');
  update public.campaigns set status = 'scheduled', scheduled_at = coalesce(p_at, now()), approved_by = auth.uid(), updated_at = now() where id = p_id;
end $$;

create or replace function public.cancel_campaign(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c public.campaigns;
begin
  select * into c from public.campaigns where id = p_id for update;
  perform public._need(found and public._can_sell(c.city_id), 'Not allowed');
  perform public._need(c.status in ('draft', 'scheduled', 'sending'), 'Already finished');
  update public.campaigns set status = 'cancelled', updated_at = now() where id = p_id;
  -- messages not yet handed to the sender are dropped
  update public.notifications set status = 'skipped', error = 'campaign cancelled'
   where status = 'queued' and template = 'broadcast' and payload ->> 'campaign_id' = p_id::text;
end $$;

/** Every minute: turn due campaigns into messages, 2,000 people per run, never twice to the same person. */
create or replace function public.campaign_tick() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c public.campaigns; s public.segments; n int; total int := 0; site text := rtrim(public._setting('public_site_url', '"https://qcsghana.com"') #>> '{}', '/');
begin
  for c in select * from public.campaigns where status in ('scheduled', 'sending') and scheduled_at <= now() order by scheduled_at for update skip locked loop
    select * into s from public.segments where id = c.segment_id;
    with picked as (
      insert into public.campaign_recipients (campaign_id, user_id)
      select c.id, m.user_id from public.segment_members(s.audience, s.filters, s.city_id) m
      where not exists (select 1 from public.campaign_recipients r where r.campaign_id = c.id and r.user_id = m.user_id)
      limit 2000
      returning user_id
    ), msgs as (
      insert into public.notifications (user_id, channel, template, payload)
      select pk.user_id, ch::public.notification_channel, 'broadcast', jsonb_build_object(
               'campaign_id', c.id, 'title', c.title, 'message', c.message, 'wa_template', c.wa_template,
               'unsubscribe_url', site || '/u/' || p.unsubscribe_token)
      from picked pk join public.profiles p on p.id = pk.user_id cross join unnest(c.channels) ch
      returning 1
    )
    select (select count(*) from picked), (select count(*) from msgs) into n, total;
    if n = 0 then
      update public.campaigns set status = 'sent', sent_at = now(), updated_at = now() where id = c.id;
    else
      update public.campaigns set status = 'sending', recipients = recipients + n, messages = messages + total, updated_at = now() where id = c.id;
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.campaign_tick() from public, anon, authenticated;

/** The unsubscribe link in every offer (no login). */
create or replace function public.unsubscribe(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles;
begin
  select * into p from public.profiles where unsubscribe_token = p_token and length(p_token) >= 16;
  if not found then return jsonb_build_object('ok', false); end if;
  perform public._sys(1);
  update public.profiles set marketing_opt_in = false where id = p.id;
  perform public._sys(-1);
  return jsonb_build_object('ok', true, 'name', split_part(p.full_name, ' ', 1));
end $$;
grant execute on function public.unsubscribe(text) to anon, authenticated;

-- The sender worker: offers to people who opted out since the campaign started are skipped; WhatsApp can be free text
-- (support replies inside the 24-hour window) or use the template named in the message (campaigns).
create or replace function public.claim_notifications(p_limit int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n record; t public.notification_templates; dest jsonb; data jsonb; wa text;
begin
  for n in
    select * from public.notifications
     where (status = 'queued' and next_attempt_at <= now()) or (status = 'sending' and next_attempt_at < now() - interval '5 minutes')
     order by next_attempt_at limit p_limit for update skip locked
  loop
    select * into t from public.notification_templates where key = n.template and channel = n.channel;
    if not found or not t.enabled then
      update public.notifications set status = 'skipped', error = 'no active template' where id = n.id; continue;
    end if;
    if n.template = 'broadcast' and not coalesce((select marketing_opt_in from public.profiles where id = n.user_id), false) then
      update public.notifications set status = 'skipped', error = 'opted out' where id = n.id; continue;
    end if;
    data := n.payload || jsonb_build_object(
      'amount_ghs', to_char(coalesce((n.payload ->> 'amount')::numeric, 0) / 100, 'FM999990.00'));
    dest := case n.channel
      when 'push' then (select to_jsonb(array_agg(token)) from public.push_tokens where user_id = n.user_id)
      when 'email' then to_jsonb(coalesce(n.to_address, (select email from public.profiles where id = n.user_id)))
      else to_jsonb(coalesce(n.to_address, (select phone from public.profiles where id = n.user_id))) end;
    if dest is null or dest = 'null'::jsonb then
      update public.notifications set status = 'skipped', error = 'no ' || n.channel || ' address' where id = n.id; continue;
    end if;
    wa := case when coalesce((n.payload ->> 'wa_text')::boolean, false) then null else coalesce(nullif(n.payload ->> 'wa_template', ''), t.wa_template) end;
    update public.notifications set status = 'sending', attempts = attempts + 1, next_attempt_at = now() where id = n.id;
    return next jsonb_build_object(
      'id', n.id, 'channel', n.channel, 'to', dest, 'key', n.template,
      'subject', public._render(t.subject, data), 'body', public._render(t.body, data),
      'wa_template', wa,
      'wa_params', (select coalesce(jsonb_agg(coalesce(data ->> m[1], '') order by ord), '[]'::jsonb)
                    from regexp_matches(t.body, '\{\{([a-z_]+)\}\}', 'g') with ordinality as x(m, ord)),
      'data', jsonb_build_object('order_id', n.order_id, 'key', n.template) || (n.payload - 'code'));
  end loop;
end $$;
revoke all on function public.claim_notifications(int) from public, anon, authenticated;
grant execute on function public.claim_notifications(int) to service_role;

-- ---------- 8. help centre ----------
create table public.help_articles (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9-]{3,60}$'),
  audience   text not null check (audience in ('all', 'client', 'vendor', 'rider')),
  category   text not null,
  title      text not null,
  body       text not null,            -- plain text; blank lines separate paragraphs, lines starting "- " are bullets
  sort       integer not null default 100,
  published  boolean not null default true,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
alter table public.help_articles enable row level security;
create policy help_read on public.help_articles for select to anon, authenticated using (published or public.is_ops());
create policy help_write on public.help_articles for all to authenticated
  using (public.has_role(array['super_admin', 'support']::public.app_role[]))
  with check (public.has_role(array['super_admin', 'support']::public.app_role[]));
create trigger help_articles_touch before update on public.help_articles for each row execute function public.touch_template();
grant select on public.help_articles to anon;

insert into public.help_articles (slug, audience, category, title, body, sort) values
('how-to-book', 'all', 'Booking', 'How do I book a delivery?',
 'Open the QCS app (or the business portal) and tap "Book a delivery".

- Choose Express (a rider comes now), E-commerce (up to 25 drop-offs in one trip) or Inter-city.
- Enter the pickup and drop-off: search the address, drop a pin, or type a Ghana Post GPS code like GA-123-4567.
- You see the price before you confirm. Express prices are locked when you book, even if traffic is bad.

The recipient gets a link to confirm their location, so the rider goes to the right place.', 10),
('prices', 'all', 'Booking', 'How are prices worked out?',
 '- Express: a base fee plus distance and time, with extras for heavy, fragile or night deliveries.
- E-commerce: a fixed price per drop-off, based on the parcel weight and the destination zone.
- Inter-city: a fixed price from one hub to another by weight, plus a doorstep fee if we deliver to the door.

A failed or returned delivery is charged 50% of the delivery fee. Use the rate calculator on our website to check a price any time.', 20),
('delivery-code', 'all', 'Delivery', 'What is the 4-digit delivery code?',
 'When a parcel is on its way, the recipient gets a 4-digit code by SMS or WhatsApp. They give it to the rider only when they have the parcel in their hands, and sign on the rider''s phone.

This protects you: the rider cannot mark the parcel delivered without the code. Never share the code before you receive the parcel.', 30),
('track-parcel', 'all', 'Delivery', 'How do I track my parcel?',
 'Open "My deliveries" in the app and tap the parcel to see the rider on the map and the arrival time. Anyone can also check the status on qcsghana.com/track with the tracking number (for example ACC-202611041301-KUM). Address details need the last 4 digits of the recipient''s phone.', 40),
('failed-delivery', 'all', 'Delivery', 'What happens if a delivery fails?',
 'If the rider cannot deliver (recipient not reachable, wrong address, refused), they record the reason and we contact you to arrange another attempt or a return to the sender. A failed or returned delivery is charged 50% of the original delivery fee.', 50),
('insurance-claims', 'all', 'Claims', 'Insurance, lost and damaged parcels',
 '- Items declared at GHS 1,000 or more can be insured for 5% of the declared value.
- Insured parcels that are lost or damaged are refunded the full declared value.
- Uninsured lost parcels are compensated at 3 times the delivery fee.
- Uninsured damaged parcels are reviewed case by case.

To claim, tap "Report a problem" on the delivery, choose "Damaged" or "Missing" and add photos. These reports are top priority.', 60),
('cod', 'vendor', 'Money', 'How does Cash on Delivery (COD) work?',
 'The rider collects the item price from your customer and hands the cash in to QCS by the end of the day. You receive the full COD amount on your payout schedule (daily or weekly) by MoMo. Our delivery fees are billed separately and never taken out of your COD.

If your delivery fees are more than 7 days overdue, your next COD payout is held until they are paid.', 70),
('wallet', 'all', 'Money', 'Wallet top-ups and refunds',
 'Top up your wallet with MoMo or card and pay for deliveries from it. You can ask for your balance back at any time: it is refunded to the same MoMo number you topped up from.', 80),
('intercity', 'all', 'Inter-city', 'Sending to another city',
 'We carry parcels between our hubs in Accra, Kumasi, Takoradi and Tamale by bus. Choose "collect at the hub" (the recipient picks it up with their code) or "doorstep" (a rider delivers it). The recipient is told when the parcel is ready.', 90),
('fulfilment', 'vendor', 'Fulfilment', 'Storing stock with QCS (fulfilment)',
 'Send your stock to a QCS hub and book deliveries "from my stock". We pick, pack and send each order. You see your stock per hub on the portal''s Stock page and get an alert when stock runs low. Fees: a monthly storage fee per item and a pick & pack fee per order.', 100),
('rider-payouts', 'rider', 'Earnings', 'When do I get paid?',
 'Your earnings show in the app under "My earnings & cash". Payouts go to your MoMo number every week. You can also ask for an instant cash-out for a small fee. Payouts are held if you still have COD cash that was due to be handed in.', 110),
('rider-cash', 'rider', 'Earnings', 'Handing in COD cash',
 'Hand in all the cash you collected by the end of the day: pay by MoMo in the app ("Pay by MoMo") or at the hub. Until you do, you will not get new COD jobs.', 120),
('rider-delivery-problems', 'rider', 'On the job', 'The recipient has no code / cannot be reached',
 'Call the recipient from the job screen. If they really cannot give the code (for example no phone), ask for an override: take a photo, write a note and wait for support to approve. If they are not there, report a failed attempt with the reason.', 130),
('contact-us', 'all', 'Support', 'How do I contact QCS support?',
 'Tap "Report a problem" on any delivery, or "Contact support" in Help. You can also message us on WhatsApp. We answer within 1 working hour (Mon–Sat, 8am–6pm) and aim to solve every problem within a working day.', 140);

-- ---------- 9. customer service for vendors (§11) ----------
create table public.order_contacts (
  id         bigint generated always as identity primary key,
  order_id   uuid not null references public.orders(id) on delete cascade,
  vendor_id  uuid not null references public.vendors(id),
  agent_id   uuid references public.profiles(id),
  kind       text not null check (kind in ('call', 'whatsapp', 'sms')),
  outcome    text not null check (outcome in ('confirmed', 'no_answer', 'rescheduled', 'cancelled_by_customer', 'question', 'message_sent', 'other')),
  note       text,
  created_at timestamptz not null default now()
);
create index order_contacts_order_idx on public.order_contacts (order_id, created_at);
create index order_contacts_vendor_idx on public.order_contacts (vendor_id, created_at desc);
alter table public.order_contacts enable row level security;
-- the vendor sees every call/chat about their orders; staff see their cities
create policy order_contacts_read on public.order_contacts for select to authenticated using (
  vendor_id in (select public.my_vendor_ids())
  or exists (select 1 from public.orders o where o.id = order_contacts.order_id and public.is_ops(o.city_id)));

create or replace function public._cs_order(p_order uuid) returns public.orders
language plpgsql stable security definer set search_path = public, extensions as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order;
  perform public._need(found, 'Order not found');
  perform public._need(public.has_role(array['super_admin', 'city_admin', 'support']::public.app_role[], o.city_id), 'Only customer-service agents can do this');
  perform public._need(exists (select 1 from public.vendors where id = o.vendor_id and cs_service_enabled), 'This vendor has not bought the customer-service service');
  return o;
end $$;

/** Log a call or chat with the vendor's customer, against the order. */
create or replace function public.log_contact(p_order uuid, p_kind text, p_outcome text, p_note text default null) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders := public._cs_order(p_order); nid bigint;
begin
  insert into public.order_contacts (order_id, vendor_id, agent_id, kind, outcome, note)
  values (o.id, o.vendor_id, auth.uid(), p_kind, p_outcome, nullif(trim(p_note), '')) returning id into nid;
  return nid;
end $$;

/** Message the vendor's customer from the QCS number: "QCS on behalf of <vendor>: …". */
create or replace function public.cs_message(p_order uuid, p_text text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders := public._cs_order(p_order); vname text;
begin
  perform public._need(length(coalesce(trim(p_text), '')) between 5 and 500, 'Message must be 5–500 characters');
  select business_name into vname from public.vendors where id = o.vendor_id;
  perform public._enqueue(null, o.recipient_phone, o.id, 'cs_message', jsonb_build_object('vendor_name', vname, 'message', trim(p_text),
            'tracking_number', o.tracking_number));
  insert into public.order_contacts (order_id, vendor_id, agent_id, kind, outcome, note)
  values (o.id, o.vendor_id, auth.uid(), 'whatsapp', 'message_sent', trim(p_text));
end $$;

-- Fee per delivered order for vendors with the service, billed to the vendor wallet once.
create table public.cs_charges (
  order_id   uuid primary key references public.orders(id),
  vendor_id  uuid not null references public.vendors(id),
  amount     bigint not null check (amount > 0),
  ledger_tx  uuid references public.ledger_transactions(id),
  created_at timestamptz not null default now()
);
alter table public.cs_charges enable row level security;
create policy cs_charges_read on public.cs_charges for select to authenticated using (vendor_id in (select public.my_vendor_ids('wallet')) or public.is_finance());

create or replace function public.charge_cs_fee() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders; fee bigint; tx uuid;
begin
  if new.to_status::text not in ('DELIVERED', 'COLLECTED') then return null; end if;
  select * into o from public.orders where id = new.order_id;
  if o.vendor_id is null or not exists (select 1 from public.vendors where id = o.vendor_id and cs_service_enabled) then return null; end if;
  if exists (select 1 from public.cs_charges where order_id = o.id) then return null; end if;
  fee := coalesce(public._num_setting('cs_fee_per_order', o.city_id, 200), 0)::bigint;
  if fee <= 0 then return null; end if;
  tx := public._ledger('cs_fee', 'Customer service ' || o.tracking_number, jsonb_build_array(
    jsonb_build_object('wallet_id', public.wallet_for('vendor', o.vendor_id), 'amount', -fee),
    jsonb_build_object('wallet_id', public.sys_wallet('QCS_REVENUE'), 'amount', fee)), o.id);
  insert into public.cs_charges (order_id, vendor_id, amount, ledger_tx) values (o.id, o.vendor_id, fee, tx);
  return null;
end $$;
create trigger order_events_cs_fee after insert on public.order_events for each row execute function public.charge_cs_fee();

-- ---------- notification templates ----------
insert into public.notification_templates (key, channel, audience, subject, body, wa_template, essential, description) values
  ('ticket_received', 'push', 'any', 'We got your message', 'Ticket #{{ticket_number}}: we''ll reply soon ({{hours}}).', null, true, 'Support: ticket opened'),
  ('ticket_reply', 'push', 'any', 'QCS Support replied', '#{{ticket_number}}: {{message}}', null, true, 'Support: staff replied'),
  ('ticket_reply', 'email', 'any', 'QCS Support: ticket #{{ticket_number}}', 'Hello,\n\n{{message}}\n\nReply in the QCS app (Help → My tickets).\n\nQCS Support', null, false, 'Support: staff replied'),
  ('ticket_reply', 'sms', 'any', '', 'QCS Support (#{{ticket_number}}): {{message}}', null, false, 'Support: staff replied (always sent to people without an account; others only if they turned SMS on)'),
  ('ticket_reply_wa', 'whatsapp', 'any', '', 'QCS Support (#{{ticket_number}}): {{message}}', 'qcs_support_reply', true, 'Support: reply on WhatsApp'),
  ('ticket_new', 'push', 'staff', 'New ticket #{{ticket_number}}', '{{subject}}', null, true, 'Support: new ticket'),
  ('ticket_customer_reply', 'push', 'staff', 'Customer replied #{{ticket_number}}', '{{message}}', null, true, 'Support: customer answered'),
  ('ticket_sla', 'push', 'staff', 'Ticket #{{ticket_number}} is overdue', '{{what}} time passed: {{subject}}', null, true, 'Support: SLA missed'),
  ('churn_alert', 'push', 'staff', 'Churn risk: {{vendor}}', '{{this_week}} orders this week vs {{weekly_avg}} a week before ({{drop_percent}}% down). Give them a call.', null, true, 'Vendor volume dropped'),
  ('cs_message', 'sms', 'recipient', '', 'QCS on behalf of {{vendor_name}}: {{message}}', null, true, 'Customer service message to a vendor''s customer'),
  ('cs_message', 'whatsapp', 'recipient', '', 'QCS on behalf of {{vendor_name}}: {{message}}', 'qcs_on_behalf_of', true, 'Customer service message to a vendor''s customer'),
  ('broadcast', 'push', 'any', '{{title}}', '{{message}}', null, true, 'Campaign (offers)'),
  ('broadcast', 'sms', 'any', '', '{{message}} Opt out: {{unsubscribe_url}}', null, true, 'Campaign (offers)'),
  ('broadcast', 'whatsapp', 'any', '', '{{message}}', null, true, 'Campaign (offers) — uses the campaign''s template; reply STOP to opt out'),
  ('broadcast', 'email', 'any', '{{title}}', '{{message}}\n\n—\nYou get this because you asked for QCS offers. Unsubscribe: {{unsubscribe_url}}', null, true, 'Campaign (offers)')
on conflict do nothing;

-- ---------- SLA watcher (every 5 minutes) ----------
create or replace function public.ticket_sla_tick() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t public.tickets; n int := 0; closed int;
begin
  for t in select * from public.tickets where status = 'open' and first_responded_at is null and not first_breach_alerted and first_response_due < now() for update skip locked loop
    perform public._notify_support(t, 'ticket_sla', jsonb_build_object('what', 'First reply'));
    update public.tickets set first_breach_alerted = true where id = t.id; n := n + 1;
  end loop;
  for t in select * from public.tickets where status = 'open' and not resolve_breach_alerted and resolution_due < now() for update skip locked loop
    perform public._notify_support(t, 'ticket_sla', jsonb_build_object('what', 'Resolution'));
    update public.tickets set resolve_breach_alerted = true where id = t.id; n := n + 1;
  end loop;
  update public.tickets set status = 'closed', closed_at = now()
   where status = 'resolved' and resolved_at < now() - make_interval(days => public.setting_int('ticket_autoclose_days', 7)::int);
  get diagnostics closed = row_count;
  return jsonb_build_object('alerts', n, 'closed', closed);
end $$;

/** Ticket list with SLA state, for the support queue. */
create or replace function public.ticket_sla_state(t public.tickets) returns text
language sql stable as $$
  select case
    when t.status in ('resolved', 'closed') then case when t.resolved_at is not null and t.resolved_at > t.resolution_due then 'resolved_late' else 'met' end
    when t.first_responded_at is null and now() > t.first_response_due then 'reply_overdue'
    when t.status = 'open' and now() > t.resolution_due then 'resolve_overdue'
    when t.first_responded_at is null then 'awaiting_reply'
    when t.status = 'pending' then 'waiting_customer'
    else 'on_track' end;
$$;

/** Support numbers for the CRM overview. */
create or replace function public.support_overview(p_city uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform public._need(public.is_ops(p_city), 'Staff only');
  return (select jsonb_build_object(
    'open', count(*) filter (where status = 'open'),
    'waiting_customer', count(*) filter (where status = 'pending'),
    'urgent_open', count(*) filter (where status in ('open', 'pending') and priority = 'urgent'),
    'reply_overdue', count(*) filter (where status = 'open' and first_responded_at is null and first_response_due < now()),
    'resolve_overdue', count(*) filter (where status = 'open' and resolution_due < now()),
    'unassigned', count(*) filter (where status in ('open', 'pending') and assigned_to is null),
    'whatsapp_open', count(*) filter (where status in ('open', 'pending') and channel = 'whatsapp'),
    'first_reply_met_7d', round(100.0 * count(*) filter (where created_at > now() - interval '7 days' and first_responded_at <= first_response_due)
                          / nullif(count(*) filter (where created_at > now() - interval '7 days' and first_responded_at is not null), 0)),
    'resolved_in_time_7d', round(100.0 * count(*) filter (where resolved_at > now() - interval '7 days' and resolved_at <= resolution_due)
                          / nullif(count(*) filter (where resolved_at > now() - interval '7 days'), 0)),
    'churn_alerts_open', (select count(*) from public.crm_alerts a where a.status = 'open' and (p_city is null or a.city_id = p_city) and public.is_ops(a.city_id)),
    'leads_follow_up_due', (select count(*) from public.leads l where l.next_action_at <= current_date and l.stage in ('new', 'contacted', 'trial')
                              and (p_city is null or l.city_id = p_city) and public.is_ops(l.city_id)))
  from public.tickets where (p_city is null or city_id = p_city) and public.is_ops(city_id));
end $$;

-- ---------- schedules ----------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ticket-sla', '*/5 * * * *', 'select public.ticket_sla_tick()');
    perform cron.schedule('campaigns', '* * * * *', 'select public.campaign_tick()');
    perform cron.schedule('crm-daily', '30 5 * * *', 'select public.crm_daily()');   -- 05:30 Accra (= UTC)
  end if;
end $$;

-- ---------- who may call what ----------
revoke execute on function public._work_add(timestamptz, int), public._notify_support(public.tickets, text, jsonb),
  public._new_ticket(jsonb, text, text, uuid, text, text), public._whatsapp_inbox(text, text, text, jsonb),
  public.crm_daily(), public.ticket_sla_tick(), public.link_lead_on_signup(), public.charge_cs_fee(), public._cs_order(uuid)
  from public, anon, authenticated;
grant execute on function public.crm_daily(), public.ticket_sla_tick(), public.campaign_tick() to service_role;
revoke execute on function public.open_ticket(text, text, text, text, text), public.staff_open_ticket(jsonb),
  public.reply_ticket(uuid, text, boolean, text, boolean), public.update_ticket(uuid, jsonb),
  public.add_crm_note(text, uuid, text), public.set_crm_profile(text, uuid, text[], uuid), public.customer_360(uuid),
  public.save_lead(uuid, jsonb), public.move_lead(uuid, public.crm_stage, text), public.handle_crm_alert(uuid, text),
  public.segment_preview(text, jsonb, uuid), public.save_segment(uuid, text, text, jsonb, uuid), public.save_campaign(uuid, jsonb),
  public.schedule_campaign(uuid, timestamptz), public.cancel_campaign(uuid), public.log_contact(uuid, text, text, text),
  public.cs_message(uuid, text), public.support_overview(uuid) from public, anon;
grant execute on function public.open_ticket(text, text, text, text, text), public.staff_open_ticket(jsonb),
  public.reply_ticket(uuid, text, boolean, text, boolean), public.update_ticket(uuid, jsonb),
  public.add_crm_note(text, uuid, text), public.set_crm_profile(text, uuid, text[], uuid), public.customer_360(uuid),
  public.save_lead(uuid, jsonb), public.move_lead(uuid, public.crm_stage, text), public.handle_crm_alert(uuid, text),
  public.segment_preview(text, jsonb, uuid), public.save_segment(uuid, text, text, jsonb, uuid), public.save_campaign(uuid, jsonb),
  public.schedule_campaign(uuid, timestamptz), public.cancel_campaign(uuid), public.log_contact(uuid, text, text, text),
  public.cs_message(uuid, text), public.support_overview(uuid) to authenticated;
