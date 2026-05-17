-- Run this in Supabase SQL editor AFTER:
--   1. Deploying the edge functions
--   2. Setting SIGNAL_TICK_CRON_TOKEN and POSITION_SYNC_CRON_TOKEN in
--      Supabase dashboard → Edge Functions → Manage secrets
--
-- Replace the two <TOKEN> placeholders with your actual secret values.

select cron.schedule(
  'signal-tick-every-5min',
  '*/5 * * * *',
  $$
    select net.http_post(
      url     := 'https://gyeajiofuqsjzsjheiqe.supabase.co/functions/v1/signal-tick',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer 167650a551726eebb3c49e2c47562654a995f24a2bcf4edbf10cf5c6e429694e'
      ),
      body    := '{}'::jsonb
    );
  $$
);

select cron.schedule(
  'position-sync-hourly',
  '0 * * * *',
  $$
    select net.http_post(
      url     := 'https://gyeajiofuqsjzsjheiqe.supabase.co/functions/v1/position-sync',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer 14e592a4777110211918506f03e8f1c5d2ff7860dadb708da3897fd686fecbe2'
      ),
      body    := '{}'::jsonb
    );
  $$
);

select cron.schedule(
  'expire-tick-log-daily',
  '0 3 * * *',
  $$ select public.expire_old_ticks(); $$
);
