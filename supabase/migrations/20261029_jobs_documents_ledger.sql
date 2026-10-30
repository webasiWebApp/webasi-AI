-- Client pipeline, documents and finance. Safe to run more than once.
--
-- A "job" is one client's whole engagement. It is unrelated to the AI-training "projects" table.
-- The rules that protect money live here, in constraints, triggers and functions, and not only in the server: the server
-- connects with the service-role key, which bypasses row-level security, so a buggy code path must still hit a wall.

-- ----- Settings used by the new module ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists next_document_number integer not null default 9248 check (next_document_number >= 1),
  add column if not exists default_advance_percent integer not null default 40 check (default_advance_percent between 1 and 100),
  add column if not exists registration_no text not null default '',
  add column if not exists document_settings jsonb not null default '{}'::jsonb,
  add column if not exists reminder_settings jsonb not null default '{}'::jsonb,
  add column if not exists ledger_categories jsonb not null default '{}'::jsonb,
  add column if not exists template_review_dismissed boolean not null default false;

-- ----- Jobs ------------------------------------------------------------------------------------------------------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  conversation_client_id text references public.conversations(client_id) on delete set null,
  client_name text not null check (length(trim(client_name)) > 0),
  client_phone text not null default '',
  title text not null check (length(trim(title)) > 0),
  stage text not null default 'lead' check (stage in ('lead', 'meeting', 'quoted', 'approved', 'active', 'delivered', 'closed', 'lost')),
  approved_quotation_id uuid,
  price_total numeric(14,2) check (price_total is null or price_total >= 0),
  advance_percent numeric(5,2) check (advance_percent is null or (advance_percent > 0 and advance_percent <= 100)),
  required_advance numeric(14,2) generated always as (round(price_total * advance_percent / 100, 2)) stored,
  started_at timestamptz,
  delivered_at timestamptz,
  closed_at timestamptz,
  estimated_delivery_date date,
  lost_from_stage text check (lost_from_stage in ('lead', 'meeting', 'quoted', 'approved')),
  lost_reason text,
  lost_at timestamptz,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_started_matches_stage check ((stage in ('active', 'delivered', 'closed')) = (started_at is not null)),
  constraint jobs_delivered_matches_stage check ((stage in ('delivered', 'closed')) = (delivered_at is not null)),
  constraint jobs_closed_matches_stage check ((stage = 'closed') = (closed_at is not null)),
  constraint jobs_lost_has_origin check ((stage = 'lost') = (lost_from_stage is not null)),
  constraint jobs_approved_has_price check (stage not in ('approved', 'active', 'delivered', 'closed') or (approved_quotation_id is not null and price_total is not null and advance_percent is not null))
);
create index if not exists jobs_stage_idx on public.jobs (stage);
create index if not exists jobs_conversation_idx on public.jobs (conversation_client_id);

-- ----- Meetings --------------------------------------------------------------------------------------------------
create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location_or_link text not null default '',
  notes text not null default '',
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled')),
  google_event_id text,
  sync_status text not null default 'not_configured' check (sync_status in ('pending', 'synced', 'failed', 'not_configured')),
  sync_error text,
  sync_attempts integer not null default 0,
  next_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meetings_ends_after_start check (ends_at > starts_at)
);
create index if not exists meetings_job_idx on public.meetings (job_id);
create index if not exists meetings_starts_idx on public.meetings (starts_at);

-- ----- The task checklist ----------------------------------------------------------------------------------------
create table if not exists public.task_templates (
  id uuid primary key default gen_random_uuid(),
  position integer not null,
  title text not null check (length(trim(title)) > 0)
);

create table if not exists public.job_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  position integer not null,
  title text not null check (length(trim(title)) > 0),
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  due_date date,
  done_at timestamptz,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists job_tasks_job_idx on public.job_tasks (job_id, position);
create index if not exists job_tasks_due_idx on public.job_tasks (due_date) where status <> 'done';

