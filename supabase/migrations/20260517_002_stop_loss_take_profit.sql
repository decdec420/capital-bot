-- Migration: add stop_loss_pct and take_profit_pct to settings
-- stop_loss_pct:   close position if price drops this % below entry (0 = disabled)
-- take_profit_pct: close position if price rises this % above entry (0 = disabled)

alter table public.settings
  add column if not exists stop_loss_pct   numeric(5,2) not null default 5.0,
  add column if not exists take_profit_pct numeric(5,2) not null default 10.0;

comment on column public.settings.stop_loss_pct   is 'Close position if price drops this % below entry. 0 = disabled.';
comment on column public.settings.take_profit_pct is 'Close position if price rises this % above entry. 0 = disabled.';
