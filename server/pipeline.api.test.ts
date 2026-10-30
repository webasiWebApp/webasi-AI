import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgSupabase } from "./test-utils/pg-supabase";

// Every workflow move through the tRPC API, on a real Postgres (PGlite) running the project's migrations. A refusal
// the database or the stage function would make has to show up here as the same error the dashboard would see.
const holder = vi.hoisted(() => ({ db: null as unknown as PgSupabase }));
vi.mock("./_core/supabase", () => ({ getSupabaseServer: () => holder.db, checkSupabaseConnection: async () => ({ ok: true }) }));

type Caller = ReturnType<typeof import("./routers").appRouter.createCaller>;
let api: Caller;

let shared: PgSupabase | null = null;

beforeEach(async () => {
  vi.resetModules();
  // One database for the file, emptied between tests: building a fresh one costs seconds each time.
  if (!shared) shared = await (await import("./test-utils/pg-supabase")).createPgSupabase();
  await shared.reset();
  holder.db = shared;
  const { ENV } = await import("./_core/env");
  ENV.supabaseUrl = "http://supabase.test";
  ENV.supabaseServiceRoleKey = "test-service-role";
  const { appRouter } = await import("./routers");
  api = appRouter.createCaller({} as never);
  await api.dashboard.settings(); // creates the settings row, which numbers the documents
}, 60_000);

const item = (cost = 40_000) => ({ description: "Website Design & Development", bullets: ["Responsive design", "Basic SEO Setup"], cost });
const quotation = (cost = 40_000, extra: Record<string, unknown> = {}) => ({ clientName: "Prablo 360", projectName: "chandranath & company", intro: "The website will include all sections requested in the RFQ.", items: [item(cost)], ...extra });
const code = async (promise: Promise<unknown>) => promise.then(() => "ok", (error) => (error as { code: string }).code);
const events = async () => (await holder.db.pg.query<{ event_type: string; title: string; detail: string }>("select event_type, title, detail from event_log order by created_at, id")).rows;

async function newJob(extra: Record<string, unknown> = {}) {
  return api.jobs.create({ clientName: "Prablo 360", clientPhone: "+94770000000", title: "Company website", ...extra });
}
async function quotedJob(cost = 40_000) {
  const job = await newJob();
  const doc = await api.documents.createQuotation({ jobId: job.id, quotation: quotation(cost) });
  return { job, doc };
}
async function approvedJob(cost = 40_000) {
  const { job, doc } = await quotedJob(cost);
  await api.documents.markSent({ id: doc.id });
  const approved = await api.jobs.approveQuotation({ quotationId: doc.id });
  return { job: approved, doc };
}
async function startedJob(cost = 40_000) {
  const { job, doc } = await approvedJob(cost);
  await api.jobs.startProject({ jobId: job.id, amount: cost * 0.4, idempotencyKey: `start-${job.id}` });
  return { job: (await api.jobs.get({ id: job.id }))!, doc };
}

describe("the main path, step by step", () => {
  it("takes a job from lead to closed through the gated buttons", async () => {
    const job = await newJob();
    expect(job.stage).toBe("lead");

    const meeting = await api.meetings.create({ jobId: job.id, title: "Intro call", startsAt: "2026-11-02T04:00:00.000Z", endsAt: "2026-11-02T04:30:00.000Z" });
    expect(meeting.syncStatus).toBe("not_configured");
    expect((await api.jobs.get({ id: job.id }))!.stage).toBe("meeting");

    const doc = await api.documents.createQuotation({ jobId: job.id, quotation: quotation() });
    expect(doc).toMatchObject({ kind: "quotation", status: "draft", number: "09248" });
    expect(doc.payload).toMatchObject({ subtotal: 40_000, total: 40_000, advancePercent: 40 });
    expect((await api.jobs.get({ id: job.id }))!.stage).toBe("quoted");

    await api.documents.markSent({ id: doc.id });
    const approved = await api.jobs.approveQuotation({ quotationId: doc.id });
    expect(approved).toMatchObject({ stage: "approved", priceTotal: 40_000, advancePercent: 40, requiredAdvance: 16_000, approvedQuotationId: doc.id });

    const started = await api.jobs.startProject({ jobId: job.id, amount: 16_000, idempotencyKey: "start-main-path" });
    expect(started).toMatchObject({ alreadyStarted: false, tasks: 16, amount: 16_000 });
    expect(started.job.stage).toBe("active");

    const tasks = await api.tasks.list({ jobId: job.id });
    expect(tasks.map((task) => task.title)[0]).toBe("Requirement gathering (finalise SRS)");
    await api.tasks.update({ id: tasks[0].id, status: "done" });

    const delivered = await api.jobs.markDelivered({ jobId: job.id });
    expect(delivered.job.stage).toBe("delivered");
    expect(delivered.warnings[0]).toMatch(/15 tasks are not finished/);
    expect(await api.renewals.list({ jobId: job.id })).toHaveLength(3);

    expect(await code(api.jobs.close({ jobId: job.id }))).toBe("PRECONDITION_FAILED");
    const payment = await api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 24_000 });
    const receipt = await api.documents.createReceipt({ ledgerEntryId: payment.id });
    expect(receipt.payload).toMatchObject({ amount: 24_000, balanceAfter: 0, category: "final" });
    expect((await api.jobs.close({ jobId: job.id })).stage).toBe("closed");

    const titles = (await events()).map((event) => event.title);
    expect(titles).toEqual(expect.arrayContaining(["Job created", "Job moved to meeting", "Quotation approved", "Project started", "Job delivered", "Job closed"]));
  });
});

