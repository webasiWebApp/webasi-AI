import { getSupabaseServer } from "../_core/supabase";
import { SETTLES_PRICE } from "../../shared/finance";
import { DEFAULT_DOCUMENT_SETTINGS, quotationTotals, type ContractPayload, type DesignDocPayload, type DocumentKind, type InvoicePayload, type QuotationItem, type QuotationPayload, type ReceiptPayload, type TechnicalDocPayload } from "../../shared/documents";
import { toCents, fromCents } from "../../shared/money";
import { addDays, colomboDate } from "../../shared/time";
import { hasDatabase } from "./core";
import { dbError, refuse, requireDb } from "./errors";
import { recordEvent } from "./events";
import { getJob, type Job } from "./jobs";
import { getEntry, listLedger } from "./ledger";
import { getSettings } from "./settings";
import { jobMoney } from "../../shared/finance";

export const mapDocument = (row: any) => ({
  id: row.id as string, jobId: row.job_id as string, kind: row.kind as DocumentKind, number: row.number as string, payload: (row.payload ?? {}) as Record<string, any>,
  status: row.status as string, sentAt: (row.sent_at ?? null) as string | null, ledgerEntryId: (row.ledger_entry_id ?? null) as string | null,
  supersededBy: (row.superseded_by ?? null) as string | null, voidedAt: (row.voided_at ?? null) as string | null, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
});
export type PipelineDocument = ReturnType<typeof mapDocument>;

const supabase = () => getSupabaseServer();

export async function listDocuments(jobId: string): Promise<PipelineDocument[]> {
  if (!hasDatabase()) return [];
  const { data, error } = await supabase().from("documents").select("*").eq("job_id", jobId).order("created_at", { ascending: false });
  if (error) dbError(error);
  return (data ?? []).map(mapDocument);
}

export async function getDocument(id: string): Promise<PipelineDocument | null> {
  if (!hasDatabase()) return null;
  const { data, error } = await supabase().from("documents").select("*").eq("id", id).maybeSingle();
  if (error) dbError(error);
  return data ? mapDocument(data) : null;
}
async function mustGetDocument(id: string) { requireDb(); return (await getDocument(id)) ?? refuse("NOT_FOUND", "That document does not exist."); }
async function mustGetJob(id: string): Promise<Job> { requireDb(); return (await getJob(id)) ?? refuse("NOT_FOUND", "That job does not exist."); }

// All the numbers come from one counter and are issued by a database function; see issue_document_number().
async function create(jobId: string, kind: DocumentKind, payload: object, ledgerEntryId?: string): Promise<PipelineDocument> {
  const { data, error } = await supabase().rpc("create_document", { p_job_id: jobId, p_kind: kind, p_payload: payload, p_ledger_entry_id: ledgerEntryId ?? null });
  if (error) dbError(error);
  return mapDocument(data);
}

async function editPayload(doc: PipelineDocument, payload: object, allowed: string[]): Promise<PipelineDocument> {
  if (!allowed.includes(doc.status)) refuse("PRECONDITION_FAILED", doc.status === "approved" ? "An approved quotation is read-only. Revoke the approval first." : `A ${doc.status} document cannot be edited.`);
  // Guarded on the status it was read in, so an approval that lands at the same moment is not overwritten.
  const { data, error } = await supabase().from("documents").update({ payload, updated_at: new Date().toISOString() }).eq("id", doc.id).eq("status", doc.status).select("*").maybeSingle();
  if (error) dbError(error);
  if (!data) refuse("CONFLICT", "The document changed while you were editing it. Reload and try again.");
  return mapDocument(data);
}

const note = (doc: { kind: DocumentKind; number: string }, text: string) => recordEvent({ eventType: "document_event", title: `${doc.kind.replace("_", " ")} ${doc.number}: ${text}`, detail: `Document ${doc.number} (${doc.kind}) ${text}.` });

// ----- Quotation -----------------------------------------------------------------------------------------------------
export type QuotationInput = {
  clientName: string; projectName: string; intro: string; items: QuotationItem[]; advancePercent?: number; date?: string; dueDate?: string;
  infrastructure?: QuotationPayload["infrastructure"]; afterService?: string[]; timelineDuration?: string; milestones?: QuotationPayload["milestones"];
  portfolioMain?: string; portfolioLinks?: string[]; footerLinks?: QuotationPayload["footerLinks"];
};

