-- Migration: add entry_score_threshold to settings
-- User-facing label: Minimum setup quality.
-- Higher values require stricter setup scores before entries; lower values allow earlier/more frequent entries.

alter table public.settings
  add column if not exists entry_score_threshold numeric(5,2) not null default 65.0
    check (entry_score_threshold between 0 and 100);

comment on column public.settings.entry_score_threshold is
  'Minimum setup quality score required for entries. Higher = fewer, stricter entries; lower = more frequent, earlier entries.';