-- The default checklist, only into an empty table (editing it in Settings must survive a re-run of this file).
insert into public.task_templates (position, title)
select row_number() over (), title from unnest(array[
  'Requirement gathering (finalise SRS)',
  'Research (competitors, references, content)',
  'Sitemap and content collection',
  'UI/UX design',
  'Design approval from client',
  'Development (frontend and backend)',
  'Content upload and integrations (WhatsApp, Maps, social, forms)',
  'Basic SEO setup',
  'Testing (responsive, forms, speed, links)',
  'Deployment (domain, hosting, SSL, business emails)',
  'Google Search Console and indexing (submit sitemap)',
  'Analytics setup',
  'Final delivery to client',
  'Collect remaining payment',
  'Credentials handover',
  'Request client feedback'
]) as title
where not exists (select 1 from public.task_templates);

-- ----- Documents -------------------------------------------------------------------------------------------------
-- Only the form data is stored (payload); the PDF is regenerated on demand. Credentials are never stored here.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  kind text not null check (kind in ('quotation', 'contract', 'invoice', 'receipt', 'renewal_invoice', 'technical_doc', 'design_doc')),
  number text not null unique check (number ~ '^[0-9]{5,}$'),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  sent_at timestamptz,
  ledger_entry_id uuid,
  superseded_from text,
  superseded_by uuid,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_status_valid check (case when kind = 'quotation' then status in ('draft', 'sent', 'approved', 'superseded', 'rejected') else status in ('draft', 'sent', 'void') end),
  constraint documents_receipt_has_entry check (kind <> 'receipt' or ledger_entry_id is not null)
);
create index if not exists documents_job_kind_idx on public.documents (job_id, kind);
create unique index if not exists documents_one_approved_quotation on public.documents (job_id) where kind = 'quotation' and status = 'approved';
create unique index if not exists documents_one_receipt_per_entry on public.documents (ledger_entry_id) where kind = 'receipt';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_approved_quotation_fk') then
    alter table public.jobs add constraint jobs_approved_quotation_fk foreign key (approved_quotation_id) references public.documents(id) on delete restrict;
  end if;
end $$;

-- ----- The ledger ------------------------------------------------------------------------------------------------
create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs(id) on delete restrict,
  type text not null check (type in ('income', 'expense')),
  category text not null check (length(trim(category)) > 0),
  amount numeric(14,2) not null check (amount > 0),
  entry_date date not null default current_date,
  method text not null default 'bank_transfer' check (method in ('bank_transfer', 'cash', 'paypal', 'other')),
  note text not null default '',
  invoice_document_id uuid references public.documents(id) on delete set null,
  voided_at timestamptz,
  voided_reason text,
  replaces_entry_id uuid references public.ledger_entries(id) on delete restrict,
  idempotency_key text,
  is_start_advance boolean not null default false,
  created_at timestamptz not null default now(),
  -- Rule 1: income always belongs to a job. Expenses without a job are company expenses.
  constraint ledger_income_has_job check (type <> 'income' or job_id is not null),
  constraint ledger_income_category check (type <> 'income' or category in ('advance', 'final', 'renewal', 'extra')),
  constraint ledger_void_has_reason check ((voided_at is null) = (voided_reason is null) and (voided_reason is null or length(trim(voided_reason)) > 0)),
  constraint ledger_start_advance_is_advance check (not is_start_advance or (type = 'income' and category = 'advance'))
);
create index if not exists ledger_job_idx on public.ledger_entries (job_id);
create index if not exists ledger_date_idx on public.ledger_entries (entry_date);
create unique index if not exists ledger_idempotency_key_idx on public.ledger_entries (idempotency_key) where idempotency_key is not null;
create unique index if not exists ledger_one_start_advance on public.ledger_entries (job_id) where is_start_advance;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'documents_ledger_entry_fk') then
    alter table public.documents add constraint documents_ledger_entry_fk foreign key (ledger_entry_id) references public.ledger_entries(id) on delete restrict;
  end if;
end $$;

