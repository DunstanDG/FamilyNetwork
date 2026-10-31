-- Scheduled jobs. Run once in the Supabase SQL editor after the migrations and after deploying the
-- poll-feeds function. Safe to re-run (each job is replaced by name).
--
-- Needs the pg_cron and pg_net extensions: Database -> Extensions -> enable both.

-- 1. Keep the two values the feed job needs in Vault (encrypted, not in this file).
--    Replace the placeholders, run these two lines once, then remove your values from the editor.
select vault.create_secret('https://REPLACE-YOUR-PROJECT.supabase.co', 'family_project_url')
where not exists (select 1 from vault.secrets where name = 'family_project_url');
select vault.create_secret('REPLACE-WITH-THE-SAME-CRON_SECRET-AS-THE-FUNCTION', 'family_cron_secret')
where not exists (select 1 from vault.secrets where name = 'family_cron_secret');

-- 2. Poll followed podcasts and YouTube channels every 15 minutes. (Each source is only fetched
--    every 30 minutes, less often after failures; the job just asks what's due.)
select cron.schedule('family-poll-feeds', '*/15 * * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'family_project_url') || '/functions/v1/poll-feeds',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'family_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- 3. Close votes whose deadline has passed, every 10 minutes.
select cron.schedule('family-close-events', '*/10 * * * *', $$ select family.close_due_events(); $$);

-- 4. Day-before reminders (sent from 9am UK time), checked hourly.
select cron.schedule('family-event-reminders', '7 * * * *', $$ select family.send_event_reminders(); $$);

-- 5. Tidy: drop delivered notifications older than 6 months, weekly.
select cron.schedule('family-tidy-notifications', '23 3 * * 0', $$
  delete from family.notifications where created_at < now() - interval '6 months';
$$);

-- Check: select jobname, schedule, active from cron.job where jobname like 'family-%';
-- Recent runs: select * from cron.job_run_details order by start_time desc limit 20;
