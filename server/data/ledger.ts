import { getSupabaseServer } from "../_core/supabase";
import { PAYMENT_METHODS } from "../../shared/finance";
import { toCents } from "../../shared/money";
import { colomboDate } from "../../shared/time";
import { hasDatabase } from "./core";
import { dbError, refuse, requireDb } from "./errors";
import { recordEvent } from "./events";
import { getSettings } from "./settings";

export const mapEntry = (row: any) => ({
  id: row.id as string, jobId: (row.job_id ?? null) as string | null, type: row.type as "income" | "expense", category: row.category as string,
  amount: Number(row.amount), entryDate: row.entry_date as string, method: row.method as string, note: (row.note ?? "") as string,
  invoiceDocumentId: (row.invoice_document_id ?? null) as string | null, voidedAt: (row.voided_at ?? null) as string | null, voidedReason: (row.voided_reason ?? null) as string | null,
  replacesEntryId: (row.replaces_entry_id ?? null) as string | null, isStartAdvance: Boolean(row.is_start_advance), createdAt: row.created_at as string,
});
export type LedgerEntry = ReturnType<typeof mapEntry>;

export type RecordEntryInput = { jobId?: string | null; type: "income" | "expense"; category: string; amount: number; entryDate?: string; method?: string; note?: string; invoiceDocumentId?: string | null; replacesEntryId?: string | null; idempotencyKey?: string };

export async function listLedger(filter: { jobId?: string; from?: string; to?: string; includeVoid?: boolean; limit?: number } = {}): Promise<LedgerEntry[]> {
  if (!hasDatabase()) return [];
  let query = getSupabaseServer().from("ledger_entries").select("*");
  if (filter.jobId) query = query.eq("job_id", filter.jobId);
  if (filter.from) query = query.gte("entry_date", filter.from);
  if (filter.to) query = query.lte("entry_date", filter.to);
  if (!filter.includeVoid) query = query.is("voided_at", null);
  const { data, error } = await query.order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(filter.limit ?? 5000);
  if (error) throw error;
  return (data ?? []).map(mapEntry);
}

export async function getEntry(id: string): Promise<LedgerEntry | null> {
  if (!hasDatabase()) return null;
  const { data, error } = await getSupabaseServer().from("ledger_entries").select("*").eq("id", id).maybeSingle();
  if (error) dbError(error);
  return data ? mapEntry(data) : null;
}

export async function ledgerCategories(): Promise<{ income: string[]; expense: string[] }> {
  return (await getSettings()).ledgerCategories;
}

// Money in or out. The database enforces the hard rules (income needs a job, the job must have started, ...); the checks
// here are the friendlier first line, and they check the categories the owner can edit.
export async function recordEntry(input: RecordEntryInput): Promise<LedgerEntry> {
  requireDb();
  const cents = toCents(input.amount);
  if (!Number.isFinite(input.amount) || cents <= 0 || Math.abs(input.amount * 100 - cents) > 0.001) refuse("BAD_REQUEST", "The amount must be more than zero, with at most two decimals.");
  const method = input.method ?? "bank_transfer";
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) refuse("BAD_REQUEST", "Choose bank transfer, cash, PayPal or other.");
  const categories = await ledgerCategories();
  if (!categories[input.type].includes(input.category)) refuse("BAD_REQUEST", `“${input.category}” is not a ${input.type} category.`);
  if (input.type === "income" && !input.jobId) refuse("PRECONDITION_FAILED", "Income must belong to a job.");
  const supabase = getSupabaseServer();
  if (input.jobId) {
    const { data: job, error } = await supabase.from("jobs").select("stage, started_at, title").eq("id", input.jobId).maybeSingle();
    if (error) dbError(error);
    if (!job) refuse("NOT_FOUND", "That job does not exist.");
    if (!job.started_at) refuse("PRECONDITION_FAILED", "Money can only be recorded once the project has started. Use Start project to record the advance.");
  }
  const { data, error } = await supabase.from("ledger_entries").insert({
    job_id: input.jobId ?? null, type: input.type, category: input.category, amount: (cents / 100).toFixed(2), entry_date: input.entryDate ?? colomboDate(), method,
    note: input.note ?? "", invoice_document_id: input.invoiceDocumentId ?? null, replaces_entry_id: input.replacesEntryId ?? null, idempotency_key: input.idempotencyKey ?? null,
  }).select("*").single();
  if (error) dbError(error);
  const entry = mapEntry(data);
  await recordEvent({ eventType: "ledger_entry_recorded", title: `${entry.type === "income" ? "Payment received" : "Expense recorded"}: ${entry.category}`, detail: `LKR ${entry.amount.toFixed(2)} on ${entry.entryDate}${entry.jobId ? "" : " (company)"}.`, clientId: undefined });
  return entry;
}

// Entries are never deleted. A mistake is voided with a reason (its receipt is voided with it), then re-entered if needed.
export async function voidEntry(id: string, reason: string): Promise<LedgerEntry> {
  requireDb();
  const { data, error } = await getSupabaseServer().rpc("void_ledger_entry", { p_id: id, p_reason: reason });
  if (error) dbError(error);
  const entry = mapEntry(data);
  await recordEvent({ eventType: "ledger_entry_voided", severity: "warning", title: "Ledger entry voided", detail: `LKR ${entry.amount.toFixed(2)} ${entry.category} (${entry.entryDate}) voided: ${reason.trim()}`, clientId: undefined });
  return entry;
}

// The note is the one thing about an entry that may change after a receipt exists.
export async function updateEntryNote(id: string, note: string): Promise<LedgerEntry> {
  requireDb();
  const { data, error } = await getSupabaseServer().from("ledger_entries").update({ note }).eq("id", id).select("*").maybeSingle();
  if (error) dbError(error);
  if (!data) refuse("NOT_FOUND", "That entry does not exist.");
  await recordEvent({ eventType: "ledger_entry_note", title: "Ledger note edited", detail: `Entry ${id} note changed.`, clientId: undefined });
  return mapEntry(data);
}

// An unvoided entry can have its amount, date, job or type corrected only when it has no receipt. The database refuses
// the change otherwise. Prefer void-and-replace; this exists for a typo on a payment nobody has been given paper for.
export async function correctEntry(id: string, patch: { amount?: number; entryDate?: string; category?: string; method?: string }): Promise<LedgerEntry> {
  requireDb();
  const set: Record<string, unknown> = {};
  if (patch.amount !== undefined) {
    const cents = toCents(patch.amount);
    if (cents <= 0) refuse("BAD_REQUEST", "The amount must be more than zero.");
    set.amount = (cents / 100).toFixed(2);
  }
  if (patch.entryDate !== undefined) set.entry_date = patch.entryDate;
  if (patch.category !== undefined) set.category = patch.category;
  if (patch.method !== undefined) set.method = patch.method;
  if (Object.keys(set).length === 0) refuse("BAD_REQUEST", "Nothing to change.");
  const { data, error } = await getSupabaseServer().from("ledger_entries").update(set).eq("id", id).select("*").maybeSingle();
  if (error) dbError(error);
  if (!data) refuse("NOT_FOUND", "That entry does not exist.");
  await recordEvent({ eventType: "ledger_entry_corrected", severity: "warning", title: "Ledger entry corrected", detail: `Entry ${id}: ${Object.keys(set).join(", ")} changed.`, clientId: undefined });
  return mapEntry(data);
}