// The owner types the client, project, intro, line items and prices; nothing is taken from the chat. The boilerplate
// sections start from Settings and stay editable. Totals are computed here, never trusted from the form.
export async function quotationPayload(input: QuotationInput): Promise<QuotationPayload> {
  const settings = await getSettings();
  const defaults = settings.documentSettings;
  const items = input.items.map((item) => ({ description: item.description.trim(), bullets: item.bullets.map((bullet) => bullet.trim()).filter(Boolean), cost: fromCents(toCents(item.cost)) }));
  if (items.length === 0 || items.some((item) => !item.description)) refuse("BAD_REQUEST", "Add at least one line item with a description.");
  if (items.some((item) => item.cost < 0)) refuse("BAD_REQUEST", "A cost cannot be negative.");
  const totals = quotationTotals(items);
  if (totals.total <= 0) refuse("BAD_REQUEST", "The quotation total must be more than zero.");
  const advancePercent = input.advancePercent ?? settings.defaultAdvancePercent;
  if (!(advancePercent > 0 && advancePercent <= 100)) refuse("BAD_REQUEST", "The advance must be between 1% and 100%.");
  const date = input.date ?? colomboDate();
  return {
    clientName: input.clientName.trim(), projectName: input.projectName.trim(), intro: input.intro.trim(), date, dueDate: input.dueDate ?? addDays(date, defaults.quotationDueDays),
    items, ...totals, advancePercent,
    infrastructure: input.infrastructure ?? defaults.infrastructure, afterService: input.afterService ?? defaults.afterService, timelineDuration: input.timelineDuration ?? defaults.timelineDuration,
    milestones: input.milestones ?? defaults.milestones, portfolioMain: input.portfolioMain ?? defaults.portfolioMain, portfolioLinks: input.portfolioLinks ?? defaults.portfolioLinks, footerLinks: input.footerLinks ?? defaults.footerLinks,
  };
}

export async function createQuotation(jobId: string, input: QuotationInput) {
  await mustGetJob(jobId);
  const doc = await create(jobId, "quotation", await quotationPayload(input));
  await note(doc, "created");
  return doc;
}

// Editing keeps the number, the status and (for a sent quotation) its sent date.
export async function updateQuotation(id: string, input: QuotationInput) {
  const doc = await mustGetDocument(id);
  if (doc.kind !== "quotation") refuse("BAD_REQUEST", "That document is not a quotation.");
  const updated = await editPayload(doc, await quotationPayload(input), ["draft", "sent"]);
  await note(updated, "edited");
  return updated;
}

export async function duplicateQuotation(id: string) {
  const doc = await mustGetDocument(id);
  if (doc.kind !== "quotation") refuse("BAD_REQUEST", "That document is not a quotation.");
  const copy = await create(doc.jobId, "quotation", { ...doc.payload, date: colomboDate(), dueDate: addDays(colomboDate(), (await getSettings()).documentSettings.quotationDueDays) });
  await note(copy, `duplicated from ${doc.number}`);
  return copy;
}

export async function rejectQuotation(id: string) {
  const doc = await mustGetDocument(id);
  if (doc.kind !== "quotation" || !["draft", "sent"].includes(doc.status)) refuse("PRECONDITION_FAILED", "Only a draft or sent quotation can be marked rejected.");
  const { data, error } = await supabase().from("documents").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", id).eq("status", doc.status).select("*").maybeSingle();
  if (error) dbError(error);
  if (!data) refuse("CONFLICT", "The quotation changed. Reload and try again.");
  await note(doc, "marked rejected");
  return mapDocument(data);
}

// ----- Sent, void ------------------------------------------------------------------------------------------------------
// sent_at is set here and nowhere else: saving, editing and regenerating never touch it, so reminder clocks cannot be
// reset or duplicated by them. "Mark as sent again" is the one way to move it, and it logs the old value.
export async function markSent(id: string, again = false) {
  const doc = await mustGetDocument(id);
  if (doc.status === "void" || doc.status === "approved" || doc.status === "superseded" || doc.status === "rejected") refuse("PRECONDITION_FAILED", `A ${doc.status} document cannot be marked as sent.`);
  if (doc.status === "sent" && !again) refuse("PRECONDITION_FAILED", "This document is already marked as sent. Use “Mark as sent again” to restart its clock.");
  if (doc.status === "draft" && again) refuse("PRECONDITION_FAILED", "This document has not been sent yet.");
  const sentAt = new Date().toISOString();
  const { data, error } = await supabase().from("documents").update({ status: "sent", sent_at: sentAt, updated_at: sentAt }).eq("id", id).eq("status", doc.status).select("*").maybeSingle();
  if (error) dbError(error);
  if (!data) refuse("CONFLICT", "The document changed. Reload and try again.");
  await recordEvent({ eventType: "document_sent", title: `${doc.kind.replace("_", " ")} ${doc.number} marked as sent`, detail: again ? `Marked as sent again. Previous sent date: ${doc.sentAt}.` : "Marked as sent." });
  return mapDocument(data);
}

