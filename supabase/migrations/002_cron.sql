-- Enable pg_cron and pg_net for daily WhatsApp digest and instant signup webhook
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Schedule daily digest at both 17:00 UTC and 18:00 UTC to handle Israel DST (UTC+2 / UTC+3).
-- The Edge Function checks current local hour in Asia/Jerusalem and only sends when hour == 20
-- (unless invoked with ?force=1 for manual testing).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lomda-daily-digest-17') then
    perform cron.unschedule('lomda-daily-digest-17');
  end if;
  if exists (select 1 from cron.job where jobname = 'lomda-daily-digest-18') then
    perform cron.unschedule('lomda-daily-digest-18');
  end if;
end $$;

select cron.schedule(
  'lomda-daily-digest-17',
  '0 17 * * *',
  $$
  select net.http_post(
    url := 'https://yebjvgyutmmyriwbrpmq.supabase.co/functions/v1/digest',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"mode": "cron"}'::jsonb
  );
  $$
);

select cron.schedule(
  'lomda-daily-digest-18',
  '0 18 * * *',
  $$
  select net.http_post(
    url := 'https://yebjvgyutmmyriwbrpmq.supabase.co/functions/v1/digest',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"mode": "cron"}'::jsonb
  );
  $$
);

-- Database webhook trigger on public.events where type = 'signup'
create or replace function public.notify_new_signup()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.type = 'signup' then
    perform net.http_post(
      url := 'https://yebjvgyutmmyriwbrpmq.supabase.co/functions/v1/digest',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'mode', 'signup',
        'record', jsonb_build_object(
          'username', new.username,
          'type', new.type,
          'created_at', new.created_at
        )
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_new_signup on public.events;
create trigger trg_notify_new_signup
after insert on public.events
for each row
when (new.type = 'signup')
execute function public.notify_new_signup();