-- Rule 2: money can only be recorded against a job that has started. Rule 4: nothing is ever deleted; a mistake is
-- voided (with a reason) and, if needed, replaced. An entry that has a receipt keeps its amount, date, job and type.
create or replace function public.ledger_entries_guard() returns trigger language plpgsql as $$
declare
  j public.jobs%rowtype;
  replaced public.ledger_entries%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.voided_at is not null then raise exception 'a new ledger entry cannot be created void' using errcode = '23514'; end if;
    if new.job_id is not null then
      select * into j from public.jobs where id = new.job_id;
      if not found then raise exception 'job % does not exist', new.job_id using errcode = '23503'; end if;
      if j.started_at is null then raise exception 'job % has not started: no money can be recorded against it yet', new.job_id using errcode = '23514'; end if;
    end if;
    if new.replaces_entry_id is not null then
      select * into replaced from public.ledger_entries where id = new.replaces_entry_id;
      if not found or replaced.voided_at is null then raise exception 'only a voided entry can be replaced' using errcode = '23514'; end if;
    end if;
    return new;
  end if;

  if old.voided_at is not null then raise exception 'a voided ledger entry cannot be changed' using errcode = '23514'; end if;
  if new.is_start_advance is distinct from old.is_start_advance or new.idempotency_key is distinct from old.idempotency_key or new.replaces_entry_id is distinct from old.replaces_entry_id then
    raise exception 'the origin of a ledger entry cannot be changed' using errcode = '23514';
  end if;
  if (new.amount, new.entry_date, new.job_id, new.type, new.category) is distinct from (old.amount, old.entry_date, old.job_id, old.type, old.category) then
    if exists (select 1 from public.documents where ledger_entry_id = old.id and kind = 'receipt') then
      raise exception 'this entry has a receipt: void it with a reason and record a new one instead of changing it' using errcode = '23514';
    end if;
    if new.job_id is not null and new.job_id is distinct from old.job_id then
      select * into j from public.jobs where id = new.job_id;
      if not found or j.started_at is null then raise exception 'job % has not started: no money can be recorded against it yet', new.job_id using errcode = '23514'; end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists ledger_entries_guard on public.ledger_entries;
create trigger ledger_entries_guard before insert or update on public.ledger_entries for each row execute function public.ledger_entries_guard();

create or replace function public.ledger_entries_reject_delete() returns trigger language plpgsql as $$
begin
  raise exception 'ledger entries are never deleted: void the entry with a reason instead' using errcode = '23514';
end $$;

drop trigger if exists ledger_entries_no_delete on public.ledger_entries;
create trigger ledger_entries_no_delete before delete on public.ledger_entries for each row execute function public.ledger_entries_reject_delete();
drop trigger if exists ledger_entries_no_truncate on public.ledger_entries;
create trigger ledger_entries_no_truncate before truncate on public.ledger_entries for each statement execute function public.ledger_entries_reject_delete();

-- Voiding an entry voids its receipt, which stays on file and downloadable, stamped VOID.
create or replace function public.ledger_entries_void_receipt() returns trigger language plpgsql as $$
begin
  update public.documents set status = 'void', voided_at = new.voided_at, updated_at = now() where ledger_entry_id = new.id and kind = 'receipt' and status <> 'void';
  return new;
end $$;

drop trigger if exists ledger_entries_void_receipt on public.ledger_entries;
create trigger ledger_entries_void_receipt after update of voided_at on public.ledger_entries for each row when (old.voided_at is null and new.voided_at is not null) execute function public.ledger_entries_void_receipt();

-- Document rules: numbers and links never change, an approved quotation is read-only, a receipt is a snapshot,
-- a void document stays void, and a receipt can only point at a live income entry of its own job.
create or replace function public.documents_guard() returns trigger language plpgsql as $$
declare
  entry public.ledger_entries%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.kind = 'receipt' then
      select * into entry from public.ledger_entries where id = new.ledger_entry_id;
      if not found or entry.type <> 'income' or entry.voided_at is not null or entry.job_id is distinct from new.job_id then
        raise exception 'a receipt needs a live income entry of the same job' using errcode = '23514';
      end if;
    elsif new.ledger_entry_id is not null then
      raise exception 'only a receipt is linked to a ledger entry' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.number is distinct from old.number or new.kind is distinct from old.kind or new.job_id is distinct from old.job_id or new.ledger_entry_id is distinct from old.ledger_entry_id then
    raise exception 'the number, kind, job and ledger link of a document never change' using errcode = '23514';
  end if;
  if old.kind = 'quotation' and old.status = 'approved' then
    if new.payload is distinct from old.payload then raise exception 'an approved quotation is read-only: revoke the approval first' using errcode = '23514'; end if;
    if new.status is distinct from old.status and coalesce(current_setting('webasi.revoking', true), '') <> 'on' then
      raise exception 'an approved quotation can only be released by revoking the approval' using errcode = '23514';
    end if;
  end if;
  if old.kind = 'receipt' and new.payload is distinct from old.payload then raise exception 'a receipt is a snapshot and cannot be edited' using errcode = '23514'; end if;
  if old.status = 'void' and new.status <> 'void' then raise exception 'a void document stays void' using errcode = '23514'; end if;
  return new;
