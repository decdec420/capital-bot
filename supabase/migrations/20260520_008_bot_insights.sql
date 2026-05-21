-- Migration 008: bot_insights — nightly analysis output
-- Stores computed recommendations from the nightly analyser.
-- The Performance page reads this to show AI-grade insights.

create table if not exists public.bot_insights (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid references auth.users(id) on delete cascade not null,
  computed_at               timestamptz not null default now(),

  -- Sample size
  total_trades              integer not null default 0,
  trades_analysed           integer not null default 0,   -- closed trades with full data

  -- RSI entry analysis
  best_rsi_bucket_label     text,            -- e.g. "25–30"
  best_rsi_bucket_win_rate  numeric(5,4),    -- 0–1
  best_rsi_bucket_net_pnl   numeric(12,4),
  current_rsi_threshold     numeric(5,2),
  suggested_rsi_threshold   numeric(5,2),    -- null = no change recommended

  -- Hold time analysis
  avg_win_hold_hours        numeric(8,2),    -- average hold time of winning trades
  avg_loss_hold_hours       numeric(8,2),    -- average hold time of losing trades
  suggested_trailing_pct    numeric(5,2),    -- null = no change recommended

  -- Exit reason breakdown (JSON: { reason: { count, win_rate, net_pnl } })
  exit_reasons              jsonb,

  -- Scale-in effectiveness
  scale_in_trades           integer not null default 0,
  scale_in_win_rate         numeric(5,4),
  scale_in_net_pnl          numeric(12,4),
  non_scaled_win_rate       numeric(5,4),
  scale_in_delta_win_rate   numeric(6,4),    -- positive = scale-in helping

  -- 7-day snapshot
  last7d_trades             integer not null default 0,
  last7d_wins               integer not null default 0,
  last7d_win_rate           numeric(5,4),
  last7d_net_pnl            numeric(12,4),

  -- All-time snapshot
  alltime_win_rate          numeric(5,4),
  alltime_net_pnl           numeric(12,4),
  max_drawdown_pct          numeric(8,4),
  profit_factor             numeric(8,4),

  -- Plain-English recommendations (array of strings)
  recommendations           jsonb not null default '[]'::jsonb,

  -- Whether any params were auto-applied
  auto_applied              boolean not null default false,
  auto_applied_fields       jsonb    not null default '{}'::jsonb
);

-- Only keep the last 90 days of insight rows (history for the Performance page)
create index if not exists bot_insights_user_time on public.bot_insights(user_id, computed_at desc);

alter table public.bot_insights enable row level security;
create policy "users own their insights"
  on public.bot_insights for all using (auth.uid() = user_id);

-- param_history — records every settings change with before/after values
-- This lets the Performance page show "did this tuning actually help?"
create table if not exists public.param_history (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  changed_at   timestamptz not null default now(),
  field        text not null,           -- e.g. "rsi_buy_threshold"
  old_value    text,
  new_value    text,
  source       text not null default 'manual',  -- 'manual' | 'auto_analyser'
  note         text
);

create index if not exists param_history_user on public.param_history(user_id, changed_at desc);

alter table public.param_history enable row level security;
create policy "users own their param history"
  on public.param_history for all using (auth.uid() = user_id);
