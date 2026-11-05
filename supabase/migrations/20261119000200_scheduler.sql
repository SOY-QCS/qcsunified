-- Phase 14 · Scheduled jobs set themselves up on Supabase.
-- The 15 jobs that work inside the database were already registered by earlier migrations (when pg_cron exists).
-- This adds the 3 that call an Edge Function or the portal, so nobody has to paste SQL by hand.
-- They read their addresses and secrets from Supabase Vault each time they run (project_url, notify_secret, portal_url,
-- cron_secret: docs/go-live.md step 4). Until those exist the jobs simply fail, and System health shows it.
-- On a plain Postgres without pg_cron / pg_net (local tests) nothing happens.

do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.schedule('send-notifications', '10 seconds', $job$
      select net.http_post((select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-notifications',
        headers := jsonb_build_object('x-qcs-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret')))
      where exists (select 1 from public.notifications where status = 'queued' and next_attempt_at <= now()) $job$);

    perform cron.schedule('send-webhooks', '10 seconds', $job$
      select net.http_post((select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-webhooks',
        headers := jsonb_build_object('x-qcs-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret')))
      where exists (select 1 from public.webhook_deliveries where status = 'queued' and next_attempt_at <= now()) $job$);

    perform cron.schedule('payments-reconcile', '*/5 * * * *', $job$
      select net.http_get((select decrypted_secret from vault.decrypted_secrets where name = 'portal_url') || '/api/v1/payments/reconcile',
        headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'))) $job$);
  end if;
end $outer$;