describe("gates the API enforces", () => {
  it("refuses to jump over a stage", async () => {
    const job = await newJob();
    expect(await code(api.jobs.startProject({ jobId: job.id, amount: 16_000, idempotencyKey: "skip-ahead-1" }))).toBe("PRECONDITION_FAILED");
    expect(await code(api.jobs.markDelivered({ jobId: job.id }))).toBe("PRECONDITION_FAILED");
    expect(await code(api.jobs.close({ jobId: job.id }))).toBe("PRECONDITION_FAILED");
    expect(await code(api.documents.createContract({ jobId: job.id, contract: {} }))).toBe("PRECONDITION_FAILED");
    expect((await api.jobs.get({ id: job.id }))!.stage).toBe("lead");
  });

  it("only a sent quotation can be approved", async () => {
    const { doc } = await quotedJob();
    const error = await api.jobs.approveQuotation({ quotationId: doc.id }).catch((e) => e);
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.message).toMatch(/marked as sent/);
  });

  it("refuses to start the project for less than the full agreed advance", async () => {
    const { job } = await approvedJob();
    const error = await api.jobs.startProject({ jobId: job.id, amount: 15_999, idempotencyKey: "too-little-1" }).catch((e) => e);
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.message).toMatch(/full agreed advance/);
    expect((await api.jobs.get({ id: job.id }))!.stage).toBe("approved");
    expect(await api.ledger.list({ jobId: job.id })).toEqual([]);
  });

  it("start project twice makes one payment and one task list", async () => {
    const { job } = await approvedJob();
    const first = await api.jobs.startProject({ jobId: job.id, amount: 16_000, idempotencyKey: "double-click-1" });
    const second = await api.jobs.startProject({ jobId: job.id, amount: 16_000, idempotencyKey: "double-click-1" });
    const third = await api.jobs.startProject({ jobId: job.id, amount: 16_000, idempotencyKey: "another-click-2" });
    expect([first.alreadyStarted, second.alreadyStarted, third.alreadyStarted]).toEqual([false, true, true]);
    expect(second.ledgerEntryId).toBe(first.ledgerEntryId);
    expect(await api.ledger.list({ jobId: job.id })).toHaveLength(1);
    expect(await api.tasks.list({ jobId: job.id })).toHaveLength(16);
    const concurrent = await Promise.all([1, 2, 3].map((n) => api.jobs.startProject({ jobId: job.id, amount: 16_000, idempotencyKey: `race-${n}-abcdef` })));
    expect(concurrent.every((result) => result.alreadyStarted)).toBe(true);
  });

  it("proposal and contract pack only exist from the approved stage, from the approved quotation", async () => {
    const { job, doc } = await quotedJob();
    expect(await code(api.documents.createContract({ jobId: job.id, contract: {} }))).toBe("PRECONDITION_FAILED");
    await api.documents.markSent({ id: doc.id });
    await api.jobs.approveQuotation({ quotationId: doc.id });
    const contract = await api.documents.createContract({ jobId: job.id, contract: { startDate: "2026-11-03" } });
    expect(contract.payload).toMatchObject({ clientName: "Prablo 360", projectName: "chandranath & company", startDate: "2026-11-03" });
    expect(contract.payload.scope[0]).toBe("Website Design & Development");
    // The price and the payment split are not contract fields at all.
    expect(contract.payload).not.toHaveProperty("price");
    expect(contract.payload).not.toHaveProperty("advancePercent");
    const smuggled = await api.documents.updateContract({ id: contract.id, contract: { price: 1, advancePercent: 50, clientName: "Someone else" } as never });
    expect(smuggled.payload).not.toHaveProperty("price");
    expect(smuggled.payload).not.toHaveProperty("advancePercent");
    expect(smuggled.payload.clientName).toBe("Prablo 360");
  });

  it("a lost job reopens to the stage it was lost from, and a started job cannot be lost", async () => {
    const { job } = await quotedJob();
    const lost = await api.jobs.markLost({ jobId: job.id, reason: "chose another agency" });
    expect(lost).toMatchObject({ stage: "lost", lostFromStage: "quoted", lostReason: "chose another agency" });
    expect(await code(api.meetings.create({ jobId: job.id, title: "x", startsAt: "2026-11-02T04:00:00.000Z", endsAt: "2026-11-02T05:00:00.000Z" }))).toBe("PRECONDITION_FAILED");
    expect((await api.jobs.reopen({ jobId: job.id })).stage).toBe("quoted");
    const { job: started } = await startedJob();
    expect(await code(api.jobs.markLost({ jobId: started.id, reason: "x" }))).toBe("PRECONDITION_FAILED");
  });

  it("rejects bad input as a bad request", async () => {
    expect(await code(api.jobs.create({ clientName: "", title: "x" }))).toBe("BAD_REQUEST");
    const job = await newJob();
    expect(await code(api.documents.createQuotation({ jobId: job.id, quotation: quotation(0) }))).toBe("BAD_REQUEST");
    expect(await code(api.meetings.create({ jobId: job.id, title: "x", startsAt: "2026-11-02T05:00:00.000Z", endsAt: "2026-11-02T04:00:00.000Z" }))).toBe("BAD_REQUEST");
    expect(await code(api.jobs.get({ id: "not-an-id" }))).toBe("BAD_REQUEST");
    expect(await code(api.jobs.get({ id: "11111111-1111-4111-8111-111111111111" }))).toBe("NOT_FOUND");
  });
});

