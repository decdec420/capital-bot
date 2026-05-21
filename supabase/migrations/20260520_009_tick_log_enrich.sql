-- Migration 009: tick_log enrichment + retention extension
-- Adds full decision state to every tick row so the audit trail is complete.
-- Extends retention from 30 days to 365 days — this data is too valuable to lose.

-- ── New columns ───────────────────────────────────────────────────────────────
alter table public.tick_log
  add column if not exists decision_state  text,           -- WATCHING | SETUP_FORMING | ENTRY_CANDIDATE | TRADE_ALLOWED | RISK_BLOCKED | IN_POSITION
  add column if not exists score           integer,        -- internal multi-factor score at decision time
  add column if not exists top_reasons     jsonb,          -- string[] of positive score factors
  add column if not exists top_blockers    jsonb,          -- string[] of blocking factors
  add column if not exists next_trigger    text,           -- plain-English "what needs to happen next"
  add column if not exists market_regime   text;           -- bullish | bearish | ranging

-- ── Extend retention to 365 days ────────────────────────────────────────────
create or replace function public.expire_old_ticks()
returns void language sql security definer as $$
  delete from public.tick_log where created_at < now() - interval '365 days';
$$;

-- ── Index for decision_state queries (e.g. "how often was RISK_BLOCKED?") ───
create index if not exists tick_log_decision_state on public.tick_log(user_id, decision_state, created_at desc);
