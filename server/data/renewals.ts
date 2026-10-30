import { getSupabaseServer } from "../_core/supabase";
import type { InvoicePayload } from "../../shared/documents";
import { toCents } from "../../shared/money";
import { addDays, colomboDate } from "../../shared/time";
import { hasDatabase } from "./core";
import { getDocument, type PipelineDocument } from "./documents";
import { dbError, refuse, requireDb } from "./errors";
import { recordEvent } from "./events";
import { getJob } from "./jobs";
import { getSettings } from "./settings";
import { recordEntry } from "./ledger";

export const mapRenewal = (row: any) => ({
  id: row.id as string, jobId: row.job_id as string, kind: row.kind as "hosting" | "domain" | "support", dueDate: row.due_date as string, amount: Number(row.amount),
  status: row.status as "upcoming" | "invoiced" | "paid" | "skipped", invoiceDocumentId: (row.invoice_document_id ?? null) as string | null, paidLedgerEntryId: (row.paid_ledger_entry_id ?? null) as string | null, note: (row.note ?? "") as string,
});
export type Renewal = ReturnType<typeof mapRenewal>;

const supabase = () => getSupabaseServer();

export async function listRenewals(filter: { jobId?: string; status?: string[]; dueBefore?: string } = {}): Promise<Renewal[]> {
  if (!hasDatabase()) return [];
  let query = supabase().from("renewals").select("*");
  if (filter.jobId) query = query.eq("job_id", filter.jobId);
  if (filter.status) query = query.in("status", filter.status);
  if (filter.dueBefore) query = query.lte("due_date", filter.dueBefore);
  const { data, error } = await query.order("due_date", { ascending: true }).limit(500);
  if (error) dbError(error);
  return (data ?? []).map(mapRenewal);
}

async function mustGet(id: string): Promise<Renewal> {
  requireDb();
  const { data, error } = await supabase().from("renewals").select("*").eq("id", id).maybeSingle();
  if (error) dbError(error);
  return data ? mapRenewal(data) : refuse("NOT_FOUND", "That renewal does not exist.");
}

export async function addRenewal(jobId: string, input: { kind: "hosting" | "domain" | "support"; dueDate: string; amount: number; note?: string }): Promise<Renewal> {
  requireDb();
  const job = await getJob(jobId);
  if (!job) refuse("NOT_FOUND", "That job does not exist.");
  if (!["delivered", "closed"].includes(job.stage)) refuse("PRECONDITION_FAILED", "Renewals start once the job is delivered.");
  const { data, error } = await supabase().from("renewals").insert({ job_id: jobId, kind: input.kind, due_date: input.dueDate, amount: (toCents(input.amount) / 100).toFixed(2), note: input.note ?? "" }).select("*").single();
  if (error) dbError(error);
  return mapRenewal(data);
}

export async function updateRenewal(id: string, patch: { dueDate?: string; amount?: number; note?: string; skip?: boolean }): Promise<Renewal> {
  const renewal = await mustGet(id);
  if (["paid"].includes(renewal.status)) refuse("PRECONDITION_FAILED", "A paid renewal cannot be changed.");
  const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.dueDate !== undefined) set.due_date = patch.dueDate;
  if (patch.amount !== undefined) set.amount = (toCents(patch.amount) / 100).toFixed(2);
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.skip) set.status = "skipped";
  const { data, error } = await supabase().from("renewals").update(set).eq("id", id).select("*").single();
  if (error) dbError(error);
  return mapRenewal(data);
}

// The renewal invoice asks for the renewal's amount. Like any invoice it writes nothing to the ledger.
export async function createRenewalInvoice(renewalId: string): Promise<PipelineDocument> {
  const renewal = await mustGet(renewalId);
  if (renewal.status === "paid" || renewal.status === "skipped") refuse("PRECONDITION_FAILED", `This renewal is ${renewal.status}.`);
  if (renewal.amount <= 0) refuse("PRECONDITION_FAILED", "Set the renewal amount before invoicing it.");
  const job = await getJob(renewal.jobId);
  if (!job) refuse("NOT_FOUND", "That job does not exist.");
  const settings = await getSettings();
  const date = colomboDate();
  const label = { hosting: "Hosting renewal", domain: "Domain renewal", support: "Support renewal" }[renewal.kind];
  const payload: InvoicePayload = {
    basis: "renewal", renewalId, clientName: job.clientName, clientPhone: job.clientPhone, projectName: job.title, date, dueDate: renewal.dueDate > date ? renewal.dueDate : addDays(date, settings.documentSettings.invoiceDueDays),
    paymentMethod: settings.documentSettings.paymentMethodText, lines: [{ description: `${label} – ${job.title}`, amount: renewal.amount }], total: renewal.amount,
  };
  const { data, error } = await supabase().rpc("create_document", { p_job_id: renewal.jobId, p_kind: "renewal_invoice", p_payload: payload, p_ledger_entry_id: null });
  if (error) dbError(error);
  const { error: linkError } = await supabase().from("renewals").update({ status: "invoiced", invoice_document_id: data.id, updated_at: new Date().toISOString() }).eq("id", renewalId);
  if (linkError) dbError(linkError);
  await recordEvent({ eventType: "renewal_invoiced", title: "Renewal invoice created", detail: `${job.clientName}: ${label} due ${renewal.dueDate}, LKR ${renewal.amount}.`, clientId: job.conversationClientId ?? undefined });
  return (await getDocument(data.id))!;
}

// Recording the payment of a renewal creates an income entry of category "renewal" and marks the renewal paid.
export async function recordRenewalPayment(renewalId: string, input: { amount?: number; entryDate?: string; method?: string; note?: string }) {
  const renewal = await mustGet(renewalId);
  if (renewal.status === "paid" || renewal.status === "skipped") refuse("PRECONDITION_FAILED", `This renewal is already ${renewal.status}.`);
  const entry = await recordEntry({ jobId: renewal.jobId, type: "income", category: "renewal", amount: input.amount ?? renewal.amount, entryDate: input.entryDate, method: input.method, note: input.note ?? `${renewal.kind} renewal`, invoiceDocumentId: renewal.invoiceDocumentId });
  const { data, error } = await supabase().from("renewals").update({ status: "paid", paid_ledger_entry_id: entry.id, updated_at: new Date().toISOString() }).eq("id", renewalId).select("*").single();
  if (error) dbError(error);
  return { renewal: mapRenewal(data), entry };
}
