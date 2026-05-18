-- Entry risk gate columns: daily loss limit, max drawdown, max spread, max volatility
-- Applied: 2026-05-18 (already in production)

alter table public.settings
  add column if not exists daily_loss_limit_usd numeric(10,2) not null default 25.00,
  add column if not exists max_drawdown_pct      numeric(5,2)  not null default 10.00,
  add column if not exists max_spread_pct        numeric(6,3)  not null default 0.250,
  add column if not exists max_volatility_pct    numeric(6,3)  not null default 3.000;

-- Add check constraints (safe for repeated runs)
do $$ begin
  alter table public.settings
    add constraint settings_daily_loss_limit_usd_pos check (daily_loss_limit_usd > 0);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.settings
    add constraint settings_max_drawdown_pct_range check (max_drawdown_pct > 0 and max_drawdown_pct <= 100);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.settings
    add constraint settings_max_spread_pct_pos check (max_spread_pct > 0);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.settings
    add constraint settings_max_volatility_pct_pos check (max_volatility_pct > 0);
exception when duplicate_object then null;
end $$;