describe("quotations", () => {
  it("approving one quotation settles the price from it and supersedes the others", async () => {
    const job = await newJob();
    const a = await api.documents.createQuotation({ jobId: job.id, quotation: quotation(50_000) });
    const b = await api.documents.createQuotation({ jobId: job.id, quotation: quotation(40_000, { advancePercent: 25 }) });
    await api.documents.markSent({ id: a.id });
    await api.documents.markSent({ id: b.id });
    const approved = await api.jobs.approveQuotation({ quotationId: b.id });
    expect(approved).toMatchObject({ priceTotal: 40_000, advancePercent: 25, requiredAdvance: 10_000 });
    const statuses = Object.fromEntries((await api.documents.list({ jobId: job.id })).map((doc) => [doc.id, doc.status]));
    expect(statuses).toEqual({ [a.id]: "superseded", [b.id]: "approved" });
  });

  it("an approved quotation is read-only until the approval is revoked, which restores the others", async () => {
    const job = await newJob();
    const a = await api.documents.createQuotation({ jobId: job.id, quotation: quotation(50_000) });
    const b = await api.documents.createQuotation({ jobId: job.id, quotation: quotation(40_000) });
    await api.documents.markSent({ id: a.id });
    await api.documents.markSent({ id: b.id });
    await api.jobs.approveQuotation({ quotationId: b.id });
    expect(await code(api.documents.updateQuotation({ id: b.id, quotation: quotation(41_000) }))).toBe("PRECONDITION_FAILED");
    const revoked = await api.jobs.revokeApproval({ jobId: job.id });
    expect(revoked).toMatchObject({ stage: "quoted", approvedQuotationId: null, priceTotal: null });
    expect(Object.fromEntries((await api.documents.list({ jobId: job.id })).map((doc) => [doc.id, doc.status]))).toEqual({ [a.id]: "sent", [b.id]: "sent" });
    await api.documents.updateQuotation({ id: b.id, quotation: quotation(41_000) });
    expect((await events()).map((event) => event.title)).toContain("Approval revoked");
  });

  it("cannot revoke an approval once the project has started", async () => {
    const { job } = await startedJob();
    expect(await code(api.jobs.revokeApproval({ jobId: job.id }))).toBe("PRECONDITION_FAILED");
  });

  it("editing or regenerating a sent quotation keeps its number, status and sent date", async () => {
    const { doc } = await quotedJob();
    const sent = await api.documents.markSent({ id: doc.id });
    const edited = await api.documents.updateQuotation({ id: doc.id, quotation: quotation(45_000) });
    expect(edited).toMatchObject({ number: doc.number, status: "sent", sentAt: sent.sentAt });
    expect(edited.payload.total).toBe(45_000);
    const again = await api.documents.updateQuotation({ id: doc.id, quotation: quotation(45_000) });
    expect(again.sentAt).toBe(sent.sentAt);
  });

  it("marking as sent twice needs 'mark as sent again', which moves the date and logs the old one", async () => {
    const { doc } = await quotedJob();
    const first = await api.documents.markSent({ id: doc.id });
    expect(await code(api.documents.markSent({ id: doc.id }))).toBe("PRECONDITION_FAILED");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await api.documents.markSent({ id: doc.id, again: true });
    expect(second.sentAt).not.toBe(first.sentAt);
    expect((await events()).find((event) => event.detail.includes("Marked as sent again"))!.detail).toContain(first.sentAt!);
    const draft = await api.documents.duplicateQuotation({ id: doc.id });
    expect(await code(api.documents.markSent({ id: draft.id, again: true }))).toBe("PRECONDITION_FAILED");
  });

  it("'duplicate as new' makes a new draft with a new number", async () => {
    const { doc } = await quotedJob();
    const copy = await api.documents.duplicateQuotation({ id: doc.id });
    expect(copy).toMatchObject({ status: "draft", sentAt: null });
    expect(copy.number).not.toBe(doc.number);
    expect(copy.payload.items).toEqual(doc.payload.items);
  });

  it("builds the payment terms and totals on the server", async () => {
    const job = await newJob();
    const doc = await api.documents.createQuotation({ jobId: job.id, quotation: { ...quotation(0), items: [{ description: "A", bullets: [], cost: 10.1 }, { description: "B", bullets: [], cost: 20.2 }], advancePercent: 40 } });
    expect(doc.payload).toMatchObject({ subtotal: 30.3, total: 30.3, advancePercent: 40 });
    expect(doc.payload.infrastructure[0]).toEqual({ label: "Technology", text: "Next js" });
    expect(doc.payload.dueDate > doc.payload.date).toBe(true);
  });

  it("numbers all document kinds from one sequence", async () => {
    const { job, doc } = await approvedJob();
    const invoice = await api.documents.createInvoice({ jobId: job.id, basis: "advance" });
    const contract = await api.documents.createContract({ jobId: job.id, contract: {} });
    expect([doc.number, invoice.number, contract.number]).toEqual(["09248", "09249", "09250"]);
    expect(invoice.payload).toMatchObject({ basis: "advance", total: 16_000 });
    expect(await api.ledger.list({ jobId: job.id })).toEqual([]); // an invoice asks for money; nothing has been paid
  });
});