end $$;

drop trigger if exists documents_guard on public.documents;
create trigger documents_guard before insert or update on public.documents for each row execute function public.documents_guard();

-- ----- Functions the server calls --------------------------------------------------------------------------------
-- The next document number: one counter for every kind, issued inside one transaction. The row lock on settings makes
-- concurrent callers take turns, so two documents never get the same number. A gap is possible, a duplicate is not.
create or replace function public.issue_document_number() returns text language plpgsql as $$
declare
  issued integer;
begin
  update public.settings set next_document_number = next_document_number + 1 where singleton_key = 'owner' returning next_document_number - 1 into issued;
  if issued is null then raise exception 'the settings row does not exist yet' using errcode = 'P0002'; end if;
  return lpad(issued::text, 5, '0');
end $$;

create or replace function public.job_received(p_job_id uuid) returns numeric language sql stable as $$
  select coalesce(sum(amount), 0) from public.ledger_entries
  where job_id = p_job_id and type = 'income' and category in ('advance', 'final') and voided_at is null;
$$;

create or replace function public.create_document(p_job_id uuid, p_kind text, p_payload jsonb, p_ledger_entry_id uuid default null)
returns public.documents language plpgsql as $$
declare
  j public.jobs%rowtype;
  doc public.documents%rowtype;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % does not exist', p_job_id using errcode = 'P0002'; end if;
  if j.stage = 'lost' then raise exception 'a lost job gets no new documents' using errcode = '23514'; end if;
  if p_kind = 'quotation' and j.stage not in ('lead', 'meeting', 'quoted') then
    raise exception 'a quotation can only be written before the job is approved (stage is %)', j.stage using errcode = '23514';
  end if;
  if p_kind = 'contract' and j.stage not in ('approved', 'active', 'delivered', 'closed') then
    raise exception 'the proposal and contract pack needs an approved quotation (stage is %)', j.stage using errcode = '23514';
  end if;
  insert into public.documents (job_id, kind, number, payload, status, ledger_entry_id)
  values (p_job_id, p_kind, public.issue_document_number(), coalesce(p_payload, '{}'::jsonb), 'draft', p_ledger_entry_id)
  returning * into doc;
  if p_kind = 'quotation' and j.stage in ('lead', 'meeting') then
    update public.jobs set stage = 'quoted', updated_at = now() where id = p_job_id;
  end if;
  return doc;
end $$;

-- The client said yes to this one quotation. Everything happens together: the job takes its price and advance
-- percentage from it, it becomes approved, and the job's other open quotations are superseded.
create or replace function public.approve_quotation(p_quotation_id uuid) returns public.jobs language plpgsql as $$
declare
  q public.documents%rowtype;
  j public.jobs%rowtype;
  total numeric(14,2);
  pct numeric;
begin
  select * into q from public.documents where id = p_quotation_id and kind = 'quotation';
  if not found then raise exception 'quotation % does not exist', p_quotation_id using errcode = 'P0002'; end if;
  select * into j from public.jobs where id = q.job_id for update;
  select * into q from public.documents where id = p_quotation_id for update;
  if j.stage <> 'quoted' then raise exception 'the job must be quoted to approve a quotation (stage is %)', j.stage using errcode = '23514'; end if;
  if q.status <> 'sent' then raise exception 'only a quotation marked as sent can be approved (status is %)', q.status using errcode = '23514'; end if;
  select coalesce(sum((item ->> 'cost')::numeric), 0) into total from jsonb_array_elements(coalesce(q.payload -> 'items', '[]'::jsonb)) as item;
  if total <= 0 then raise exception 'the quotation has no price' using errcode = '23514'; end if;
  pct := coalesce((q.payload ->> 'advancePercent')::numeric, (select default_advance_percent from public.settings where singleton_key = 'owner'), 40);
  update public.documents set superseded_from = status, status = 'superseded', superseded_by = q.id, updated_at = now()
    where job_id = j.id and kind = 'quotation' and id <> q.id and status in ('draft', 'sent');
  update public.documents set status = 'approved', updated_at = now() where id = q.id;
  update public.jobs set stage = 'approved', approved_quotation_id = q.id, price_total = total, advance_percent = pct, updated_at = now()
    where id = j.id returning * into j;
  return j;
