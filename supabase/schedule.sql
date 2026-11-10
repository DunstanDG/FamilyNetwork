-- Scheduled jobs. Run once in the Supabase SQL editor after the migrations and after deploying the
-- poll-feeds function. Safe to re-run (each job is replaced by name).
--
-- Needs the pg_cron and pg_net extensions: Database -> Extensions -> enable both.

-- 1. Keep the two values the feed job needs in Vault (encrypted, not in this file).
--    Replace the two placeholders, run, then clear your values from the editor. Re-running with new
--    values updates them; running with the placeholders still in stops with an error.
do $$
declare
  project_url text := 'https://REPLACE-YOUR-PROJECT.supabase.co';
  cron_secret text := 'REPLACE-WITH-THE-SAME-CRON_SECRET-AS-THE-FUNCTION';
  existing uuid;
begin
  if project_url like '%REPLACE%' or cron_secret like '%REPLACE%' then
    raise exception 'Fill in project_url and cron_secret at the top of supabase/schedule.sql first.';
  end if;
  select id into existing from vault.secrets where name = 'family_project_url';
  if existing is null then perform vault.create_secret(project_url, 'family_project_url');
  else perform vault.update_secret(existing, project_url); end if;
  select id into existing from vault.secrets where name = 'family_cron_secret';
  if existing is null then perform vault.create_secret(cron_secret, 'family_cron_secret');
  else perform vault.update_secret(existing, cron_secret); end if;
end $$;

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
-- After 15 minutes, check the feed job really reached the function (a wrong secret shows as 403):
--   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
--   select status_code, content from net._http_response order by created desc limit 5;