describe("ledger rules through the API", () => {
  it("refuses money for a job that has not started, and accepts a company expense", async () => {
    const { job } = await approvedJob();
    expect(await code(api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 100 }))).toBe("PRECONDITION_FAILED");
    expect(await code(api.ledger.recordExpense({ jobId: job.id, category: "hosting", amount: 100 }))).toBe("PRECONDITION_FAILED");
    expect((await api.ledger.recordExpense({ category: "internet", amount: 4_500 })).jobId).toBeNull();
    expect(await code(api.ledger.recordExpense({ category: "not-a-category", amount: 10 }))).toBe("BAD_REQUEST");
  });

  it("a payment with a receipt can only be voided, never rewritten, and its receipt goes void", async () => {
    const { job } = await startedJob();
    const payment = await api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 10_000 });
    const receipt = await api.documents.createReceipt({ ledgerEntryId: payment.id });
    expect((await api.documents.createReceipt({ ledgerEntryId: payment.id })).id).toBe(receipt.id);
    expect(await code(api.ledger.correct({ id: payment.id, amount: 12_000 }))).toBe("PRECONDITION_FAILED");
    expect((await api.ledger.updateNote({ id: payment.id, note: "cheque no. 123" })).note).toBe("cheque no. 123");
    expect(await code(api.ledger.void({ id: payment.id, reason: "x" }))).toBe("BAD_REQUEST"); // too short a reason
    await api.ledger.void({ id: payment.id, reason: "bank reversed the transfer" });
    expect((await api.documents.get({ id: receipt.id })).status).toBe("void");
    expect(await code(api.documents.createReceipt({ ledgerEntryId: payment.id }))).toBe("PRECONDITION_FAILED");
    const voided = (await api.ledger.list({ jobId: job.id, includeVoid: true })).find((entry) => entry.id === payment.id)!;
    expect(voided.voidedReason).toBe("bank reversed the transfer");
    expect((await api.ledger.list({ jobId: job.id })).map((entry) => entry.id)).not.toContain(payment.id);
  });

  it("a receipt cannot be made for an expense", async () => {
    const { job } = await startedJob();
    const expense = await api.ledger.recordExpense({ jobId: job.id, category: "hosting", amount: 9_000 });
    expect(await code(api.documents.createReceipt({ ledgerEntryId: expense.id }))).toBe("PRECONDITION_FAILED");
  });

  it("an invoice for the balance reads the outstanding amount and creates no entry", async () => {
    const { job } = await startedJob();
    await api.jobs.markDelivered({ jobId: job.id });
    const invoice = await api.documents.createInvoice({ jobId: job.id, basis: "balance" });
    expect(invoice.payload.total).toBe(24_000);
    expect(await api.ledger.list({ jobId: job.id })).toHaveLength(1);
    await api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 24_000, invoiceDocumentId: invoice.id });
    expect(await code(api.documents.createInvoice({ jobId: job.id, basis: "balance" }))).toBe("PRECONDITION_FAILED");
  });
});

