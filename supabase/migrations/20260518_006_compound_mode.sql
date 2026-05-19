-- Compound mode: position sizing grows with balance over time
alter table public.settings
  add column if not exists compound_mode boolean not null default false,
  add column if not exists paper_balance_usd numeric(12,2) not null default 20.00,
  add column if not exists paper_starting_balance_usd numeric(12,2) not null default 20.00;

comment on column public.settings.compound_mode is 'When true, position size is derived from current balance × tier %, not the fixed buy_amount_usd.';
comment on column public.settings.paper_balance_usd is 'Running paper-mode balance — updated after every simulated close.';
comment on column public.settings.paper_starting_balance_usd is 'Seed capital for paper compound mode — used to compute growth %.';
