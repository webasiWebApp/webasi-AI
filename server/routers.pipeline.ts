import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { PAYMENT_METHODS } from "../shared/finance";
import { router, protectedProcedure } from "./_core/trpc";
import { PipelineError } from "./data/errors";
import { cancelMeeting, completeMeeting, createMeeting, listMeetings, retryMeetingSync, updateMeeting, type Meeting } from "./data/meetings";
import { syncMeetingById } from "./integrations/meeting-sync";
import * as docs from "./data/documents";
import * as jobs from "./data/jobs";
import * as ledger from "./data/ledger";
import * as renewals from "./data/renewals";
import * as tasks from "./data/tasks";
import { financeOverview } from "./data/finance";
import { todayOverview } from "./data/today";
import { listOrders } from "./data/orders";
import { getSettings } from "./data/settings";
import { TEMPLATE_REVIEW_NOTES } from "../shared/documents";

// The data layer refuses with a PipelineError the owner can read; the API turns it into the matching error code.
async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof PipelineError) throw new TRPCError({ code: error.code, message: error.message });
    throw error;
  }
}

// Saving a meeting has already succeeded when this runs. The sync to Google follows, and whatever it does (including
// failing) only changes the meeting's sync status, which the page shows.
const thenSync = async (meeting: Meeting): Promise<Meeting> => (await syncMeetingById(meeting.id).catch(() => null)) ?? meeting;

const id = z.guid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-28.");
const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date and time.");
const money = z.number().finite().min(0).max(1_000_000_000);
const text = (max: number) => z.string().trim().max(max);
const method = z.enum(PAYMENT_METHODS);

const quotationItem = z.object({ description: text(300).min(1), bullets: z.array(text(200)).max(40).default([]), cost: money });
const labelled = z.object({ label: text(100), text: text(500) });
const clause = z.object({ title: text(120), lines: z.array(text(1000)).max(30) });
const quotationInput = z.object({
  clientName: text(180).min(1), projectName: text(180).min(1), intro: text(3000), items: z.array(quotationItem).min(1).max(40), advancePercent: z.number().gt(0).max(100).optional(),
  date: day.optional(), dueDate: day.optional(), infrastructure: z.array(labelled).max(10).optional(), afterService: z.array(text(500)).max(10).optional(), timelineDuration: text(100).optional(),
  milestones: z.array(labelled).max(10).optional(), portfolioMain: text(200).optional(), portfolioLinks: z.array(text(200)).max(12).optional(), footerLinks: z.array(z.object({ label: text(60), url: text(200) })).max(6).optional(),
});
const contractInput = z.object({
  title: text(200).optional(), dateOfDelivery: z.union([day, z.literal("")]).optional(), agreementDate: day.optional(), startDate: day.optional(), completionDate: z.union([day, z.literal("")]).optional(), paymentMethod: text(100).optional(),
  scope: z.array(text(600)).max(80).optional(), receivingParty: text(200).optional(), supportPeriod: text(100).optional(), supportContact: text(200).optional(),
  clauses: z.array(clause).max(20).optional(), ndaClauses: z.array(clause).max(20).optional(), agreementIntro: text(600).optional(), ndaIntro: text(600).optional(), ndaClosing: text(600).optional(),
});

export const documentSettingsPatch = z.object({
  infrastructure: z.array(labelled).max(10), afterService: z.array(text(500)).max(10), timelineDuration: text(100), milestones: z.array(labelled).max(10), portfolioMain: text(200), portfolioLinks: z.array(text(200)).max(12),
  footerLinks: z.array(z.object({ label: text(60), url: text(200) })).max(6), quotationDueDays: z.number().int().min(1).max(365), invoiceDueDays: z.number().int().min(1).max(365), paymentMethodText: text(100), supportPeriod: text(100),
  supportContact: text(200), contractTitle: text(200), receivingParty: text(200), contractClauses: z.array(clause).max(20), ndaClauses: z.array(clause).max(20), ndaIntro: text(600), ndaClosing: text(600), agreementIntro: text(600), warrantyNote: text(600),
}).partial().strict();
export const reminderSettingsPatch = z.object({ quotationEnabled: z.boolean(), quotationDays: z.number().int().min(1).max(60), balanceEnabled: z.boolean(), balanceDays: z.number().int().min(1).max(60), renewalEnabled: z.boolean() }).partial().strict();