describe("finance", () => {
  it("counts each kind of entry once and only once", async () => {
    const { job } = await startedJob(100_000); // advance 40,000 recorded by Start project
    await api.jobs.markDelivered({ jobId: job.id });
    await api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 50_000 });
    await api.ledger.recordPayment({ jobId: job.id, category: "extra", amount: 5_000 });
    await api.ledger.recordPayment({ jobId: job.id, category: "renewal", amount: 7_000 });
    await api.ledger.recordExpense({ jobId: job.id, category: "hosting", amount: 9_000 });
    await api.ledger.recordExpense({ category: "internet", amount: 4_000 });
    const voided = await api.ledger.recordExpense({ category: "ads", amount: 99_999 });
    await api.ledger.void({ id: voided.id, reason: "typo, entered twice" });

    const { summary } = await api.finance.overview({});
    expect(summary).toMatchObject({ income: 102_000, projectCosts: 9_000, companyCosts: 4_000, companyProfit: 89_000, receivables: 10_000 });
    const row = summary.perJob.find((entry) => entry.jobId === job.id)!;
    expect(row).toMatchObject({ price: 100_000, received: 102_000, outstanding: 10_000, costs: 9_000, profit: 93_000 });
    const detail = (await api.jobs.get({ id: job.id }))!;
    expect(detail.money).toMatchObject({ received: 102_000, paidTowardPrice: 90_000, outstanding: 10_000, costs: 9_000, profit: 93_000 });
  });

  it("filters by month and exports the ledger as CSV", async () => {
    const { job } = await startedJob();
    await api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 1_000, entryDate: "2026-09-15", note: "=HYPERLINK(\"x\")" });
    const september = await api.finance.overview({ month: "2026-09" });
    expect(september.summary.income).toBe(1_000);
    expect(september.entries).toHaveLength(1);
    const { ledgerExport } = await import("./data/finance");
    const csv = await ledgerExport("2026-09");
    expect(csv.split("\r\n")[0]).toBe('"date","type","category","amount_lkr","job","method","note","status","void_reason"');
    expect(csv).toContain("\"'=HYPERLINK(");
  });

  it("works with nothing in it", async () => {
    expect((await api.finance.overview({})).summary).toMatchObject({ income: 0, companyProfit: 0, receivables: 0 });
  });
});

