-- Atomic writes and indexes. Safe to run more than once.
-- The server works without this file (it falls back to read-then-write) and uses the functions as soon as they exist.

-- Adds one message to the end of a chat's transcript and keeps the newest p_limit. It is a single UPDATE, so two
-- writers at the same moment (a reply being recorded while the owner's message arrives) both land.
create or replace function public.append_conversation_message(p_client_id text, p_message jsonb, p_limit integer default 20)
returns void
language sql
as $$
  update public.conversations
  set recent_messages = (
        select coalesce(jsonb_agg(newest.item order by newest.position), '[]'::jsonb)
        from (
          select entries.item, entries.position
          from jsonb_array_elements(coalesce(recent_messages, '[]'::jsonb) || jsonb_build_array(p_message)) with ordinality as entries(item, position)
          order by entries.position desc
          limit greatest(p_limit, 1)
        ) as newest
      ),
      updated_at = now()
  where client_id = p_client_id;
$$;

-- Makes one project the active one. Both steps commit together, so clients never see two active projects or none.
-- The other project is deactivated first because the one-active index is checked row by row.
create or replace function public.activate_project(p_project_key text)
returns void
language plpgsql
as $$
begin
  update public.projects set status = 'approved' where status = 'active' and project_key <> p_project_key;
  update public.projects set status = 'active', updated_at = now() where project_key = p_project_key;
  if not found then
    raise exception 'project % does not exist', p_project_key;
  end if;
end;
$$;

-- Server-only, like the tables: the browser key must not be able to call these.
revoke execute on function public.append_conversation_message(text, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.activate_project(text) from public, anon, authenticated;
grant execute on function public.append_conversation_message(text, jsonb, integer) to service_role;
grant execute on function public.activate_project(text) to service_role;

-- Each index backs a query the dashboard or the scheduler repeats: the conversation and event lists it refreshes every
-- few seconds, the "when did this last happen" lookups, the weekly counts, and the order and draft lists.
create index if not exists conversations_updated_at_idx on public.conversations (updated_at desc);
create index if not exists event_log_created_at_idx on public.event_log (created_at desc);
create index if not exists event_log_type_created_idx on public.event_log (event_type, created_at desc);
create index if not exists messages_created_at_idx on public.messages (created_at desc);
create index if not exists orders_updated_at_idx on public.orders (updated_at desc);
create index if not exists orders_wa_state_idx on public.orders (wa_id, state);
create index if not exists insights_category_status_idx on public.insights (category, status, created_at desc);
