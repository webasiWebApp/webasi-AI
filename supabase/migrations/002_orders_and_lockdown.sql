-- Orders were only persisted to MySQL; with Supabase as the only database they were silently dropped.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_key text not null unique,
  client_id text not null,
  wa_id text not null,
  package_name text not null,
  deposit_amount integer not null,
  state text not null default 'awaiting_deposit' check (state in ('awaiting_deposit', 'slip_received', 'confirmed_by_owner', 'cancelled')),
  slip_media_id text,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The server uses the service-role key (bypasses RLS) and the browser no longer talks to Supabase.
-- Without RLS these tables were readable AND writable by anyone holding the publishable key.
alter table public.usage_counters enable row level security;
alter table public.training_sessions enable row level security;
alter table public.insights enable row level security;
alter table public.orders enable row level security;

-- Client chats and settings should not be readable with the public key.
drop policy if exists "public dashboard can read settings" on public.settings;
drop policy if exists "public dashboard can read projects" on public.projects;
drop policy if exists "public dashboard can read conversations" on public.conversations;
drop policy if exists "public dashboard can read messages" on public.messages;
drop policy if exists "public dashboard can read events" on public.event_log;
