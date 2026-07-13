-- OctoMind — Phase 1 schema (Supabase Postgres)
-- Run this in Supabase → SQL Editor. Idempotent (safe to re-run).
--
-- Access model: the backend talks to these tables via PostgREST using the
-- service key and enforces per-user isolation itself (via device-id → users.id).
-- RLS is intentionally left OFF for MVP; revisit when real auth lands.
--
-- Existing `push_subscriptions` table is untouched.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ── users ─────────────────────────────────────────────────────────────────────
-- Anonymous-first identity. `device_id` is generated client-side (localStorage)
-- and sent as the `x-device-id` header. `email` stays null until real auth.
create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  device_id   text unique not null,
  email       text,
  created_at  timestamptz not null default now()
);

create index if not exists users_device_id_idx on public.users (device_id);

-- ── business_profile ──────────────────────────────────────────────────────────
-- Niche-agnostic: `niche` is free text the client fills in; the AI brain adapts.
-- `extra` holds any niche-specific fields without a schema migration.
create table if not exists public.business_profile (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  business_name    text,
  niche            text,
  description      text,
  target_audience  text,
  geo              text,
  price_segment    text,
  usp              text,          -- уникальное торговое предложение
  goal             text,          -- awareness | leads | sales | ...
  tone             text,
  extra            jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists business_profile_user_id_idx on public.business_profile (user_id);

-- ── projects ──────────────────────────────────────────────────────────────────
-- A named campaign/effort tied to one business profile.
create table if not exists public.projects (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users (id) on delete cascade,
  business_profile_id  uuid references public.business_profile (id) on delete set null,
  name                 text,
  goal                 text,
  status               text not null default 'active',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists projects_user_id_idx on public.projects (user_id, created_at desc);

-- ── generations ───────────────────────────────────────────────────────────────
-- Every AI output (analysis / offer / strategy / text / image / ...) is logged
-- here. `input`/`output` are JSONB so the shape can evolve per generation type.
create table if not exists public.generations (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users (id) on delete cascade,
  project_id           uuid references public.projects (id) on delete set null,
  business_profile_id  uuid references public.business_profile (id) on delete set null,
  type                 text not null,   -- analysis | offer | strategy | text | ...
  input                jsonb not null default '{}'::jsonb,
  output               jsonb not null default '{}'::jsonb,
  model                text,
  created_at           timestamptz not null default now()
);

create index if not exists generations_user_id_idx on public.generations (user_id, created_at desc);
create index if not exists generations_type_idx    on public.generations (type);

-- ── updated_at auto-touch ─────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists business_profile_touch on public.business_profile;
create trigger business_profile_touch
  before update on public.business_profile
  for each row execute function public.touch_updated_at();

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch
  before update on public.projects
  for each row execute function public.touch_updated_at();

-- ── plan + usage metering (server-side tariff limits) ─────────────────────────
-- `plan` is the source of truth for entitlements. Defaults to 'free'; the
-- payment flow (later) flips it to 'pro' / 'business'. Enforcement counts rows
-- in `usage_events` for the current period (day/month) per feature.
alter table public.users add column if not exists plan text not null default 'free';

create table if not exists public.usage_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  feature     text not null,   -- campaign | image | chat | trend_feed | analysis | research | brand
  created_at  timestamptz not null default now()
);

-- The hot query is "count events for a user+feature since <period start>".
create index if not exists usage_events_lookup_idx
  on public.usage_events (user_id, feature, created_at desc);

-- ── admin dashboard stats ─────────────────────────────────────────────────────
-- One function returns everything the in-app admin screen needs, in one call.
-- SECURITY DEFINER so it can read auth.users (real signups) even though the
-- caller is the service role; execution is revoked from anon/authenticated so
-- ONLY the backend (service key) can call it via /rest/v1/rpc/admin_stats.
create or replace function public.admin_stats()
returns json
language sql
security definer
set search_path = public, auth
as $$
  select json_build_object(
    'generated_at', now(),
    'registrations', json_build_object(
      'total',     (select count(*) from auth.users),
      'confirmed', (select count(*) from auth.users where email_confirmed_at is not null),
      'today',     (select count(*) from auth.users where created_at::date = now()::date),
      'last_7d',   (select count(*) from auth.users where created_at > now() - interval '7 days')
    ),
    'activity', json_build_object(
      'total_actions', (select count(*) from public.usage_events),
      'active_users',  (select count(distinct user_id) from public.usage_events),
      'last_7d',       (select count(*) from public.usage_events where created_at > now() - interval '7 days'),
      'by_feature',    (select coalesce(json_object_agg(feature, c), '{}'::json)
                         from (select feature, count(*) c from public.usage_events group by feature) t)
    ),
    'generations_by_type', (select coalesce(json_object_agg(type, c), '{}'::json)
                             from (select type, count(*) c from public.generations group by type) t),
    'devices', (select count(*) from public.users),
    'signups_by_day', (select coalesce(json_agg(json_build_object('day', d, 'count', c) order by d desc), '[]'::json)
                        from (select created_at::date d, count(*) c
                              from auth.users
                              where created_at > now() - interval '14 days'
                              group by 1) t)
  );
$$;

revoke all on function public.admin_stats() from anon, authenticated;

-- ── Product analytics ─────────────────────────────────────────────────────────
-- Every client event lands here through POST /api/track (whitelisted names,
-- fire-and-forget). RLS is enabled with NO policies: only the backend's
-- service key can read or write — the browser never touches this table.
create table if not exists public.events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event      text not null,
  user_id    uuid references public.users(id) on delete set null,
  device_id  text,
  props      jsonb
);
create index if not exists events_event_time_idx on public.events (event, created_at desc);
create index if not exists events_user_time_idx  on public.events (user_id, created_at desc);
alter table public.events enable row level security;
