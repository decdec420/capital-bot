-- ============================================================
-- Auto-update updated_at on settings and broker_credentials
-- ============================================================
-- The columns exist but had no trigger — callers had to remember
-- to pass updated_at manually. This makes it automatic.

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_settings_updated_at on public.settings;
create trigger set_settings_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

drop trigger if exists set_broker_credentials_updated_at on public.broker_credentials;
create trigger set_broker_credentials_updated_at
  before update on public.broker_credentials
  for each row execute function public.set_updated_at();
