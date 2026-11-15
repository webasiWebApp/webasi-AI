-- The assistant speaks as a named team member and copies the voice of real messages the owner wrote.
alter table public.settings add column if not exists assistant_name text;
alter table public.settings add column if not exists style_examples text;