export const jobsRouter = router({
  list: protectedProcedure.query(() => jobs.listJobs()),
  get: protectedProcedure.input(z.object({ id })).query(({ input }) => run(async () => (await jobs.getJobDetail(input.id)) ?? Promise.reject(new PipelineError("NOT_FOUND", "That job does not exist.")))),
  draftFromConversation: protectedProcedure.input(z.object({ clientId: text(200).min(1) })).query(({ input }) => run(async () => (await jobs.jobDraftFromConversation(input.clientId)) ?? Promise.reject(new PipelineError("NOT_FOUND", "That conversation does not exist.")))),
  create: protectedProcedure.input(z.object({ clientName: text(180).min(1), clientPhone: text(40).optional(), title: text(180).min(1), conversationClientId: text(200).nullish(), estimatedDeliveryDate: day.nullish(), notes: text(4000).optional() })).mutation(({ input }) => run(() => jobs.createJob(input))),
  update: protectedProcedure.input(z.object({ id, clientName: text(180).min(1).optional(), clientPhone: text(40).optional(), title: text(180).min(1).optional(), estimatedDeliveryDate: day.nullish(), notes: text(4000).optional() })).mutation(({ input: { id: jobId, ...patch } }) => run(() => jobs.updateJob(jobId, patch))),
  approveQuotation: protectedProcedure.input(z.object({ quotationId: id })).mutation(({ input }) => run(() => jobs.approveQuotation(input.quotationId))),
  revokeApproval: protectedProcedure.input(z.object({ jobId: id })).mutation(({ input }) => run(() => jobs.revokeApproval(input.jobId))),
  startProject: protectedProcedure.input(z.object({ jobId: id, amount: money, idempotencyKey: text(100).min(8), method: method.optional(), entryDate: day.optional(), note: text(500).optional() })).mutation(({ input: { jobId, ...rest } }) => run(() => jobs.startProject(jobId, rest))),
  markDelivered: protectedProcedure.input(z.object({ jobId: id })).mutation(({ input }) => run(() => jobs.markDelivered(input.jobId))),
  close: protectedProcedure.input(z.object({ jobId: id })).mutation(({ input }) => run(() => jobs.closeJob(input.jobId))),
  markLost: protectedProcedure.input(z.object({ jobId: id, reason: text(500).default("") })).mutation(({ input }) => run(() => jobs.markLost(input.jobId, input.reason))),
  reopen: protectedProcedure.input(z.object({ jobId: id })).mutation(({ input }) => run(() => jobs.reopenJob(input.jobId))),
  // The order of this job's chat that is waiting for the owner to verify its slip, if any. Confirming it is orders.confirm.
  pendingOrder: protectedProcedure.input(z.object({ jobId: id })).query(({ input }) => run(async () => {
    const job = await jobs.getJob(input.jobId);
    if (!job?.conversationClientId) return null;
    return (await listOrders()).find((order: any) => order.clientId === job.conversationClientId && order.state === "slip_received") ?? null;
  })),
});

export const todayRouter = router({ overview: protectedProcedure.query(() => todayOverview()) });

export const meetingsRouter = router({
  list: protectedProcedure.input(z.object({ jobId: id.optional(), from: instant.optional(), to: instant.optional() }).default({})).query(({ input }) => run(() => listMeetings(input))),
  create: protectedProcedure.input(z.object({ jobId: id, title: text(200).min(1), startsAt: instant, endsAt: instant, locationOrLink: text(500).optional(), notes: text(4000).optional() })).mutation(({ input: { jobId, ...rest } }) => run(async () => thenSync(await createMeeting(jobId, rest)))),
  update: protectedProcedure.input(z.object({ id, title: text(200).min(1).optional(), startsAt: instant.optional(), endsAt: instant.optional(), locationOrLink: text(500).optional(), notes: text(4000).optional(), status: z.enum(["scheduled", "done", "cancelled"]).optional() })).mutation(({ input: { id: meetingId, ...patch } }) => run(async () => thenSync(await updateMeeting(meetingId, patch)))),
  cancel: protectedProcedure.input(z.object({ id })).mutation(({ input }) => run(async () => thenSync(await cancelMeeting(input.id)))),
  complete: protectedProcedure.input(z.object({ id })).mutation(({ input }) => run(async () => thenSync(await completeMeeting(input.id)))),
  retrySync: protectedProcedure.input(z.object({ id })).mutation(({ input }) => run(async () => thenSync(await retryMeetingSync(input.id)))),
});

