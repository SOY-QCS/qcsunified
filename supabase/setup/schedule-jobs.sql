-- =====================================================================
-- QCS scheduled jobs. The migrations already register all 18 on Supabase (the Deploy button, docs/go-live.md step 2).
-- Keep this file for REPAIRS: paste it in the SQL editor to re-register every job (re-running is safe: a job with the
-- same name is simply updated).
--
-- Before running it:
--   1. Database → Extensions: turn on pg_cron and pg_net.
--   2. Project settings → Vault: add these secrets (exact names):
--        project_url  = https://<project-ref>.supabase.co
--        notify_secret = the same value as the Edge Function secret NOTIFY_SECRET
--        portal_url   = https://portal.qcsghana.com          (the business portal address)
--        cron_secret  = the same value as CRON_SECRET in the portal's Vercel settings
--      Optional, only with Google road-time ranking: dispatch_rank_secret = DISPATCH_RANK_SECRET
-- Check afterwards with:  pnpm check:deploy   (or: select public.deployment_check(); as the service role)
-- =====================================================================

-- ----- work done inside the database -----
select cron.schedule('dispatch-tick',           '5 seconds',     'select public.dispatch_tick()');                  -- offer Express jobs to riders
select cron.schedule('expire-unpaid-orders',    '*/10 * * * *',  'select public.expire_unpaid_orders()');           -- cancel card/MoMo orders unpaid after 60 min
select cron.schedule('ticket-sla',              '*/5 * * * *',   'select public.ticket_sla_tick()');                -- support time limits
select cron.schedule('campaigns',               '* * * * *',     'select public.campaign_tick()');                  -- scheduled broadcasts
select cron.schedule('health-check',            '*/10 * * * *',  'select public.health_check()');                   -- email Super Admins about red checks
select cron.schedule('fraud-scan',              '23 * * * *',    'select public.fraud_scan()');                     -- hourly
select cron.schedule('purge-rate-limits',       '7 * * * *',     'select public.purge_rate_limits()');
-- daily (times are UTC = Accra time)
select cron.schedule('block-overdue-cod',       '5 0 * * *',     'select public.block_overdue_cod_riders()');       -- riders who didn't hand in COD
select cron.schedule('purge-idle-pings',        '15 2 * * *',    'select public.purge_idle_location_pings()');      -- idle positions after 7 days
select cron.schedule('purge-old-notifications', '40 2 * * *',    'select public.purge_old_notifications()');
select cron.schedule('purge-api-data',          '50 2 * * *',    'select public.purge_api_data()');
select cron.schedule('crm-daily',               '30 5 * * *',    'select public.crm_daily()');                      -- churn alerts, invoice reminders
select cron.schedule('prepare-payouts',         '0 6 * * *',     'select public.prepare_scheduled_payouts()');      -- payout batches for Finance to approve
select cron.schedule('analytics-reports',       '15 6 * * *',    'select public.send_scheduled_reports()');
select cron.schedule('bill-storage',            '0 5 1 * *',     'select public.bill_storage()');                   -- fulfilment storage, 1st of the month

-- ----- work done by Edge Functions / the portal (called only when there is something to do) -----
select cron.schedule('send-notifications', '10 seconds', $$
  select net.http_post((select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-notifications',
    headers := jsonb_build_object('x-qcs-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret')))
  where exists (select 1 from public.notifications where status = 'queued' and next_attempt_at <= now()) $$);

select cron.schedule('send-webhooks', '10 seconds', $$
  select net.http_post((select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-webhooks',
    headers := jsonb_build_object('x-qcs-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret')))
  where exists (select 1 from public.webhook_deliveries where status = 'queued' and next_attempt_at <= now()) $$);

-- payments whose Hubtel callback never arrived (runs on the portal; replaces the old Vercel cron, which needs a paid Vercel plan)
select cron.schedule('payments-reconcile', '*/5 * * * *', $$
  select net.http_get((select decrypted_secret from vault.decrypted_secrets where name = 'portal_url') || '/api/v1/payments/reconcile',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'))) $$);

-- ----- optional: Google road-time ranking for Express dispatch (costs about one Google Routes call per job) -----
-- select cron.schedule('dispatch-rank', '5 seconds', $$
--   select net.http_post((select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/dispatch-rank',
--     headers := jsonb_build_object('x-qcs-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_rank_secret')))
--   where exists (select 1 from public.trips_to_rank()) $$);
-- update public.app_settings set value = 'true' where key = 'dispatch_google_ranking' and city_id is null;

select jobname, schedule from cron.job order by jobname;
