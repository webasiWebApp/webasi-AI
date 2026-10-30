import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// The pipeline module's rules, tested in a real Postgres running inside this process (PGlite) by calling the SQL
// directly, the way a buggy server code path would. The service-role key bypasses row-level security, so these rules
// have to hold in the database itself. Nothing here touches the hosted database.
const migrationsDir = path.resolve(import.meta.dirname, "../supabase/migrations");
const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const sql = (name: string) => fs.readFileSync(path.join(migrationsDir, name), "utf8").replace(/^create extension if not exists pgcrypto;\s*$/m, "");
const NEW_FILES = ["20261029_jobs_documents_ledger.sql", "20261030_renewals_reminders.sql"];

let db: PGlite;
const rows = async <T = Record<string, any>>(query: string, params: unknown[] = []) => (await db.query<T>(query, params)).rows;
const one = async <T = Record<string, any>>(query: string, params: unknown[] = []) => (await rows<T>(query, params))[0];

async function newDatabase(upTo?: string) {
  const fresh = new PGlite();
  await fresh.exec("create role anon; create role authenticated; create role service_role;");
  for (const name of files) { if (upTo && name > upTo) break; await fresh.exec(sql(name)); }
  return fresh;
}

beforeAll(async () => {
  db = await newDatabase();
  await db.exec("insert into settings (singleton_key) values ('owner') on conflict do nothing;");
}, 60_000);

const quotation = (cost = 40_000, extra: Record<string, unknown> = {}) => JSON.stringify({ items: [{ description: "Website", cost }], advancePercent: 40, ...extra });
async function newJob(name = "Client") {
  return (await one<{ id: string }>("insert into jobs (client_name, title) values ($1, 'Website') returning id", [name])).id;
}
async function sentQuotation(jobId: string, cost = 40_000) {
  const doc = await one<{ id: string }>("select * from create_document($1, 'quotation', $2::jsonb)", [jobId, quotation(cost)]);
  await db.query("update documents set status = 'sent', sent_at = now() where id = $1", [doc.id]);
  return doc.id;
}
async function approvedJob(cost = 40_000) {
  const jobId = await newJob();
  const quotationId = await sentQuotation(jobId, cost);
  await db.query("select * from approve_quotation($1)", [quotationId]);
  return { jobId, quotationId };
}
async function startedJob(cost = 40_000) {
  const { jobId, quotationId } = await approvedJob(cost);
  await db.query("select start_project($1, $2, $3)", [jobId, cost * 0.4, `key-${jobId}`]);
  return { jobId, quotationId };
}
const stage = async (jobId: string) => (await one<{ stage: string }>("select stage from jobs where id = $1", [jobId])).stage;