end $$;

-- Undo an approval, only before the project has started. The job goes back to quoted and the quotations that were
-- superseded by this approval return to the state they were in.
create or replace function public.revoke_approval(p_job_id uuid) returns public.jobs language plpgsql as $$
declare
  j public.jobs%rowtype;
  approved_id uuid;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % does not exist', p_job_id using errcode = 'P0002'; end if;
  if j.stage <> 'approved' then raise exception 'an approval can only be revoked before the project starts (stage is %)', j.stage using errcode = '23514'; end if;
  approved_id := j.approved_quotation_id;
  perform set_config('webasi.revoking', 'on', true);
  update public.documents set status = 'sent', updated_at = now() where id = approved_id;
  update public.documents set status = coalesce(superseded_from, 'sent'), superseded_from = null, superseded_by = null, updated_at = now()
    where superseded_by = approved_id and status = 'superseded';
  perform set_config('webasi.revoking', 'off', true);
  update public.jobs set stage = 'quoted', approved_quotation_id = null, price_total = null, advance_percent = null, updated_at = now()
    where id = j.id returning * into j;
  return j;
end $$;

-- Start project: one atomic, repeatable action. It records the full agreed advance, copies the task template into the
-- job's checklist, stamps started_at and moves the job to active. If anything fails nothing is kept. Calling it again for
-- a job that has started returns what the first call did instead of paying twice.
create or replace function public.start_project(p_job_id uuid, p_amount numeric, p_idempotency_key text, p_method text default 'bank_transfer', p_entry_date date default current_date, p_note text default '')
returns jsonb language plpgsql as $$
declare
  j public.jobs%rowtype;
  e public.ledger_entries%rowtype;
  task_count integer;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then raise exception 'an idempotency key is required' using errcode = '22023'; end if;
  select * into j from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % does not exist', p_job_id using errcode = 'P0002'; end if;
  select * into e from public.ledger_entries where job_id = j.id and is_start_advance;
  if found then
    return jsonb_build_object('job_id', j.id, 'ledger_entry_id', e.id, 'amount', e.amount, 'already_started', true, 'tasks', (select count(*) from public.job_tasks where job_id = j.id));
  end if;
  if j.stage <> 'approved' then raise exception 'the project can only be started from the approved stage (stage is %)', j.stage using errcode = '23514'; end if;
  if p_amount is null or round(p_amount, 2) < j.required_advance then
    raise exception 'the advance must be at least the required advance of % (got %)', j.required_advance, p_amount using errcode = '23514';
  end if;
  update public.jobs set stage = 'active', started_at = now(), updated_at = now() where id = j.id;
  insert into public.ledger_entries (job_id, type, category, amount, entry_date, method, note, idempotency_key, is_start_advance)
  values (j.id, 'income', 'advance', round(p_amount, 2), p_entry_date, p_method, coalesce(p_note, ''), 'start:' || p_idempotency_key, true)
  returning * into e;
  insert into public.job_tasks (job_id, position, title) select j.id, position, title from public.task_templates order by position;
  get diagnostics task_count = row_count;
  return jsonb_build_object('job_id', j.id, 'ledger_entry_id', e.id, 'amount', e.amount, 'already_started', false, 'tasks', task_count);
end $$;

create or replace function public.close_job(p_job_id uuid) returns public.jobs language plpgsql as $$
declare
  j public.jobs%rowtype;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % does not exist', p_job_id using errcode = 'P0002'; end if;
  if j.stage <> 'delivered' then raise exception 'only a delivered job can be closed (stage is %)', j.stage using errcode = '23514'; end if;
  if j.price_total - public.job_received(j.id) > 0 then raise exception 'the outstanding balance must be zero before the job is closed' using errcode = '23514'; end if;
  update public.jobs set stage = 'closed', closed_at = now(), updated_at = now() where id = j.id returning * into j;
  return j;