export const tasksRouter = router({
  list: protectedProcedure.input(z.object({ jobId: id })).query(({ input }) => run(() => tasks.listTasks(input.jobId))),
  add: protectedProcedure.input(z.object({ jobId: id, title: text(300).min(1), dueDate: day.nullish() })).mutation(({ input }) => run(() => tasks.addTask(input.jobId, input.title, input.dueDate))),
  update: protectedProcedure.input(z.object({ id, title: text(300).min(1).optional(), status: z.enum(["todo", "doing", "done"]).optional(), dueDate: day.nullish(), note: text(2000).optional() })).mutation(({ input: { id: taskId, ...patch } }) => run(() => tasks.updateTask(taskId, patch))),
  remove: protectedProcedure.input(z.object({ id })).mutation(({ input }) => run(() => tasks.removeTask(input.id))),
  reorder: protectedProcedure.input(z.object({ jobId: id, orderedIds: z.array(id).max(200) })).mutation(({ input }) => run(() => tasks.reorderTasks(input.jobId, input.orderedIds))),
  template: protectedProcedure.query(() => tasks.getTaskTemplate()),
  saveTemplate: protectedProcedure.input(z.object({ titles: z.array(text(300)).max(100) })).mutation(({ input }) => run(() => tasks.replaceTaskTemplate(input.titles))),
});

export const documentsRouter = router({
  list: protectedProcedure.input(z.object({ jobId: id })).query(({ input }) => run(() => docs.listDocuments(input.jobId))),
  get: protectedProcedure.input(z.object({ id })).query(({ input }) => run(async () => (await docs.getDocument(input.id)) ?? Promise.reject(new PipelineError("NOT_FOUND", "That document does not exist.")))),
  createQuotation: protectedProcedure.input(z.object({ jobId: id, quotation: quotationInput })).mutation(({ input }) => run(() => docs.createQuotation(input.jobId, input.quotation))),
  updateQuotation: protectedProcedure.input(z.object({ id, quotation: quotationInput })).mutation(({ input }) => run(() => docs.updateQuotation(input.id, input.quotation))),
  duplicateQuotation: protectedProcedure.input(z.object({ id })).mutation(({ input }) => run(() => docs.duplicateQuotation(input.id))),
  rejectQuotation: protectedProcedure.input(z.object({ id })).mutation(({ input }) => run(() => docs.rejectQuotation(input.id))),
  markSent: protectedProcedure.input(z.object({ id, again: z.boolean().default(false) })).mutation(({ input }) => run(() => docs.markSent(input.id, input.again))),
  void: protectedProcedure.input(z.object({ id })).mutation(({ input }) => run(() => docs.voidDocument(input.id))),
  createInvoice: protectedProcedure.input(z.object({ jobId: id, basis: z.enum(["advance", "balance"]), paymentMethod: text(100).optional(), dueDate: day.optional() })).mutation(({ input: { jobId, ...rest } }) => run(() => docs.createInvoice(jobId, rest))),
  updateInvoice: protectedProcedure.input(z.object({ id, paymentMethod: text(100).optional(), dueDate: day.optional() })).mutation(({ input: { id: docId, ...patch } }) => run(() => docs.updateInvoiceDetails(docId, patch))),
  createReceipt: protectedProcedure.input(z.object({ ledgerEntryId: id })).mutation(({ input }) => run(() => docs.createReceipt(input.ledgerEntryId))),
  createContract: protectedProcedure.input(z.object({ jobId: id, contract: contractInput.default({}) })).mutation(({ input }) => run(() => docs.createContract(input.jobId, input.contract))),
  updateContract: protectedProcedure.input(z.object({ id, contract: contractInput })).mutation(({ input }) => run(() => docs.updateContract(input.id, input.contract))),
  saveTechnical: protectedProcedure.input(z.object({ jobId: id, id: id.optional(), overview: text(6000), frontend: text(300), backend: text(300), database: text(300), installation: text(8000), apis: text(8000) })).mutation(({ input: { jobId, id: docId, ...payload } }) => run(() => docs.saveTechnicalDoc(jobId, payload, docId))),
  saveDesign: protectedProcedure.input(z.object({ jobId: id, id: id.optional(), sitemap: text(6000), figmaLink: text(500), primaryColor: text(40), secondaryColor: text(40), accentColor: text(40), fonts: text(300), responsive: text(6000) })).mutation(({ input: { jobId, id: docId, ...payload } }) => run(() => docs.saveDesignDoc(jobId, payload, docId))),
  templateReview: protectedProcedure.query(async () => ({ notes: [...TEMPLATE_REVIEW_NOTES], dismissed: (await getSettings()).templateReviewDismissed })),
});

