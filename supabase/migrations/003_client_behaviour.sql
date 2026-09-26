-- Client behaviour signals detected on every turn, plus a running memory of the client.
alter table public.conversations add column if not exists sentiment text check (sentiment in ('positive', 'neutral', 'confused', 'frustrated'));
alter table public.conversations add column if not exists objection text check (objection in ('none', 'price', 'timeline', 'trust', 'scope', 'competitor', 'thinking_it_over'));
alter table public.conversations add column if not exists language text;
alter table public.conversations add column if not exists client_notes text not null default '';

-- The AI provider switch on Home survives restarts.
alter table public.settings add column if not exists ai_provider text check (ai_provider in ('gemini', 'groq'));

-- Learned answers from owner replies are linked to the conversation they came from.
alter table public.insights add column if not exists client_id text;
