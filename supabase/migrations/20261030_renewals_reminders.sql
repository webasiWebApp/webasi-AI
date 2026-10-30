-- Renewals after delivery, and the log that keeps owner reminders from ever being sent twice. Safe to run more than once.
-- Needs 20261029_jobs_documents_ledger.sql.

create table if not exists public.renewals (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  kind text not null check (kind in ('hosting', 'domain', 'support')),
  due_date date not null,
  amount numeric(14,2) not null default 0 check (amount >= 0),
  status text not null default 'upcoming' check (status in ('upcoming', 'invoiced', 'paid', 'skipped')),
  invoice_document_id uuid references public.documents(id) on delete set null,
  paid_ledger_entry_id uuid references public.ledger_entries(id) on delete restrict,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint renewals_one_per_kind_and_date unique (job_id, kind, due_date)
);
create index if not exists renewals_due_idx on public.renewals (due_date) where status in ('upcoming', 'invoiced');

-- Delivering a job and creating its default renewals (hosting, domain, support, one year on) is one step.
create or replace function public.mark_delivered(p_job_id uuid) returns public.jobs language plpgsql as $$
declare
  j public.jobs%rowtype;
  delivered_on date := (now() at time zone 'Asia/Colombo')::date;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % does not exist', p_job_id using errcode = 'P0002'; end if;
  if j.stage <> 'active' then raise exception 'only an active job can be marked delivered (stage is %)', j.stage using errcode = '23514'; end if;
  update public.jobs set stage = 'delivered', delivered_at = now(), updated_at = now() where id = j.id returning * into j;
  insert into public.renewals (job_id, kind, due_date)
  select j.id, kind, (delivered_on + interval '1 year')::date from unnest(array['hosting', 'domain', 'support']) as kind
  on conflict (job_id, kind, due_date) do nothing;
  return j;
end $$;

-- One row per reminder that was ever due. reminder_key is the identity of the reminder:
--   quotation:<quotation id>:<sent_at>   balance:<job id>:<delivered_at>   renewal:<renewal id>:<due date>:30d|7d
-- Whoever inserts the row first owns the send. Editing or regenerating a document changes none of these keys.
create table if not exists public.reminder_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('quotation', 'balance', 'renewal')),
  reminder_key text not null unique,
  subject_id uuid not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  attempts integer not null default 1,
  last_error text,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- True when the caller now owns the send. A first claim wins; a failed one can be claimed again (up to 3 attempts, once
-- its backoff has passed); a claim whose owner vanished (a crash between claiming and sending) is taken over after
-- p_stale_minutes. A reminder that was sent is never claimed again.
create or replace function public.claim_reminder(p_key text, p_kind text, p_subject uuid, p_stale_minutes integer default 15) returns boolean language plpgsql as $$
declare
  claimed integer;
begin
  insert into public.reminder_log as r (kind, reminder_key, subject_id, status, attempts)
  values (p_kind, p_key, p_subject, 'claimed', 1)
  on conflict (reminder_key) do update
    set status = 'claimed', attempts = r.attempts + 1, updated_at = now()
    where (r.status = 'failed' and r.attempts < 3 and coalesce(r.next_attempt_at, now()) <= now())
       or (r.status = 'claimed' and r.updated_at < now() - make_interval(mins => p_stale_minutes));
  get diagnostics claimed = row_count;
  return claimed > 0;
end $$;

-- Records how the send ended. A failure waits 10, then 40 minutes before the next claim is allowed.
create or replace function public.finish_reminder(p_key text, p_ok boolean, p_error text default null) returns void language plpgsql as $$
begin
  if p_ok then
    update public.reminder_log set status = 'sent', sent_at = now(), last_error = null, next_attempt_at = null, updated_at = now() where reminder_key = p_key;
  else
    update public.reminder_log set status = 'failed', last_error = left(coalesce(p_error, 'send failed'), 500),
      next_attempt_at = now() + make_interval(mins => 10 * attempts * attempts), updated_at = now() where reminder_key = p_key;
  end if;
end $$;

alter table public.renewals enable row level security;
alter table public.reminder_log enable row level security;
revoke all on public.renewals, public.reminder_log from anon, authenticated;
revoke execute on function public.mark_delivered(uuid) from public, anon, authenticated;
revoke execute on function public.claim_reminder(text, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.finish_reminder(text, boolean, text) from public, anon, authenticated;
grant execute on function public.mark_delivered(uuid) to service_role;
grant execute on function public.claim_reminder(text, text, uuid, integer) to service_role;
grant execute on function public.finish_reminder(text, boolean, text) to service_role;
