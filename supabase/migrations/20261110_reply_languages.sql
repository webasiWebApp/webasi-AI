-- Owner switches for the languages WEBASI may reply in. Null means all on.
alter table public.settings add column if not exists reply_languages jsonb;
