-- Questions WEBASI could not answer, kept so the owner can supply the answer from the Training tab.
-- The table already exists in the live database (it was created by hand); this records it for fresh setups.
create table if not exists public.knowledge_gaps (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  reason text not null default '',
  client_id text,
  status text not null default 'pending' check (status in ('pending', 'answered')),
  answer text,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_gaps_status_created_idx on public.knowledge_gaps (status, created_at desc);

-- Server-only, like the other tables: the service-role key bypasses RLS and the browser never reads this directly.
alter table public.knowledge_gaps enable row level security;
