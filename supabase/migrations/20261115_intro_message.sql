-- A short introduction sent before the first reply to a new client, optionally with a screenshot of client reviews.
alter table public.settings add column if not exists intro_message text;
alter table public.settings add column if not exists intro_image text;