export async function voidDocument(id: string) {
  const doc = await mustGetDocument(id);
  if (doc.kind === "quotation") refuse("PRECONDITION_FAILED", "A quotation is rejected or superseded, not voided.");
  if (doc.kind === "receipt") refuse("PRECONDITION_FAILED", "A receipt is voided by voiding the payment it records.");
  if (doc.status === "void") return doc;
  const { data, error } = await supabase().from("documents").update({ status: "void", voided_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  if (error) dbError(error);
  await note(doc, "voided");
  return mapDocument(data);
}

// ----- Invoice, receipt ------------------------------------------------------------------------------------------------
// An invoice asks for money that has not arrived. It reads the job and writes nothing to the ledger.
export async function createInvoice(jobId: string, input: { basis: "advance" | "balance"; paymentMethod?: string; dueDate?: string }) {
  const job = await mustGetJob(jobId);
  if (job.priceTotal == null || !["approved", "active", "delivered", "closed"].includes(job.stage)) refuse("PRECONDITION_FAILED", "An invoice needs an approved quotation behind it.");
  const [entries, settings] = await Promise.all([listLedger({ jobId }), getSettings()]);
  const money = jobMoney(job, entries, job.advancePercent);
  const amount = input.basis === "advance" ? job.requiredAdvance ?? 0 : money.outstanding;
  if (amount <= 0) refuse("PRECONDITION_FAILED", input.basis === "advance" ? "There is no advance to invoice." : "Nothing is outstanding on this job.");
  const date = colomboDate();
  const description = input.basis === "advance" ? `Advance payment (${job.advancePercent}% of the project price) – ${job.title}` : `Balance payment – ${job.title}`;
  const payload: InvoicePayload = {
    basis: input.basis, clientName: job.clientName, clientPhone: job.clientPhone, projectName: job.title, date, dueDate: input.dueDate ?? addDays(date, settings.documentSettings.invoiceDueDays),
    paymentMethod: input.paymentMethod ?? settings.documentSettings.paymentMethodText, lines: [{ description, amount }], total: amount,
  };
  const doc = await create(jobId, "invoice", payload);
  await note(doc, "created");
  return doc;
}

export async function updateInvoiceDetails(id: string, patch: { paymentMethod?: string; dueDate?: string }) {
  const doc = await mustGetDocument(id);
  if (!["invoice", "renewal_invoice"].includes(doc.kind)) refuse("BAD_REQUEST", "That document is not an invoice.");
  const updated = await editPayload(doc, { ...doc.payload, ...(patch.paymentMethod !== undefined && { paymentMethod: patch.paymentMethod }), ...(patch.dueDate !== undefined && { dueDate: patch.dueDate }) }, ["draft", "sent"]);
  await note(updated, "edited");
  return updated;
}

// A receipt is proof that money arrived, so it exists only for a live income entry, and its payload is a snapshot taken
// now. Asking again returns the receipt that exists.
export async function createReceipt(ledgerEntryId: string) {
  const entry = await getEntry(ledgerEntryId);
  if (!entry) return refuse("NOT_FOUND", "That payment does not exist.");
  if (entry.type !== "income" || !entry.jobId) refuse("PRECONDITION_FAILED", "A receipt is only issued for a payment received.");
  if (entry.voidedAt) refuse("PRECONDITION_FAILED", "That payment was voided.");
  const { data: existing, error: lookupError } = await supabase().from("documents").select("*").eq("ledger_entry_id", ledgerEntryId).eq("kind", "receipt").maybeSingle();
  if (lookupError) dbError(lookupError);
  if (existing) return mapDocument(existing);
  const job = await mustGetJob(entry.jobId);
  const all = (await listLedger({ jobId: job.id })).sort((a, b) => (a.entryDate === b.entryDate ? (a.createdAt < b.createdAt ? -1 : 1) : a.entryDate < b.entryDate ? -1 : 1));
  const upTo = all.slice(0, all.findIndex((row) => row.id === entry.id) + 1);
  const paidCents = upTo.filter((row) => row.type === "income" && SETTLES_PRICE.includes(row.category)).reduce((sum, row) => sum + toCents(row.amount), 0);
  const invoice = entry.invoiceDocumentId ? await getDocument(entry.invoiceDocumentId) : null;
  const payload: ReceiptPayload = {
    clientName: job.clientName, projectName: job.title, date: entry.entryDate, amount: entry.amount, method: entry.method, category: entry.category,
    balanceAfter: fromCents(Math.max(toCents(job.priceTotal) - paidCents, 0)), invoiceNumber: invoice?.number, note: entry.note,
  };
  const doc = await create(job.id, "receipt", payload, entry.id);
  await note(doc, "created");
  return doc;
}

// ----- Proposal and contract pack --------------------------------------------------------------------------------------
export type ContractInput = Partial<Pick<ContractPayload, "title" | "dateOfDelivery" | "agreementDate" | "startDate" | "completionDate" | "paymentMethod" | "scope" | "receivingParty" | "supportPeriod" | "supportContact" | "clauses" | "ndaClauses" | "agreementIntro" | "ndaIntro" | "ndaClosing">>;

async function approvedQuotationFor(job: Job) {
  if (!job.approvedQuotationId) refuse("PRECONDITION_FAILED", "The proposal and contract pack needs an approved quotation.");
  return mustGetDocument(job.approvedQuotationId!);
}

// Client, price and payment schedule are read from the approved quotation each time the pack is built, so the contract
// can never state different terms from it. Only dates, scope, payment method and the clause wording are the owner's.
export async function createContract(jobId: string, input: ContractInput = {}) {
  const job = await mustGetJob(jobId);
  const quotation = await approvedQuotationFor(job);
  const defaults = (await getSettings()).documentSettings;
  const today = colomboDate();
  const q = quotation.payload as QuotationPayload;
  const scope = input.scope ?? q.items.flatMap((item) => [item.description, ...item.bullets.map((bullet) => `  – ${bullet}`)]);
  const payload: ContractPayload = {
    title: input.title ?? defaults.contractTitle, projectName: q.projectName, clientName: q.clientName,
    dateOfDelivery: input.dateOfDelivery ?? job.estimatedDeliveryDate ?? "", agreementDate: input.agreementDate ?? today, startDate: input.startDate ?? today, completionDate: input.completionDate ?? job.estimatedDeliveryDate ?? "",
    paymentMethod: input.paymentMethod ?? defaults.paymentMethodText, scope, receivingParty: input.receivingParty ?? defaults.receivingParty, supportPeriod: input.supportPeriod ?? defaults.supportPeriod, supportContact: input.supportContact ?? defaults.supportContact,
    ...(input.clauses && { clauses: input.clauses }), ...(input.ndaClauses && { ndaClauses: input.ndaClauses }), ...(input.agreementIntro && { agreementIntro: input.agreementIntro }), ...(input.ndaIntro && { ndaIntro: input.ndaIntro }), ...(input.ndaClosing && { ndaClosing: input.ndaClosing }),
  };
  const doc = await create(jobId, "contract", payload);
  await note(doc, "created");
  return doc;
}

export async function updateContract(id: string, input: ContractInput) {
  const doc = await mustGetDocument(id);
  if (doc.kind !== "contract") refuse("BAD_REQUEST", "That document is not a contract pack.");
  const updated = await editPayload(doc, { ...doc.payload, ...input }, ["draft", "sent"]);
  await note(updated, "edited");
  return updated;
}

// ----- Technical and design documentation ------------------------------------------------------------------------------
// These forms hold no secrets (passwords belong in the one-off credentials PDF, which is never stored).
export async function saveTechnicalDoc(jobId: string, payload: TechnicalDocPayload, id?: string) {
  await mustGetJob(jobId);
  if (id) { const doc = await mustGetDocument(id); if (doc.kind !== "technical_doc" || doc.jobId !== jobId) refuse("BAD_REQUEST", "That is not this job's technical documentation."); return editPayload(doc, payload, ["draft", "sent"]); }
  const doc = await create(jobId, "technical_doc", payload);
  await note(doc, "created");
  return doc;
}
export async function saveDesignDoc(jobId: string, payload: DesignDocPayload, id?: string) {
  await mustGetJob(jobId);
  if (id) { const doc = await mustGetDocument(id); if (doc.kind !== "design_doc" || doc.jobId !== jobId) refuse("BAD_REQUEST", "That is not this job's design documentation."); return editPayload(doc, payload, ["draft", "sent"]); }
  const doc = await create(jobId, "design_doc", payload);
  await note(doc, "created");
  return doc;
}

// Everything a PDF needs besides the document itself.
export async function documentContext(id: string) {
  const doc = await mustGetDocument(id);
  const job = await mustGetJob(doc.jobId);
  const settings = await getSettings();
  const approved = job.approvedQuotationId ? await getDocument(job.approvedQuotationId) : null;
  return { doc, job, settings, approvedQuotation: approved, defaults: settings.documentSettings ?? DEFAULT_DOCUMENT_SETTINGS };
}
