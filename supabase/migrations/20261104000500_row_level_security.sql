-- =====================================================================
-- QCS Unified — 005: Row Level Security (who can see and change what)
-- Rule of thumb:
--   • Clients see their own (or their vendor's) data.
--   • Riders see their own jobs, wallet and documents.
--   • Ops staff see their city; Super Admin / Finance / Analyst see all cities.
--   • Analysts can read but never write.
--   • Prices, payments, ledger and status changes go through server code or
--     the database functions in migration 003 — never direct table edits.
-- The server (service-role key) bypasses RLS by design; keep that key out of apps.
-- =====================================================================

-- Turn RLS on for every table in the public schema.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ---------- places (public: the website needs hubs and zones) ----------
create policy cities_read on public.cities for select to anon, authenticated using (is_active or public.is_ops());
create policy cities_write on public.cities for all to authenticated
  using (public.has_role(array['super_admin']::public.app_role[])) with check (public.has_role(array['super_admin']::public.app_role[]));

create policy zones_read on public.zones for select to anon, authenticated using (is_active or public.is_ops(city_id));
create policy zones_write on public.zones for all to authenticated using (public.is_admin(city_id)) with check (public.is_admin(city_id));

create policy hubs_read on public.hubs for select to anon, authenticated using (is_active or public.is_ops(city_id));
create policy hubs_write on public.hubs for all to authenticated using (public.is_admin(city_id)) with check (public.is_admin(city_id));

-- ---------- roles ----------
create policy roles_read on public.roles for select to authenticated using (true);

create policy user_roles_read on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin(city_id) or public.has_role(array['super_admin','analyst']::public.app_role[]));
-- Super Admin manages all roles. A City Admin can grant field roles in their own city only.
create policy user_roles_write_super on public.user_roles for all to authenticated
  using (public.has_role(array['super_admin']::public.app_role[]))
  with check (public.has_role(array['super_admin']::public.app_role[]));
create policy user_roles_write_city on public.user_roles for all to authenticated
  using (city_id is not null and public.has_role(array['city_admin']::public.app_role[], city_id)
         and role in ('dispatcher','hub_manager','hub_handler','support','fleet_rider','commission_rider'))
  with check (city_id is not null and public.has_role(array['city_admin']::public.app_role[], city_id)
         and role in ('dispatcher','hub_manager','hub_handler','support','fleet_rider','commission_rider'));

-- ---------- profiles ----------
create policy profiles_read on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or public.is_ops(city_id)
  -- a client can see the rider assigned to their order
  or exists (select 1 from public.orders o where o.rider_id = profiles.id and o.status not in ('DELIVERED','COLLECTED','CANCELLED','RETURNED'))
  -- a vendor owner can see their staff
  or exists (select 1 from public.vendor_staff s where s.user_id = profiles.id and s.vendor_id in (select public.my_vendor_ids('staff')))
);
create policy profiles_insert_self on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_self on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_update_ops on public.profiles for update to authenticated using (public.is_ops_writer(city_id)) with check (public.is_ops_writer(city_id));

-- ---------- vendors ----------
create policy vendors_read on public.vendors for select to authenticated
  using (id in (select public.my_vendor_ids()) or public.is_ops(city_id));
create policy vendors_signup on public.vendors for insert to authenticated with check (owner_id = (select auth.uid()));
create policy vendors_insert_ops on public.vendors for insert to authenticated with check (public.is_ops_writer(city_id));
create policy vendors_update on public.vendors for update to authenticated
  using (owner_id = (select auth.uid()) or public.is_ops_writer(city_id))
  with check (owner_id = (select auth.uid()) or public.is_ops_writer(city_id));
create policy vendors_delete on public.vendors for delete to authenticated using (public.has_role(array['super_admin']::public.app_role[]));

create policy vendor_staff_read on public.vendor_staff for select to authenticated
  using (user_id = (select auth.uid()) or vendor_id in (select public.my_vendor_ids('staff')) or public.is_ops());
create policy vendor_staff_manage on public.vendor_staff for all to authenticated
  using (vendor_id in (select public.my_vendor_ids('staff')) or public.is_ops_writer())
  with check (vendor_id in (select public.my_vendor_ids('staff')) or public.is_ops_writer());

-- ---------- riders ----------
create policy riders_read on public.riders for select to authenticated using (
  id = (select auth.uid())
  or public.is_ops(city_id)
  or exists (select 1 from public.orders o where o.rider_id = riders.id and o.status not in ('DELIVERED','COLLECTED','CANCELLED','RETURNED'))
);
create policy riders_apply on public.riders for insert to authenticated with check (id = (select auth.uid()));
create policy riders_insert_ops on public.riders for insert to authenticated with check (public.is_ops_writer(city_id));
create policy riders_update on public.riders for update to authenticated
  using (id = (select auth.uid()) or public.is_ops_writer(city_id))
  with check (id = (select auth.uid()) or public.is_ops_writer(city_id));
