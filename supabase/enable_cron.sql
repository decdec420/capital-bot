-- Run this in Supabase SQL editor AFTER:
--   1. Deploying the edge functions
--   2. Setting SIGNAL_TICK_CRON_TOKEN and POSITION_SYNC_CRON_TOKEN in
--      Supabase dashboard → Edge Functions → Manage secrets
--
-- NOTE: signal-tick-every-5min is intentionally NOT included here.
-- The Fly.io WebSocket worker (worker/src/worker.ts) is the single source of
-- truth for trade execution and handles all 5-min candle closes in real time.
-- Running both caused duplicate ticks every 5 minutes.
--
-- To remove it from a live DB if it was previously scheduled:
--   select cron.unschedule('signal-tick-every-5min');

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
