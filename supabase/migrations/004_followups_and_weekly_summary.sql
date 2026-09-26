-- One gentle follow-up per silence: remembers when the last one was sent.
alter table public.conversations add column if not exists followup_sent_at timestamptz;

-- Owner switches for the follow-up nudges and the Monday summary.
alter table public.settings add column if not exists followups_enabled boolean not null default true;
alter table public.settings add column if not exists weekly_summary_enabled boolean not null default true;