describe("migrations", () => {
  it("apply to a database already at the previous migration, and again on top of themselves", async () => {
    const previous = await newDatabase("20261011_atomic_writes_and_indexes.sql");
    const before = (await previous.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")).rows.map((row) => row.tablename);
    expect(before).not.toContain("jobs");
    for (const name of NEW_FILES) await previous.exec(sql(name));
    for (const name of NEW_FILES) await previous.exec(sql(name));
    expect((await previous.query("select count(*)::int as n from task_templates")).rows[0]).toEqual({ n: 16 });
  });

  it("seed the default task template once, and keep the owner's edits on a re-run", async () => {
    expect(await one("select count(*)::int as n from task_templates")).toEqual({ n: 16 });
    await db.query("select replace_task_templates($1)", [["Only task"]]);
    for (const name of NEW_FILES) await db.exec(sql(name));
    expect(await rows("select title from task_templates")).toEqual([{ title: "Only task" }]);
    await db.query("select replace_task_templates($1)", [["Requirement gathering", "Research", "Design"]]);
  });

  it("close the new tables and functions to the browser key", async () => {
    await db.exec("set role anon");
    try {
      await expect(db.query("select * from jobs")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from ledger_entries")).rejects.toThrow(/permission denied/);
      await expect(db.query("select issue_document_number()")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from start_project('00000000-0000-0000-0000-000000000000', 1, 'k')")).rejects.toThrow(/permission denied/);
    } finally { await db.exec("reset role"); }
    expect(await rows("select tablename from pg_tables where schemaname = 'public' and not rowsecurity")).toEqual([]);
  });
});

describe("job stage rules in the database", () => {
  it("refuses a stage that contradicts its timestamps or price", async () => {
    await expect(db.query("insert into jobs (client_name, title, stage) values ('X', 'Y', 'active')")).rejects.toThrow(/jobs_started_matches_stage|jobs_approved_has_price/);
    await expect(db.query("insert into jobs (client_name, title, stage, started_at) values ('X', 'Y', 'lead', now())")).rejects.toThrow(/jobs_started_matches_stage/);
    await expect(db.query("insert into jobs (client_name, title, stage) values ('X', 'Y', 'approved')")).rejects.toThrow(/jobs_approved_has_price|approved/);
    await expect(db.query("insert into jobs (client_name, title, stage) values ('X', 'Y', 'lost')")).rejects.toThrow(/jobs_lost_has_origin/);
  });

  it("computes the required advance from the price and percentage", async () => {
    const { jobId } = await approvedJob(45_555);
    expect(await one("select price_total::float as price, advance_percent::float as pct, required_advance::float as advance from jobs where id = $1", [jobId])).toEqual({ price: 45_555, pct: 40, advance: 18_222 });
  });
});

describe("document numbers", () => {
  it("are unique and sequential across concurrent calls", async () => {
    const start = (await one<{ next_document_number: number }>("select next_document_number from settings")).next_document_number;
    const jobId = await newJob();
    const created = await Promise.all(Array.from({ length: 25 }, (_, index) => db.query<{ number: string }>("select number from create_document($1, $2, '{}'::jsonb)", [jobId, index % 2 ? "invoice" : "quotation"])));
    const numbers = created.map((result) => result.rows[0].number).sort();
    expect(new Set(numbers).size).toBe(25);
    expect(numbers[0]).toBe(String(start).padStart(5, "0"));
    expect(numbers.at(-1)).toBe(String(start + 24).padStart(5, "0"));
    expect((await one<{ next_document_number: number }>("select next_document_number from settings")).next_document_number).toBe(start + 25);
  });

  it("are never reused, even when the document insert fails afterwards", async () => {
    const jobId = await newJob();
    const before = (await one<{ next_document_number: number }>("select next_document_number from settings")).next_document_number;
    await expect(db.query("insert into documents (job_id, kind, number, status) values ($1, 'invoice', issue_document_number(), 'nonsense')", [jobId])).rejects.toThrow();
    const next = await one<{ number: string }>("select number from create_document($1, 'invoice', '{}'::jsonb)", [jobId]);
    expect(Number(next.number)).toBeGreaterThanOrEqual(before);
    await expect(db.query("insert into documents (job_id, kind, number) values ($1, 'invoice', $2)", [jobId, next.number])).rejects.toThrow(/duplicate key/);
  });

  it("never change once issued", async () => {
    const jobId = await newJob();
    const doc = await one<{ id: string }>("select * from create_document($1, 'invoice', '{}'::jsonb)", [jobId]);
    await expect(db.query("update documents set number = '99999' where id = $1", [doc.id])).rejects.toThrow(/never change/);
  });
});

describe("quotations and approval", () => {
  it("only a quotation marked as sent can be approved", async () => {
    const jobId = await newJob();
    const draft = await one<{ id: string }>("select * from create_document($1, 'quotation', $2::jsonb)", [jobId, quotation()]);
    await expect(db.query("select * from approve_quotation($1)", [draft.id])).rejects.toThrow(/marked as sent/);
    expect(await stage(jobId)).toBe("quoted");
  });

  it("approving takes price and advance from that quotation and supersedes the others, in one step", async () => {
    const jobId = await newJob();
    const first = await sentQuotation(jobId, 50_000);
    const second = await sentQuotation(jobId, 40_000);
    const draft = (await one<{ id: string }>("select * from create_document($1, 'quotation', $2::jsonb)", [jobId, quotation(10_000)])).id;
    await db.query("select * from approve_quotation($1)", [second]);
    expect(await one("select stage, approved_quotation_id = $2 as chosen, price_total::float as price from jobs where id = $1", [jobId, second])).toEqual({ stage: "approved", chosen: true, price: 40_000 });
    const statuses = Object.fromEntries((await rows<{ id: string; status: string }>("select id, status from documents where job_id = $1", [jobId])).map((row) => [row.id, row.status]));
    expect(statuses).toEqual({ [first]: "superseded", [second]: "approved", [draft]: "superseded" });
  });

  it("two quotations approved at the same moment: exactly one wins", async () => {
    const jobId = await newJob();
    const a = await sentQuotation(jobId, 30_000);
    const b = await sentQuotation(jobId, 60_000);
    const results = await Promise.allSettled([db.query("select * from approve_quotation($1)", [a]), db.query("select * from approve_quotation($1)", [b])]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await rows("select id from documents where job_id = $1 and status = 'approved'", [jobId])).toHaveLength(1);
  });

  it("an approved quotation is read-only until the approval is revoked", async () => {
    const { jobId, quotationId } = await approvedJob();
    await expect(db.query("update documents set payload = '{}'::jsonb where id = $1", [quotationId])).rejects.toThrow(/read-only/);
    await expect(db.query("update documents set status = 'draft' where id = $1", [quotationId])).rejects.toThrow(/revoking the approval/);
    await expect(db.query("insert into documents (job_id, kind, number) values ($1, 'quotation', '77777')", [jobId]).then(() => db.query("select * from create_document($1, 'quotation', '{}'::jsonb)", [jobId]))).rejects.toThrow(/before the job is approved/);
  });

  it("revoking an approval restores the quotations it superseded and clears the price", async () => {
    const jobId = await newJob();
    const first = await sentQuotation(jobId, 50_000);
    const second = await sentQuotation(jobId, 40_000);
    const draft = (await one<{ id: string }>("select * from create_document($1, 'quotation', $2::jsonb)", [jobId, quotation(10_000)])).id;
    await db.query("select * from approve_quotation($1)", [second]);
    await db.query("select * from revoke_approval($1)", [jobId]);
    expect(await one("select stage, approved_quotation_id, price_total from jobs where id = $1", [jobId])).toEqual({ stage: "quoted", approved_quotation_id: null, price_total: null });
    const statuses = Object.fromEntries((await rows<{ id: string; status: string }>("select id, status from documents where job_id = $1", [jobId])).map((row) => [row.id, row.status]));
    expect(statuses).toEqual({ [first]: "sent", [second]: "sent", [draft]: "draft" });
    await db.query("update documents set payload = $2::jsonb where id = $1", [second, quotation(41_000)]); // editable again
  });

  it("cannot be revoked once the project has started", async () => {
    const { jobId } = await startedJob();
    await expect(db.query("select * from revoke_approval($1)", [jobId])).rejects.toThrow(/before the project starts/);
  });

  it("a contract needs an approved job", async () => {
    const jobId = await newJob();
    await expect(db.query("select * from create_document($1, 'contract', '{}'::jsonb)", [jobId])).rejects.toThrow(/approved quotation/);
    const { jobId: approved } = await approvedJob();
    expect((await one<{ kind: string }>("select * from create_document($1, 'contract', '{}'::jsonb)", [approved])).kind).toBe("contract");
  });
});

describe("start project", () => {
  it("records the advance, creates the task list and starts the job, once", async () => {
    const { jobId } = await approvedJob();
    const result = await one<{ start_project: any }>("select start_project($1, 16000, 'k1', 'bank_transfer', current_date, '') as start_project", [jobId]);
    expect(result.start_project).toMatchObject({ already_started: false, tasks: 3, amount: 16_000 });
    expect(await one("select stage, started_at is not null as started from jobs where id = $1", [jobId])).toEqual({ stage: "active", started: true });
    expect(await rows("select title from job_tasks where job_id = $1 order by position", [jobId])).toHaveLength(3);
    expect(await rows("select amount::float as amount, category, is_start_advance from ledger_entries where job_id = $1", [jobId])).toEqual([{ amount: 16_000, category: "advance", is_start_advance: true }]);
  });

  it("repeated and concurrent calls create one payment and one task list", async () => {
    const { jobId } = await approvedJob();
    const calls = await Promise.all([1, 2, 3, 4, 5].map((index) => db.query<{ start_project: any }>("select start_project($1, 16000, $2) as start_project", [jobId, index % 2 ? "same-key" : "other-key"])));
    expect(calls.filter((call) => call.rows[0].start_project.already_started === false)).toHaveLength(1);
    expect(await rows("select id from ledger_entries where job_id = $1", [jobId])).toHaveLength(1);
    expect(await rows("select id from job_tasks where job_id = $1", [jobId])).toHaveLength(3);
  });

  it("rejects an advance below the required one and leaves nothing behind", async () => {
    const { jobId } = await approvedJob();
    await expect(db.query("select start_project($1, 15999.99, 'low')", [jobId])).rejects.toThrow(/at least the required advance/);
    expect(await stage(jobId)).toBe("approved");
    expect(await rows("select id from ledger_entries where job_id = $1", [jobId])).toEqual([]);
    expect(await rows("select id from job_tasks where job_id = $1", [jobId])).toEqual([]);
    await db.query("select start_project($1, 16000.00, 'exact')", [jobId]); // exactly the required advance is enough
  });

  it("accepts more than the required advance, and refuses a job that is not approved", async () => {
    const { jobId } = await approvedJob();
    await db.query("select start_project($1, 40000, 'all-at-once')", [jobId]);
    expect(await one("select amount::float as amount from ledger_entries where job_id = $1", [jobId])).toEqual({ amount: 40_000 });
    const lead = await newJob();
    await expect(db.query("select start_project($1, 1, 'k')", [lead])).rejects.toThrow(/approved stage/);
  });

  it("a failure part-way through keeps no payment, no tasks and no stage change", async () => {
    const { jobId } = await approvedJob();
    await db.exec("create function fail_task_insert() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$; create trigger fail_task_insert before insert on job_tasks for each row execute function fail_task_insert();");
    try {
      await expect(db.query("select start_project($1, 16000, 'half')", [jobId])).rejects.toThrow(/boom/);
    } finally { await db.exec("drop trigger fail_task_insert on job_tasks; drop function fail_task_insert();"); }
    expect(await stage(jobId)).toBe("approved");
    expect(await rows("select id from ledger_entries where job_id = $1", [jobId])).toEqual([]);
    await db.query("select start_project($1, 16000, 'retry')", [jobId]);
    expect(await stage(jobId)).toBe("active");
  });

  it("is the only way money gets onto a job that is still approved", async () => {
    const { jobId } = await approvedJob();
    await expect(db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'advance', 16000)", [jobId])).rejects.toThrow(/has not started/);
  });
});

describe("ledger rules", () => {
  it("income always has a job", async () => {
    await expect(db.query("insert into ledger_entries (type, category, amount) values ('income', 'advance', 100)")).rejects.toThrow(/ledger_income_has_job/);
  });

  it("refuses any entry for a job that has not started, income or expense", async () => {
    const lead = await newJob();
    const { jobId: approved } = await approvedJob();
    for (const jobId of [lead, approved]) {
      await expect(db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', 100)", [jobId])).rejects.toThrow(/has not started/);
      await expect(db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'expense', 'hosting', 100)", [jobId])).rejects.toThrow(/has not started/);
    }
  });

  it("accepts company expenses with no job, and entries for a started job", async () => {
    await db.query("insert into ledger_entries (type, category, amount, note) values ('expense', 'internet', 4500, 'monthly')");
    const { jobId } = await startedJob();
    await db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'expense', 'hosting', 9000)", [jobId]);
    await db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', 24000)", [jobId]);
  });

  it("rejects non-positive amounts, unknown methods and unknown income categories", async () => {
    const { jobId } = await startedJob();
    await expect(db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', 0)", [jobId])).rejects.toThrow();
    await expect(db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', -5)", [jobId])).rejects.toThrow();
    await expect(db.query("insert into ledger_entries (job_id, type, category, amount, method) values ($1, 'income', 'final', 5, 'crypto')", [jobId])).rejects.toThrow();
    await expect(db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'gift', 5)", [jobId])).rejects.toThrow(/ledger_income_category/);
  });

  it("is never deleted or truncated", async () => {
    await db.query("insert into ledger_entries (type, category, amount) values ('expense', 'other', 1)");
    await expect(db.query("delete from ledger_entries")).rejects.toThrow(/never deleted/);
    await expect(db.query("truncate ledger_entries")).rejects.toThrow(/never deleted|cannot truncate/); // refused twice over: by the trigger and by the foreign keys that point at it
  });

  it("voids with a reason, keeps the row, and a voided entry can no longer change", async () => {
    const entry = await one<{ id: string }>("insert into ledger_entries (type, category, amount) values ('expense', 'other', 10) returning id");
    await expect(db.query("select * from void_ledger_entry($1, '  ')", [entry.id])).rejects.toThrow(/reason is required/);
    await expect(db.query("update ledger_entries set voided_at = now() where id = $1", [entry.id])).rejects.toThrow(/ledger_void_has_reason/);
    await db.query("select * from void_ledger_entry($1, 'typed the wrong amount')", [entry.id]);
    expect(await one("select voided_reason from ledger_entries where id = $1", [entry.id])).toEqual({ voided_reason: "typed the wrong amount" });
    await expect(db.query("update ledger_entries set amount = 11 where id = $1", [entry.id])).rejects.toThrow(/voided/);
    await expect(db.query("select * from void_ledger_entry($1, 'again')", [entry.id])).rejects.toThrow(/already void/);
  });

  it("only a voided entry can be replaced", async () => {
    const entry = await one<{ id: string }>("insert into ledger_entries (type, category, amount) values ('expense', 'other', 10) returning id");
    await expect(db.query("insert into ledger_entries (type, category, amount, replaces_entry_id) values ('expense', 'other', 12, $1)", [entry.id])).rejects.toThrow(/only a voided entry/);
    await db.query("select * from void_ledger_entry($1, 'wrong')", [entry.id]);
    await db.query("insert into ledger_entries (type, category, amount, replaces_entry_id) values ('expense', 'other', 12, $1)", [entry.id]);
  });

  it("an entry with a receipt keeps its amount, date, job and type; only the note can change", async () => {
    const { jobId } = await startedJob();
    const entry = await one<{ id: string }>("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', 24000) returning id", [jobId]);
    const receipt = await one<{ id: string }>("select * from create_document($1, 'receipt', '{}'::jsonb, $2)", [jobId, entry.id]);
    await expect(db.query("update ledger_entries set amount = 25000 where id = $1", [entry.id])).rejects.toThrow(/has a receipt/);
    await expect(db.query("update ledger_entries set entry_date = '2020-01-01' where id = $1", [entry.id])).rejects.toThrow(/has a receipt/);
    await expect(db.query("update ledger_entries set type = 'expense' where id = $1", [entry.id])).rejects.toThrow();
    await db.query("update ledger_entries set note = 'paid by cheque' where id = $1", [entry.id]);
    await expect(db.query("update documents set payload = '{\"amount\":1}'::jsonb where id = $1", [receipt.id])).rejects.toThrow(/snapshot/);
    await expect(db.query("delete from ledger_entries where id = $1", [entry.id])).rejects.toThrow();
  });

  it("voiding an entry marks its receipt void and keeps it", async () => {
    const { jobId } = await startedJob();
    const entry = await one<{ id: string }>("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', 24000) returning id", [jobId]);
    const receipt = await one<{ id: string }>("select * from create_document($1, 'receipt', '{}'::jsonb, $2)", [jobId, entry.id]);
    await db.query("select * from void_ledger_entry($1, 'bank reversed it')", [entry.id]);
    expect(await one("select status, voided_at is not null as voided from documents where id = $1", [receipt.id])).toEqual({ status: "void", voided: true });
    await expect(db.query("update documents set status = 'sent' where id = $1", [receipt.id])).rejects.toThrow(/stays void/);
  });

  it("a receipt needs a live income entry of the same job, once", async () => {
    const { jobId } = await startedJob();
    const { jobId: other } = await startedJob();
    const expense = await one<{ id: string }>("insert into ledger_entries (job_id, type, category, amount) values ($1, 'expense', 'hosting', 100) returning id", [jobId]);
    const income = await one<{ id: string }>("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', 100) returning id", [jobId]);
    await expect(db.query("select * from create_document($1, 'receipt', '{}'::jsonb, $2)", [jobId, expense.id])).rejects.toThrow(/live income entry/);
    await expect(db.query("select * from create_document($1, 'receipt', '{}'::jsonb, $2)", [other, income.id])).rejects.toThrow(/live income entry/);
    await expect(db.query("select * from create_document($1, 'receipt', '{}'::jsonb)", [jobId])).rejects.toThrow();
    await db.query("select * from create_document($1, 'receipt', '{}'::jsonb, $2)", [jobId, income.id]);
    await expect(db.query("select * from create_document($1, 'receipt', '{}'::jsonb, $2)", [jobId, income.id])).rejects.toThrow(/documents_one_receipt_per_entry/);
  });

  it("an invoice needs no ledger entry", async () => {
    const { jobId } = await approvedJob();
    const invoice = await one<{ kind: string; ledger_entry_id: string | null }>("select * from create_document($1, 'invoice', $2::jsonb)", [jobId, JSON.stringify({ total: 16000 })]);
    expect(invoice).toMatchObject({ kind: "invoice", ledger_entry_id: null });
    expect(await rows("select id from ledger_entries where job_id = $1", [jobId])).toEqual([]);
  });
});

describe("delivery, closing and lost jobs", () => {
  it("delivering creates the default renewals one year on", async () => {
    const { jobId } = await startedJob();
    await db.query("select * from mark_delivered($1)", [jobId]);
    const renewals = await rows<{ kind: string; due: string }>("select kind, (due_date - (now() at time zone 'Asia/Colombo')::date) as due from renewals where job_id = $1 order by kind", [jobId]);
    expect(renewals.map((row) => row.kind)).toEqual(["domain", "hosting", "support"]);
    expect(renewals.every((row) => Number(row.due) >= 365 && Number(row.due) <= 366)).toBe(true);
    await expect(db.query("select * from mark_delivered($1)", [jobId])).rejects.toThrow(/only an active job/);
  });

  it("closing needs the balance to be zero", async () => {
    const { jobId } = await startedJob();
    await db.query("select * from mark_delivered($1)", [jobId]);
    await expect(db.query("select * from close_job($1)", [jobId])).rejects.toThrow(/outstanding balance/);
    await db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', 24000)", [jobId]);
    expect((await one<{ stage: string }>("select * from close_job($1)", [jobId])).stage).toBe("closed");
  });

  it("an extra or renewal payment does not settle the project balance", async () => {
    const { jobId } = await startedJob();
    await db.query("select * from mark_delivered($1)", [jobId]);
    await db.query("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'extra', 24000), ($1, 'income', 'renewal', 24000)", [jobId]);
    await expect(db.query("select * from close_job($1)", [jobId])).rejects.toThrow(/outstanding balance/);
  });

  it("a voided payment no longer counts towards the balance", async () => {
    const { jobId } = await startedJob();
    await db.query("select * from mark_delivered($1)", [jobId]);
    const final = await one<{ id: string }>("insert into ledger_entries (job_id, type, category, amount) values ($1, 'income', 'final', 24000) returning id", [jobId]);
    await db.query("select * from void_ledger_entry($1, 'bounced')", [final.id]);
    await expect(db.query("select * from close_job($1)", [jobId])).rejects.toThrow(/outstanding balance/);
  });

  it("a lost job reopens at the stage it was lost from, and a started job cannot be lost", async () => {
    const jobId = await newJob();
    await sentQuotation(jobId);
    await db.query("select * from mark_lost($1, 'went with someone cheaper')", [jobId]);
    expect(await one("select stage, lost_from_stage, lost_reason from jobs where id = $1", [jobId])).toEqual({ stage: "lost", lost_from_stage: "quoted", lost_reason: "went with someone cheaper" });
    await expect(db.query("select * from create_document($1, 'invoice', '{}'::jsonb)", [jobId])).rejects.toThrow(/lost job/);
    await db.query("select * from reopen_job($1)", [jobId]);
    expect(await one("select stage, lost_from_stage from jobs where id = $1", [jobId])).toEqual({ stage: "quoted", lost_from_stage: null });
    const { jobId: started } = await startedJob();
    await expect(db.query("select * from mark_lost($1, 'x')", [started])).rejects.toThrow(/before it starts/);
    await expect(db.query("select * from reopen_job($1)", [started])).rejects.toThrow(/only a lost job/);
  });

  it("a lost approved job reopens still approved, with its price", async () => {
    const { jobId } = await approvedJob();
    await db.query("select * from mark_lost($1, 'paused')", [jobId]);
    await db.query("select * from reopen_job($1)", [jobId]);
    expect(await one("select stage, price_total::float as price from jobs where id = $1", [jobId])).toEqual({ stage: "approved", price: 40_000 });
  });
});

describe("reminder log", () => {
  const claim = async (key: string, minutes = 15) => (await one<{ claim_reminder: boolean }>("select claim_reminder($1, 'quotation', gen_random_uuid(), $2) as claim_reminder", [key, minutes])).claim_reminder;
  const finish = (key: string, ok: boolean, error?: string) => db.query("select finish_reminder($1, $2, $3)", [key, ok, error ?? null]);

  it("gives a reminder to exactly one claimer", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => claim("quotation:a:2026-10-01")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("never claims a reminder that was sent", async () => {
    await claim("quotation:b:2026-10-01");
    await finish("quotation:b:2026-10-01", true);
    expect(await claim("quotation:b:2026-10-01")).toBe(false);
    expect(await claim("quotation:b:2026-10-01", 0)).toBe(false);
  });

  it("retries a failure after its backoff, three times at most", async () => {
    const key = "balance:c:2026-10-01";
    expect(await claim(key)).toBe(true);
    await finish(key, false, "WhatsApp is down");
    expect(await claim(key)).toBe(false); // still backing off
    await db.query("update reminder_log set next_attempt_at = now() - interval '1 minute' where reminder_key = $1", [key]);
    expect(await claim(key)).toBe(true);
    await finish(key, false, "still down");
    await db.query("update reminder_log set next_attempt_at = now() - interval '1 minute' where reminder_key = $1", [key]);
    expect(await claim(key)).toBe(true);
    await finish(key, false, "still down");
    await db.query("update reminder_log set next_attempt_at = now() - interval '1 minute' where reminder_key = $1", [key]);
    expect(await claim(key)).toBe(false); // three attempts used
    expect(await one("select status, attempts from reminder_log where reminder_key = $1", [key])).toEqual({ status: "failed", attempts: 3 });
  });

  it("takes over a claim whose owner vanished, but not a fresh one", async () => {
    const key = "renewal:d:2026-10-01:30d";
    expect(await claim(key)).toBe(true);
    expect(await claim(key)).toBe(false);
    await db.query("update reminder_log set updated_at = now() - interval '20 minutes' where reminder_key = $1", [key]);
    expect(await claim(key)).toBe(true);
  });
});
