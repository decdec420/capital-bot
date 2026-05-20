-- Migration 007: Scale-in (averaging down) feature
-- Adds three settings columns and three trades columns.

-- Settings: toggle + RSI threshold + fixed dollar amount
alter table settings
  add column if not exists scale_in_enabled          boolean      not null default false,
  add column if not exists scale_in_rsi_threshold    integer      not null default 30,
  add column if not exists scale_in_amount_usd       numeric(12,2) not null default 10;

-- Trades: track whether/when/how much a scale-in happened
alter table trades
  add column if not exists scale_in_count            integer      not null default 0,
  add column if not exists scale_in_price            numeric(12,2),
  add column if not exists scale_in_quote_size       numeric(12,2);