describe("renewals", () => {
  it("renewal income is allowed, is not project income, and marks the renewal paid", async () => {
    const { job } = await startedJob();
    await api.jobs.markDelivered({ jobId: job.id });
    const [hosting] = await api.renewals.list({ jobId: job.id });
    expect(await code(api.renewals.createInvoice({ id: hosting.id }))).toBe("PRECONDITION_FAILED"); // no amount yet
    await api.renewals.update({ id: hosting.id, amount: 12_000 });
    const invoice = await api.renewals.createInvoice({ id: hosting.id });
    expect(invoice).toMatchObject({ kind: "renewal_invoice" });
    expect((await api.renewals.list({ jobId: job.id })).find((row) => row.id === hosting.id)!.status).toBe("invoiced");
    expect((await api.finance.overview({})).summary.renewalReceivables).toBe(12_000);
    const paid = await api.renewals.recordPayment({ id: hosting.id });
    expect(paid.entry).toMatchObject({ category: "renewal", amount: 12_000, type: "income" });
    expect((await api.jobs.get({ id: job.id }))!.money.outstanding).toBe(24_000); // unchanged: renewals do not settle the price
    expect((await api.finance.overview({})).summary.renewalReceivables).toBe(0);
  });

  it("skipped renewals stay out of the reminders and cannot be invoiced", async () => {
    const { job } = await startedJob();
    await api.jobs.markDelivered({ jobId: job.id });
    const [renewal] = await api.renewals.list({ jobId: job.id });
    await api.renewals.update({ id: renewal.id, skip: true });
    expect(await code(api.renewals.createInvoice({ id: renewal.id }))).toBe("PRECONDITION_FAILED");
  });
});

describe("tasks", () => {
  it("edits to the template never change jobs that already started", async () => {
    const { job } = await startedJob();
    await api.tasks.saveTemplate({ titles: ["Only one task"] });
    expect(await api.tasks.template()).toHaveLength(1);
    expect(await api.tasks.list({ jobId: job.id })).toHaveLength(16);
    const second = await approvedJob();
    await api.jobs.startProject({ jobId: second.job.id, amount: 16_000, idempotencyKey: "second-job-1" });
    expect((await api.tasks.list({ jobId: second.job.id })).map((task) => task.title)).toEqual(["Only one task"]);
  });

  it("adds, ticks, reorders and removes tasks on one job", async () => {
    const { job } = await startedJob();
    const added = await api.tasks.add({ jobId: job.id, title: "Send invoice reminder", dueDate: "2026-11-10" });
    expect(added.position).toBe(17);
    const done = await api.tasks.update({ id: added.id, status: "done" });
    expect(done.doneAt).not.toBeNull();
    expect((await api.tasks.update({ id: added.id, status: "todo" })).doneAt).toBeNull();
    const before = await api.tasks.list({ jobId: job.id });
    const reordered = await api.tasks.reorder({ jobId: job.id, orderedIds: [added.id, ...before.filter((task) => task.id !== added.id).map((task) => task.id)] });
    expect(reordered[0].id).toBe(added.id);
    await api.tasks.remove({ id: added.id });
    expect(await api.tasks.list({ jobId: job.id })).toHaveLength(16);
  });
});