create policy riders_delete on public.riders for delete to authenticated using (public.has_role(array['super_admin']::public.app_role[]));

create policy vehicles_read on public.vehicles for select to authenticated
  using (public.is_ops() or exists (select 1 from public.riders r where r.vehicle_id = vehicles.id and r.id = (select auth.uid())));
create policy vehicles_write on public.vehicles for all to authenticated using (public.is_ops_writer()) with check (public.is_ops_writer());

create policy rider_docs_read on public.rider_documents for select to authenticated using (
  rider_id = (select auth.uid())
  or exists (select 1 from public.riders r where r.id = rider_documents.rider_id and public.is_ops(r.city_id))
);
create policy rider_docs_upload on public.rider_documents for insert to authenticated
  with check (rider_id = (select auth.uid()) and status = 'pending' and reviewed_by is null);
create policy rider_docs_review on public.rider_documents for update to authenticated using (
  exists (select 1 from public.riders r where r.id = rider_documents.rider_id and public.is_ops_writer(r.city_id))
);

create policy pings_insert_own on public.rider_location_pings for insert to authenticated with check (rider_id = (select auth.uid()));
create policy pings_read on public.rider_location_pings for select to authenticated using (
  rider_id = (select auth.uid())
  or exists (select 1 from public.riders r where r.id = rider_location_pings.rider_id and public.is_ops(r.city_id))
);

-- ---------- addresses ----------
create policy addresses_read on public.addresses for select to authenticated
  using (user_id = (select auth.uid()) or vendor_id in (select public.my_vendor_ids()) or public.is_ops(city_id));
create policy addresses_write on public.addresses for all to authenticated
  using (user_id = (select auth.uid()) or vendor_id in (select public.my_vendor_ids('book')) or public.is_ops_writer(city_id))
  with check (user_id = (select auth.uid()) or vendor_id in (select public.my_vendor_ids('book')) or public.is_ops_writer(city_id));

-- ---------- orders, trips, stops, events ----------
-- Clients create orders through the booking Edge Function (it calculates the price with packages/pricing),
-- so there is no client insert/update policy here. Status changes use transition_order().
create policy orders_read on public.orders for select to authenticated using (
  customer_id = (select auth.uid())
  or vendor_id in (select public.my_vendor_ids())
  or rider_id = (select auth.uid())
  or public.is_ops(city_id)
  or origin_hub_id in (select public.my_hub_ids())
  or dest_hub_id in (select public.my_hub_ids())
);
create policy orders_insert_ops on public.orders for insert to authenticated with check (public.is_ops_writer(city_id));
create policy orders_update_ops on public.orders for update to authenticated using (public.is_ops_writer(city_id)) with check (public.is_ops_writer(city_id));

create policy trips_read on public.trips for select to authenticated
  using (rider_id = (select auth.uid()) or vendor_id in (select public.my_vendor_ids()) or public.is_ops(city_id) or hub_id in (select public.my_hub_ids()));
create policy trips_write on public.trips for all to authenticated using (public.is_ops_writer(city_id)) with check (public.is_ops_writer(city_id));

create policy stops_read on public.order_stops for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_stops.order_id));
-- Riders can re-order and tick off stops on their own trip.
create policy stops_rider_update on public.order_stops for update to authenticated
  using (exists (select 1 from public.trips t where t.id = order_stops.trip_id and t.rider_id = (select auth.uid())))
  with check (exists (select 1 from public.trips t where t.id = order_stops.trip_id and t.rider_id = (select auth.uid())));
create policy stops_ops on public.order_stops for all to authenticated
  using (exists (select 1 from public.trips t where t.id = order_stops.trip_id and public.is_ops_writer(t.city_id)))
  with check (exists (select 1 from public.trips t where t.id = order_stops.trip_id and public.is_ops_writer(t.city_id)));

create policy events_read on public.order_events for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_events.order_id));

create policy transitions_read on public.order_status_transitions for select to anon, authenticated using (true);
create policy transitions_write on public.order_status_transitions for all to authenticated
  using (public.has_role(array['super_admin']::public.app_role[])) with check (public.has_role(array['super_admin']::public.app_role[]));

-- ---------- pricing & settings ----------
create policy pricing_read on public.pricing_rules for select to anon, authenticated using (is_active or public.is_ops(city_id));
create policy pricing_write on public.pricing_rules for all to authenticated
  using (public.is_admin(city_id) or public.is_finance()) with check (public.is_admin(city_id) or public.is_finance());

create policy settings_read on public.app_settings for select to authenticated using (true);
create policy settings_write on public.app_settings for all to authenticated
  using (public.has_role(array['super_admin']::public.app_role[])) with check (public.has_role(array['super_admin']::public.app_role[]));