const entryDetails = { amount: money.refine((value) => value > 0, "Enter an amount above zero."), entryDate: day.optional(), method: method.optional(), note: text(500).optional() };
export const ledgerRouter = router({
  list: protectedProcedure.input(z.object({ jobId: id.optional(), from: day.optional(), to: day.optional(), includeVoid: z.boolean().optional() }).default({})).query(({ input }) => run(() => ledger.listLedger(input))),
  categories: protectedProcedure.query(() => ledger.ledgerCategories()),
  recordPayment: protectedProcedure.input(z.object({ jobId: id, category: z.enum(["advance", "final", "extra", "renewal"]), invoiceDocumentId: id.optional(), idempotencyKey: text(100).min(8).optional(), ...entryDetails })).mutation(({ input }) => run(() => ledger.recordEntry({ ...input, type: "income" }))),
  recordExpense: protectedProcedure.input(z.object({ jobId: id.nullish(), category: text(40).min(1), idempotencyKey: text(100).min(8).optional(), ...entryDetails })).mutation(({ input }) => run(() => ledger.recordEntry({ ...input, type: "expense" }))),
  void: protectedProcedure.input(z.object({ id, reason: text(500).min(3, "Say why the entry is being voided.") })).mutation(({ input }) => run(() => ledger.voidEntry(input.id, input.reason))),
  updateNote: protectedProcedure.input(z.object({ id, note: text(500) })).mutation(({ input }) => run(() => ledger.updateEntryNote(input.id, input.note))),
  correct: protectedProcedure.input(z.object({ id, amount: money.optional(), entryDate: day.optional(), category: text(40).optional(), method: method.optional() })).mutation(({ input: { id: entryId, ...patch } }) => run(() => ledger.correctEntry(entryId, patch))),
});

export const financeRouter = router({ overview: protectedProcedure.input(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).default({})).query(({ input }) => run(() => financeOverview(input.month))) });

export const renewalsRouter = router({
  list: protectedProcedure.input(z.object({ jobId: id.optional() }).default({})).query(({ input }) => run(() => renewals.listRenewals({ jobId: input.jobId }))),
  add: protectedProcedure.input(z.object({ jobId: id, kind: z.enum(["hosting", "domain", "support"]), dueDate: day, amount: money, note: text(500).optional() })).mutation(({ input: { jobId, ...rest } }) => run(() => renewals.addRenewal(jobId, rest))),
  update: protectedProcedure.input(z.object({ id, dueDate: day.optional(), amount: money.optional(), note: text(500).optional(), skip: z.boolean().optional() })).mutation(({ input: { id: renewalId, ...patch } }) => run(() => renewals.updateRenewal(renewalId, patch))),
  createInvoice: protectedProcedure.input(z.object({ id })).mutation(({ input }) => run(() => renewals.createRenewalInvoice(input.id))),
  recordPayment: protectedProcedure.input(z.object({ id, amount: money.optional(), entryDate: day.optional(), method: method.optional(), note: text(500).optional() })).mutation(({ input: { id: renewalId, ...rest } }) => run(() => renewals.recordRenewalPayment(renewalId, rest))),
});
