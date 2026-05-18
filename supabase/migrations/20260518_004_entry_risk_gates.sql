-- Migration: entry-time risk gate settings
-- These settings are evaluated immediately before buy execution by the
-- always-on worker and the signal-tick Edge Function.

alter table public.settings
  add column if not exists daily_loss_limit_usd numeric(10,2) not null default 25.00,
  add column if not exists max_drawdown_pct numeric(5,2) not null default 10.00,
  add column if not exists max_spread_pct numeric(6,3) not null default 0.250,
  add column if not exists max_volatility_pct numeric(6,3) not null default 3.000,
  add column if not exists entry_score_threshold numeric(6,3) not null default 1.000;

alter table public.settings
  add constraint settings_daily_loss_limit_usd_nonnegative check (daily_loss_limit_usd >= 0),
  add constraint settings_max_drawdown_pct_nonnegative check (max_drawdown_pct >= 0),
  add constraint settings_max_spread_pct_nonnegative check (max_spread_pct >= 0),
  add constraint settings_max_volatility_pct_nonnegative check (max_volatility_pct >= 0),
  add constraint settings_entry_score_threshold_nonnegative check (entry_score_threshold >= 0);

comment on column public.settings.daily_loss_limit_usd is 'Block new entries when today''s closed net P&L is less than or equal to this USD loss. 0 = disabled.';
comment on column public.settings.max_drawdown_pct is 'Block new entries when the closed-trade equity curve drawdown reaches this percentage. 0 = disabled.';
comment on column public.settings.max_spread_pct is 'Block new entries when the current bid/ask spread exceeds this percentage. 0 = disabled.';
comment on column public.settings.max_volatility_pct is 'Block new entries when the latest candle high/low range exceeds this percentage. 0 = disabled.';
comment on column public.settings.entry_score_threshold is 'Minimum RSI edge after estimated spread/slippage drag before entering. 0 = disabled.';
