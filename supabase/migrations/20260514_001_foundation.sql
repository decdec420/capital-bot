-- ============================================================
-- capital-bot foundation schema
-- ============================================================
-- Tables: settings, broker_credentials, trades, tick_log
-- Vault RPC: get_coinbase_broker_credentials (reused by broker.ts)
-- Cron: signal-tick every 5 min, position-sync every hour
-- ============================================================

-- Extensions
create extension if not exists "uuid-ossp";
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── settings ─────────────────────────────────────────────────
-- One row per user. Bot won't run unless enabled = true.
create table if not exists public.settings (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users(id) on delete cascade not null unique,
  symbol              text not null default 'BTC-USD',
  buy_amount_usd      numeric(10,2) not null default 10.00
                        check (buy_amount_usd >= 1.00),
  rsi_buy_threshold   numeric(5,2) not null default 30.0
                        check (rsi_buy_threshold between 1 and 49),
  rsi_sell_threshold  numeric(5,2) not null default 70.0
                        check (rsi_sell_threshold between 51 and 99),
  enabled             boolean not null default false,
  live_trading        boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.settings enable row level security;
create policy "users own their settings"
  on public.settings for all using (auth.uid() = user_id);

-- Auto-create settings row on first login
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.settings (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── broker_credentials ───────────────────────────────────────
-- Stores Coinbase CDP API key name (not secret).
-- The private key PEM lives in Supabase Vault as a named secret:
--   "coinbase_pem_{user_id}"
create table if not exists public.broker_credentials (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid references auth.users(id) on delete cascade not null unique,
  api_key_name            text not null,    -- e.g. "organizations/.../apiKeys/..."
  vault_secret_name       text not null,    -- name of the vault secret holding the PEM
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.broker_credentials enable row level security;
create policy "users own their credentials"
  on public.broker_credentials for all using (auth.uid() = user_id);

-- Vault RPC used by broker.ts getBrokerCredentials()
-- Returns the calling user's key_name + decrypted PEM from vault
create or replace function public.get_coinbase_broker_credentials()
returns table(api_key_name text, api_key_private_pem text)
language plpgsql security definer as $$
declare
  v_key_name    text;
  v_vault_name  text;
  v_pem         text;
begin
  select bc.api_key_name, bc.vault_secret_name
    into v_key_name, v_vault_name
    from public.broker_credentials bc
   where bc.user_id = auth.uid()
   limit 1;

  if v_key_name is null then
    raise exception 'No Coinbase credentials found. Add them in Settings.';
  end if;

  select decrypted_secret into v_pem
    from vault.decrypted_secrets
   where name = v_vault_name;

  if v_pem is null then
    raise exception 'Vault secret "%" not found. Re-save credentials in Settings.', v_vault_name;
  end if;

  return query select v_key_name, v_pem;
end;
$$;

-- Service-role variant used by signal-tick cron fanout
-- (called with admin client, user_id passed as argument)
create or replace function public.get_coinbase_credentials_for_user(p_user_id uuid)
returns table(api_key_name text, api_key_private_pem text)
language plpgsql security definer as $$
declare
  v_key_name    text;
  v_vault_name  text;
  v_pem         text;
begin
  select bc.api_key_name, bc.vault_secret_name
    into v_key_name, v_vault_name
    from public.broker_credentials bc
   where bc.user_id = p_user_id
   limit 1;

  if v_key_name is null then
    raise exception 'No Coinbase credentials for user %', p_user_id;
  end if;

  select decrypted_secret into v_pem
    from vault.decrypted_secrets
   where name = v_vault_name;

  if v_pem is null then
    raise exception 'Vault secret not found for user %', p_user_id;
  end if;

  return query select v_key_name, v_pem;
end;
$$;

-- Revoke direct access to vault RPCs from non-service roles
revoke execute on function public.get_coinbase_broker_credentials() from public, anon;
revoke execute on function public.get_coinbase_credentials_for_user(uuid) from public, anon;
grant  execute on function public.get_coinbase_broker_credentials() to authenticated;

-- ── trades ───────────────────────────────────────────────────
create table if not exists public.trades (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users(id) on delete cascade not null,
  symbol              text not null,
  entry_price         numeric(18,8) not null,
  size                numeric(18,8) not null,          -- base asset qty (BTC)
  quote_size          numeric(18,8) not null,          -- USD spent on entry
  entry_fees_usd      numeric(18,8) not null default 0,
  current_price       numeric(18,8),
  unrealized_pnl      numeric(18,8),
  unrealized_pnl_pct  numeric(10,4),
  exit_price          numeric(18,8),
  exit_fees_usd       numeric(18,8),
  pnl_usd             numeric(18,8),
  pnl_pct             numeric(10,4),
  effective_pnl       numeric(18,8),                  -- pnl net of all fees
  status              text not null default 'open'
                        check (status in ('open','closed')),
  coinbase_order_id   text,
  close_order_id      text,
  rsi_at_entry        numeric(6,2),
  price_updated_at    timestamptz,
  closed_at           timestamptz,
  notes               text,
  created_at          timestamptz not null default now()
);

alter table public.trades enable row level security;
create policy "users own their trades"
  on public.trades for all using (auth.uid() = user_id);

create index if not exists trades_user_status on public.trades(user_id, status);
create index if not exists trades_created on public.trades(created_at desc);

-- ── tick_log ─────────────────────────────────────────────────
-- Lightweight audit of every bot tick — what it decided and why
create table if not exists public.tick_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade not null,
  symbol     text not null,
  rsi        numeric(6,2),
  price      numeric(18,2),
  action     text not null,   -- 'buy' | 'sell' | 'hold' | 'error' | 'disabled'
  reason     text,
  created_at timestamptz not null default now()
);

alter table public.tick_log enable row level security;
create policy "users own their tick log"
  on public.tick_log for all using (auth.uid() = user_id);

create index if not exists tick_log_user on public.tick_log(user_id, created_at desc);

-- Auto-expire tick_log older than 30 days (keep it lean)
create or replace function public.expire_old_ticks()
returns void language sql security definer as $$
  delete from public.tick_log where created_at < now() - interval '30 days';
$$;

-- ── Cron jobs ─────────────────────────────────────────────────
-- NOTE: replace <PROJECT_REF> with your Supabase project ref
--       and <SIGNAL_TICK_CRON_TOKEN> / <POSITION_SYNC_CRON_TOKEN>
--       with the values you set in Supabase Edge Function secrets.
--
-- To enable, uncomment and run in Supabase SQL editor after deploying
-- the edge functions and setting your secrets.
--
-- select cron.schedule(
--   'signal-tick-every-5min',
--   '*/5 * * * *',
--   $$
--     select net.http_post(
--       url     := 'https://gyeajiofuqsjzsjheiqe.supabase.co/functions/v1/signal-tick',
--       headers := jsonb_build_object(
--         'Content-Type',  'application/json',
--         'Authorization', 'Bearer <SIGNAL_TICK_CRON_TOKEN>'
--       ),
--       body    := '{}'::jsonb
--     );
--   $$
-- );
--
-- select cron.schedule(
--   'position-sync-hourly',
--   '0 * * * *',
--   $$
--     select net.http_post(
--       url     := 'https://gyeajiofuqsjzsjheiqe.supabase.co/functions/v1/position-sync',
--       headers := jsonb_build_object(
--         'Content-Type',  'application/json',
--         'Authorization', 'Bearer <POSITION_SYNC_CRON_TOKEN>'
--       ),
--       body    := '{}'::jsonb
--     );
--   $$
-- );
--
-- select cron.schedule(
--   'expire-tick-log-daily',
--   '0 3 * * *',
--   $$ select public.expire_old_ticks(); $$
-- );

-- ── Vault helper — called by the Settings page ─────────────────
-- Allows authenticated users to upsert their own Coinbase PEM in vault.
-- The secret is namespaced by user_id so users can't overwrite each other.
create or replace function public.upsert_coinbase_pem(p_secret_name text, p_pem text)
returns void language plpgsql security definer as $$
declare
  v_expected_prefix text := 'coinbase_pem_' || auth.uid()::text;
begin
  -- Enforce that the secret name is scoped to the calling user
  if p_secret_name != v_expected_prefix then
    raise exception 'Secret name must be "coinbase_pem_<your_user_id>"';
  end if;
  if length(p_pem) < 100 then
    raise exception 'PEM appears too short — paste the full private key';
  end if;

  -- Insert or update the vault secret
  if exists (select 1 from vault.secrets where name = p_secret_name) then
    update vault.secrets set secret = p_pem, updated_at = now() where name = p_secret_name;
  else
    insert into vault.secrets (name, secret) values (p_secret_name, p_pem);
  end if;
end;
$$;

grant execute on function public.upsert_coinbase_pem(text, text) to authenticated;