describe("Today", () => {
  it("lists what is due, who owes what and what is waiting, each row linked to its job", async () => {
    const now = new Date();
    const { job } = await startedJob(); // active: its next unfinished task shows
    const other = await startedJob(50_000);
    await api.jobs.markDelivered({ jobId: other.job.id }); // delivered with 30,000 outstanding
    const waiting = await approvedJob(); // approved, waiting for the advance
    const sentQuote = await quotedJob();
    await api.documents.markSent({ id: sentQuote.doc.id });
    await holder.db.pg.query("update documents set sent_at = now() - interval '5 days' where id = $1", [sentQuote.doc.id]);
    const [task] = await api.tasks.list({ jobId: job.id });
    await api.tasks.update({ id: task.id, dueDate: "2020-01-01" });
    const bookable = await newJob();
    await api.meetings.create({ jobId: bookable.id, title: "Kick-off", startsAt: new Date(now.getTime() + 3_600_000).toISOString(), endsAt: new Date(now.getTime() + 7_200_000).toISOString() });

    const today = await api.today.overview();
    expect(today.meetings.map((meeting) => meeting.title)).toEqual(["Kick-off"]);
    expect(today.tasks.dueOrOverdue.map((row) => row.jobId)).toEqual([job.id]);
    expect(today.tasks.dueOrOverdue[0].overdue).toBe(true);
    expect(today.tasks.next.map((row) => row.jobId).sort()).toEqual([job.id, other.job.id].sort());
    expect(today.moneyToChase.awaitingAdvance).toEqual([expect.objectContaining({ jobId: waiting.job.id, amount: 16_000 })]);
    expect(today.moneyToChase.balances).toEqual([expect.objectContaining({ jobId: other.job.id, amount: 30_000 })]);
    expect(today.quotationsWaiting).toEqual([expect.objectContaining({ jobId: sentQuote.job.id, daysWaiting: 5 })]);
  });

  it("closed and lost jobs never appear", async () => {
    const { job } = await startedJob();
    await api.jobs.markDelivered({ jobId: job.id });
    await api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 24_000 });
    await api.jobs.close({ jobId: job.id });
    const lost = await quotedJob();
    await api.jobs.markLost({ jobId: lost.job.id, reason: "gone" });
    const today = await api.today.overview();
    expect(today.tasks.next).toEqual([]);
    expect(today.moneyToChase.balances).toEqual([]);
  });
});

describe("pending order on the job page", () => {
  it("shows an order waiting at slip_received and leaves the order logic alone", async () => {
    await holder.db.pg.query("insert into conversations (client_id, wa_id) values ('chat-1', '94770000000')");
    const job = await api.jobs.create({ clientName: "Prablo", title: "Site", conversationClientId: "chat-1" });
    expect(await api.jobs.pendingOrder({ jobId: job.id })).toBeNull();
    await holder.db.pg.query("insert into orders (order_key, client_id, wa_id, package_name, deposit_amount, state) values ('WA-1', 'chat-1', '94770000000', 'Site', 16000, 'slip_received')");
    expect(await api.jobs.pendingOrder({ jobId: job.id })).toMatchObject({ orderKey: "WA-1", state: "slip_received" });
    expect((await api.orders.confirm({ orderKey: "WA-1" }))).toBe(true);
    expect(await api.jobs.pendingOrder({ jobId: job.id })).toBeNull();
  });

  it("pre-fills the new job from a conversation", async () => {
    await holder.db.pg.query("insert into conversations (client_id, wa_id, profile_name) values ('chat-2', '94771112222', 'Nimali')");
    expect(await api.jobs.draftFromConversation({ clientId: "chat-2" })).toEqual({ conversationClientId: "chat-2", clientName: "Nimali", clientPhone: "+94771112222" });
    expect(await code(api.jobs.draftFromConversation({ clientId: "nobody" }))).toBe("NOT_FOUND");
  });
});

describe("settings for the module", () => {
  it("keeps the next document number moving forward only, and merges document defaults", async () => {
    await api.settings.update({ nextDocumentNumber: 9300 });
    const job = await newJob();
    expect((await api.documents.createQuotation({ jobId: job.id, quotation: quotation() })).number).toBe("09300");
    await api.settings.update({ nextDocumentNumber: 5 });
    expect((await api.dashboard.settings()).nextDocumentNumber).toBe(9301);
    await api.settings.update({ documentSettings: { portfolioMain: "example.com" }, reminderSettings: { quotationDays: 5 }, expenseCategories: ["rent", "tools"], registrationNo: "REG-1" });
    const settings = await api.dashboard.settings();
    expect(settings).toMatchObject({ registrationNo: "REG-1", reminderSettings: { quotationDays: 5, balanceDays: 3 }, ledgerCategories: { expense: ["rent", "tools"] } });
    expect(settings.documentSettings.portfolioMain).toBe("example.com");
    expect(settings.documentSettings.afterService).toHaveLength(2);
    expect(await code(api.settings.update({ documentSettings: { nonsense: 1 } as never }))).toBe("BAD_REQUEST");
  });

  it("template review notes stay until dismissed", async () => {
    const before = await api.documents.templateReview();
    expect(before).toMatchObject({ dismissed: false });
    expect(before.notes).toHaveLength(3);
    await api.settings.update({ templateReviewDismissed: true });
    expect((await api.documents.templateReview()).dismissed).toBe(true);
  });
});