-- ---------- money (read-only to everyone; writes go through post_ledger_transaction) ----------
create policy wallets_read on public.wallets for select to authenticated using (
  (owner_type in ('customer','rider') and owner_id = (select auth.uid()))
  or (owner_type = 'vendor' and owner_id in (select public.my_vendor_ids('wallet')))
  or public.is_finance()
  or public.has_role(array['analyst']::public.app_role[])
);

create policy ledger_entries_read on public.ledger_entries for select to authenticated
  using (exists (select 1 from public.wallets w where w.id = ledger_entries.wallet_id));
create policy ledger_tx_read on public.ledger_transactions for select to authenticated
  using (exists (select 1 from public.ledger_entries e where e.transaction_id = ledger_transactions.id));

create policy payouts_read on public.payouts for select to authenticated
  using (exists (select 1 from public.wallets w where w.id = payouts.wallet_id));
create policy payouts_finance on public.payouts for all to authenticated using (public.is_finance()) with check (public.is_finance());

create policy cod_read on public.cod_collections for select to authenticated
  using (rider_id = (select auth.uid()) or vendor_id in (select public.my_vendor_ids('wallet')) or public.is_ops(city_id));
create policy cod_write on public.cod_collections for all to authenticated
  using (public.has_role(array['super_admin','city_admin','finance','hub_manager','dispatcher']::public.app_role[], city_id))
  with check (public.has_role(array['super_admin','city_admin','finance','hub_manager','dispatcher']::public.app_role[], city_id));

-- Promo codes are checked by the booking function, so clients never list them.
create policy promos_read on public.promo_codes for select to authenticated using (public.is_ops(city_id));
create policy promos_write on public.promo_codes for all to authenticated
  using (public.is_finance() or public.is_admin(city_id)) with check (public.is_finance() or public.is_admin(city_id));

-- ---------- support ----------
create policy tickets_read on public.tickets for select to authenticated using (
  customer_id = (select auth.uid()) or opened_by = (select auth.uid())
  or vendor_id in (select public.my_vendor_ids()) or public.is_ops(city_id)
);
create policy tickets_open on public.tickets for insert to authenticated with check (
  opened_by = (select auth.uid())
  and (customer_id = (select auth.uid()) or vendor_id in (select public.my_vendor_ids()) or public.is_ops_writer(city_id))
);
create policy tickets_update_ops on public.tickets for update to authenticated using (public.is_ops_writer(city_id)) with check (public.is_ops_writer(city_id));

create policy ticket_msgs_read on public.ticket_messages for select to authenticated using (
  exists (select 1 from public.tickets t where t.id = ticket_messages.ticket_id)
  and (not is_internal or public.is_ops())
);
create policy ticket_msgs_write on public.ticket_messages for insert to authenticated with check (
  author_id = (select auth.uid())
  and exists (select 1 from public.tickets t where t.id = ticket_messages.ticket_id)
  and (not is_internal or public.is_ops_writer())
);

-- ---------- audit, notifications, integrations ----------
create policy audit_read on public.audit_log for select to authenticated
  using (public.has_role(array['super_admin','finance','analyst']::public.app_role[]));

create policy notifications_read on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) or public.is_ops());
create policy notifications_mark_read on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy webhooks_vendor on public.webhooks for all to authenticated
  using (vendor_id in (select public.my_vendor_ids('api'))) with check (vendor_id in (select public.my_vendor_ids('api')));
create policy webhooks_ops_read on public.webhooks for select to authenticated using (public.has_role(array['super_admin']::public.app_role[]));

-- API keys are created by a server function (the key is shown once, only its hash is stored).
create policy api_keys_vendor_read on public.api_keys for select to authenticated using (vendor_id in (select public.my_vendor_ids('api')));
create policy api_keys_vendor_revoke on public.api_keys for update to authenticated
  using (vendor_id in (select public.my_vendor_ids('api'))) with check (vendor_id in (select public.my_vendor_ids('api')));
create policy api_keys_ops_read on public.api_keys for select to authenticated using (public.has_role(array['super_admin']::public.app_role[]));

-- Functions that change things are callable by signed-in users only (they check roles inside).
revoke execute on function public.transition_order(uuid, public.order_status, double precision, double precision, text, text, text) from public, anon;
grant  execute on function public.transition_order(uuid, public.order_status, double precision, double precision, text, text, text) to authenticated, service_role;
revoke execute on function public.post_ledger_transaction(text, text, jsonb, uuid, text) from public, anon;
grant  execute on function public.post_ledger_transaction(text, text, jsonb, uuid, text) to authenticated, service_role;
revoke execute on function public.purge_idle_location_pings() from public, anon, authenticated;
revoke execute on function public.block_overdue_cod_riders() from public, anon, authenticated;