end $$;

create or replace function public.mark_lost(p_job_id uuid, p_reason text) returns public.jobs language plpgsql as $$
declare
  j public.jobs%rowtype;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % does not exist', p_job_id using errcode = 'P0002'; end if;
  if j.stage not in ('lead', 'meeting', 'quoted', 'approved') then raise exception 'a job can only be marked lost before it starts (stage is %)', j.stage using errcode = '23514'; end if;
  update public.jobs set lost_from_stage = stage, stage = 'lost', lost_reason = nullif(trim(coalesce(p_reason, '')), ''), lost_at = now(), updated_at = now()
    where id = j.id returning * into j;
  return j;
end $$;

create or replace function public.reopen_job(p_job_id uuid) returns public.jobs language plpgsql as $$
declare
  j public.jobs%rowtype;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % does not exist', p_job_id using errcode = 'P0002'; end if;
  if j.stage <> 'lost' then raise exception 'only a lost job can be reopened (stage is %)', j.stage using errcode = '23514'; end if;
  update public.jobs set stage = lost_from_stage, lost_from_stage = null, lost_reason = null, lost_at = null, updated_at = now()
    where id = j.id returning * into j;
  return j;
end $$;

create or replace function public.void_ledger_entry(p_id uuid, p_reason text) returns public.ledger_entries language plpgsql as $$
declare
  e public.ledger_entries%rowtype;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'a reason is required to void an entry' using errcode = '22023'; end if;
  update public.ledger_entries set voided_at = now(), voided_reason = trim(p_reason) where id = p_id and voided_at is null returning * into e;
  if not found then raise exception 'the entry does not exist or is already void' using errcode = 'P0002'; end if;
  return e;
end $$;

-- The whole task template is replaced in one step, in the order given.
create or replace function public.replace_task_templates(p_titles text[]) returns integer language plpgsql as $$
declare
  total integer;
begin
  delete from public.task_templates;
  insert into public.task_templates (position, title)
  select ordinality, trim(title) from unnest(p_titles) with ordinality as t(title, ordinality) where length(trim(title)) > 0;
  get diagnostics total = row_count;
  return total;
end $$;

-- ----- Lockdown --------------------------------------------------------------------------------------------------
-- Like every other table: the server uses the service-role key and the browser key gets nothing.
alter table public.jobs enable row level security;
alter table public.meetings enable row level security;
alter table public.task_templates enable row level security;
alter table public.job_tasks enable row level security;
alter table public.documents enable row level security;
alter table public.ledger_entries enable row level security;
revoke all on public.jobs, public.meetings, public.task_templates, public.job_tasks, public.documents, public.ledger_entries from anon, authenticated;

revoke execute on function public.issue_document_number() from public, anon, authenticated;
revoke execute on function public.job_received(uuid) from public, anon, authenticated;
revoke execute on function public.create_document(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.approve_quotation(uuid) from public, anon, authenticated;
revoke execute on function public.revoke_approval(uuid) from public, anon, authenticated;
revoke execute on function public.start_project(uuid, numeric, text, text, date, text) from public, anon, authenticated;
revoke execute on function public.close_job(uuid) from public, anon, authenticated;
revoke execute on function public.mark_lost(uuid, text) from public, anon, authenticated;
revoke execute on function public.reopen_job(uuid) from public, anon, authenticated;
revoke execute on function public.void_ledger_entry(uuid, text) from public, anon, authenticated;
revoke execute on function public.replace_task_templates(text[]) from public, anon, authenticated;
grant execute on function public.issue_document_number() to service_role;
grant execute on function public.job_received(uuid) to service_role;
grant execute on function public.create_document(uuid, text, jsonb, uuid) to service_role;
grant execute on function public.approve_quotation(uuid) to service_role;
grant execute on function public.revoke_approval(uuid) to service_role;
grant execute on function public.start_project(uuid, numeric, text, text, date, text) to service_role;
grant execute on function public.close_job(uuid) to service_role;
grant execute on function public.mark_lost(uuid, text) to service_role;
grant execute on function public.reopen_job(uuid) to service_role;
grant execute on function public.void_ledger_entry(uuid, text) to service_role;
grant execute on function public.replace_task_templates(text[]) to service_role;
