create extension if not exists pgcrypto;

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  singleton_key text not null unique default 'owner',
  business_name text not null default 'WEBASI',
  bank_details text not null default '',
  notification_email text,
  whatsapp_monthly_cap integer not null default 900,
  gemini_daily_cap integer not null default 500,
  webasi_enabled boolean not null default false,
  shadow_mode boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  project_key text not null unique,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'training', 'ready', 'approved', 'active', 'inactive', 'archived')),
  readiness integer not null default 0 check (readiness between 0 and 100),
  version integer not null default 1,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists projects_one_active_idx on public.projects (status) where status = 'active';

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  wa_id text not null unique,
  profile_name text,
  state text not null default 'new',
  is_paused boolean not null default false,
  missing_fields jsonb not null default '[]'::jsonb,
  extracted_fields jsonb not null default '{}'::jsonb,
  recent_messages jsonb not null default '[]'::jsonb,
  intent_score text check (intent_score in ('high', 'medium', 'low')),
  handed_over boolean not null default false,
  last_client_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,
  client_id text,
  wa_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  role text not null check (role in ('client', 'assistant', 'owner')),
  message_type text not null default 'text',
  body text,
  topic text,
  intent_score text check (intent_score in ('high', 'medium', 'low')),
  handed_over boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.event_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'error')),
  title text not null,
  detail text not null,
  client_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.baileys_auth_state (
  state_key text primary key,
  payload text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_counters (
  id uuid primary key default gen_random_uuid(),
  period_key text not null unique,
  outbound_whatsapp integer not null default 0,
  gemini_requests integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  project_key text not null unique,
  checklist jsonb not null default '[]'::jsonb,
  answers jsonb not null default '{}'::jsonb,
  summary text not null default '',
  approved boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.insights (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  detail text not null,
  category text not null,
  status text not null default 'suggested' check (status in ('suggested', 'approved', 'dismissed')),
  created_at timestamptz not null default now()
);

alter table public.settings enable row level security;
alter table public.projects enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.event_log enable row level security;
alter table public.baileys_auth_state enable row level security;

-- The dashboard intentionally has no login. Keep the publishable-key policies narrow;
-- Baileys credentials remain server-only because no anon policies are created for that table.
create policy "public dashboard can read settings" on public.settings for select to anon, authenticated using (true);
create policy "public dashboard can read projects" on public.projects for select to anon, authenticated using (true);
create policy "public dashboard can read conversations" on public.conversations for select to anon, authenticated using (true);
create policy "public dashboard can read messages" on public.messages for select to anon, authenticated using (true);
create policy "public dashboard can read events" on public.event_log for select to anon, authenticated using (true);

insert into public.settings (business_name)
select 'WEBASI'
where not exists (select 1 from public.settings);
