import { getSupabaseServer } from "../_core/supabase";
import { jobMoney, type JobMoney } from "../../shared/finance";
import { checkTransition, nextAction, type JobStage } from "../../shared/jobs";
import { colomboDate } from "../../shared/time";
import { hasDatabase } from "./core";
import { dbError, refuse, requireDb } from "./errors";
import { recordEvent } from "./events";
import { listLedger } from "./ledger";

export const mapJob = (row: any) => ({
  id: row.id as string, conversationClientId: (row.conversation_client_id ?? null) as string | null, clientName: row.client_name as string, clientPhone: (row.client_phone ?? "") as string,
  title: row.title as string, stage: row.stage as JobStage, approvedQuotationId: (row.approved_quotation_id ?? null) as string | null,
  priceTotal: row.price_total == null ? null : Number(row.price_total), advancePercent: row.advance_percent == null ? null : Number(row.advance_percent),
  requiredAdvance: row.required_advance == null ? null : Number(row.required_advance), startedAt: (row.started_at ?? null) as string | null, deliveredAt: (row.delivered_at ?? null) as string | null,
  closedAt: (row.closed_at ?? null) as string | null, estimatedDeliveryDate: (row.estimated_delivery_date ?? null) as string | null, lostFromStage: (row.lost_from_stage ?? null) as JobStage | null,
  lostReason: (row.lost_reason ?? null) as string | null, lostAt: (row.lost_at ?? null) as string | null, notes: (row.notes ?? "") as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
});
export type Job = ReturnType<typeof mapJob>;
export type JobWithMoney = Job & { money: JobMoney; nextAction: string };

const supabase = () => getSupabaseServer();

export async function getJob(id: string): Promise<Job | null> {
  if (!hasDatabase()) return null;
  const { data, error } = await supabase().from("jobs").select("*").eq("id", id).maybeSingle();
  if (error) dbError(error);
  return data ? mapJob(data) : null;
}
async function mustGetJob(id: string): Promise<Job> {
  requireDb();
  return (await getJob(id)) ?? refuse("NOT_FOUND", "That job does not exist.");
}

async function withMoney(jobs: Job[]): Promise<JobWithMoney[]> {
  const entries = jobs.length ? (await listLedger({})).filter((entry) => entry.jobId) : [];
  return jobs.map((job) => ({ ...job, money: jobMoney(job, entries, job.advancePercent), nextAction: nextAction(job.stage) }));
}

export async function listJobs(): Promise<JobWithMoney[]> {
  if (!hasDatabase()) return [];
  const { data, error } = await supabase().from("jobs").select("*").order("updated_at", { ascending: false }).limit(500);
  if (error) throw error;
  return withMoney((data ?? []).map(mapJob));
}

export async function getJobDetail(id: string): Promise<(JobWithMoney & { unfinishedTasks: number }) | null> {
  const job = await getJob(id);
  if (!job) return null;
  const [withMoneyRow] = await withMoney([job]);
  const { data, error } = await supabase().from("job_tasks").select("id").eq("job_id", id).neq("status", "done");
  if (error) throw error;
  return { ...withMoneyRow, unfinishedTasks: (data ?? []).length };
}

const audit = (job: Job, title: string, detail: string, severity: "info" | "warning" = "info") =>
  recordEvent({ eventType: "job_stage_changed", severity, title, detail: `${job.clientName} (${job.title}): ${detail}`, clientId: job.conversationClientId ?? undefined });

export async function createJob(input: { clientName: string; clientPhone?: string; title: string; conversationClientId?: string | null; estimatedDeliveryDate?: string | null; notes?: string }): Promise<Job> {
  requireDb();
  const { data, error } = await supabase().from("jobs").insert({ client_name: input.clientName.trim(), client_phone: (input.clientPhone ?? "").trim(), title: input.title.trim(), conversation_client_id: input.conversationClientId ?? null, estimated_delivery_date: input.estimatedDeliveryDate ?? null, notes: input.notes ?? "" }).select("*").single();
  if (error) dbError(error);
  const job = mapJob(data);
  await audit(job, "Job created", "added as a lead.");
  return job;
}

// A conversation's name and number, ready to pre-fill the new job form.
export async function jobDraftFromConversation(clientId: string) {
  if (!hasDatabase()) return null;
  const { data, error } = await supabase().from("conversations").select("client_id, wa_id, profile_name, extracted_fields").eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const fields = (data.extracted_fields ?? {}) as Record<string, string | null>;
  return { conversationClientId: data.client_id as string, clientName: (fields.clientName || data.profile_name || data.wa_id) as string, clientPhone: `+${String(data.wa_id).replace(/^\+/, "")}` };
}

export async function updateJob(id: string, patch: { clientName?: string; clientPhone?: string; title?: string; estimatedDeliveryDate?: string | null; notes?: string }): Promise<Job> {
  const job = await mustGetJob(id);
  const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.clientName !== undefined) set.client_name = patch.clientName.trim();
  if (patch.clientPhone !== undefined) set.client_phone = patch.clientPhone.trim();
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.estimatedDeliveryDate !== undefined) set.estimated_delivery_date = patch.estimatedDeliveryDate;
  if (patch.notes !== undefined) set.notes = patch.notes;
  const { data, error } = await supabase().from("jobs").update(set).eq("id", job.id).select("*").single();
  if (error) dbError(error);
  return mapJob(data);
}

async function liveMeetingCount(jobId: string) {
  const { data, error } = await supabase().from("meetings").select("id").eq("job_id", jobId).neq("status", "cancelled");
  if (error) throw error;
  return (data ?? []).length;
}

// Moves a lead to "meeting" once it has a meeting that is not cancelled. Called after a meeting is saved.
export async function advanceToMeeting(jobId: string) {
  const job = await getJob(jobId);
  if (!job || job.stage !== "lead") return;
  const gate = checkTransition("lead", "meeting", { hasLiveMeeting: (await liveMeetingCount(jobId)) > 0 });
  if (!gate.ok) return;
  const { data, error } = await supabase().from("jobs").update({ stage: "meeting", updated_at: new Date().toISOString() }).eq("id", jobId).eq("stage", "lead").select("id");
  if (error) throw error;
  if (data?.length) await audit(job, "Job moved to meeting", "a meeting was booked.");
}

export async function approveQuotation(quotationId: string): Promise<Job> {
  requireDb();
  const { data: quotation, error } = await supabase().from("documents").select("id, job_id, kind, status").eq("id", quotationId).eq("kind", "quotation").maybeSingle();
  if (error) dbError(error);
  if (!quotation) refuse("NOT_FOUND", "That quotation does not exist.");
  const job = await mustGetJob(quotation.job_id);
  const gate = checkTransition(job.stage, "approved", { chosenQuotationStatus: quotation.status });
  if (!gate.ok) refuse("PRECONDITION_FAILED", gate.reason);
  const { data, error: rpcError } = await supabase().rpc("approve_quotation", { p_quotation_id: quotationId });
  if (rpcError) dbError(rpcError);
  const approved = mapJob(data);
  await audit(approved, "Quotation approved", `client approved quotation ${quotationId}; price LKR ${approved.priceTotal}, advance ${approved.advancePercent}%.`);
  return approved;
}

export async function revokeApproval(jobId: string): Promise<Job> {
  const job = await mustGetJob(jobId);
  if (job.stage !== "approved") refuse("PRECONDITION_FAILED", "An approval can only be revoked before the project starts.");
  const { data, error } = await supabase().rpc("revoke_approval", { p_job_id: jobId });
  if (error) dbError(error);
  const revoked = mapJob(data);
  await audit(revoked, "Approval revoked", "the job went back to quoted; the price and payment schedule were cleared.", "warning");
  return revoked;
}

export type StartProjectInput = { amount: number; idempotencyKey: string; method?: string; entryDate?: string; note?: string };
export async function startProject(jobId: string, input: StartProjectInput) {
  const job = await mustGetJob(jobId);
  // A job that has started answers a repeat call with what the first call did, so only an approved job is gated here.
  if (job.stage === "approved") {
    const gate = checkTransition("approved", "active", { requiredAdvance: job.requiredAdvance, advanceAmount: input.amount });
    if (!gate.ok) refuse("PRECONDITION_FAILED", gate.reason);
  } else if (!["active", "delivered", "closed"].includes(job.stage)) {
    refuse("PRECONDITION_FAILED", "The project can only be started once the quotation is approved.");
  }
  const { data, error } = await supabase().rpc("start_project", { p_job_id: jobId, p_amount: input.amount, p_idempotency_key: input.idempotencyKey, p_method: input.method ?? "bank_transfer", p_entry_date: input.entryDate ?? colomboDate(), p_note: input.note ?? "" });
  if (error) dbError(error);
  const result = data as { job_id: string; ledger_entry_id: string; amount: number; already_started: boolean; tasks: number };
  const started = await mustGetJob(jobId);
  if (!result.already_started) await audit(started, "Project started", `advance LKR ${result.amount} recorded and ${result.tasks} tasks created.`);
  return { job: started, ledgerEntryId: result.ledger_entry_id, amount: Number(result.amount), alreadyStarted: result.already_started, tasks: Number(result.tasks) };
}

export async function markDelivered(jobId: string) {
  const job = await mustGetJob(jobId);
  const { data: open, error: tasksError } = await supabase().from("job_tasks").select("id").eq("job_id", jobId).neq("status", "done");
  if (tasksError) throw tasksError;
  const gate = checkTransition(job.stage, "delivered", { unfinishedTasks: (open ?? []).length });
  if (!gate.ok) refuse("PRECONDITION_FAILED", gate.reason);
  const { data, error } = await supabase().rpc("mark_delivered", { p_job_id: jobId });
  if (error) dbError(error);
  const delivered = mapJob(data);
  await audit(delivered, "Job delivered", `handed over for payment${gate.warnings.length ? ` (${gate.warnings.join(" ")})` : ""}.`);
  return { job: delivered, warnings: gate.warnings };
}

export async function closeJob(jobId: string): Promise<Job> {
  const [job, entries] = [await mustGetJob(jobId), await listLedger({ jobId })];
  const gate = checkTransition(job.stage, "closed", { outstanding: jobMoney(job, entries).outstanding });
  if (!gate.ok) refuse("PRECONDITION_FAILED", gate.reason);
  const { data, error } = await supabase().rpc("close_job", { p_job_id: jobId });
  if (error) dbError(error);
  const closed = mapJob(data);
  await audit(closed, "Job closed", "fully paid and done.");
  return closed;
}

export async function markLost(jobId: string, reason: string): Promise<Job> {
  const job = await mustGetJob(jobId);
  const gate = checkTransition(job.stage, "lost");
  if (!gate.ok) refuse("PRECONDITION_FAILED", gate.reason);
  const { data, error } = await supabase().rpc("mark_lost", { p_job_id: jobId, p_reason: reason });
  if (error) dbError(error);
  const lost = mapJob(data);
  await audit(lost, "Job lost", `lost from ${job.stage}${reason.trim() ? `: ${reason.trim()}` : ""}.`, "warning");
  return lost;
}

export async function reopenJob(jobId: string): Promise<Job> {
  const job = await mustGetJob(jobId);
  const gate = checkTransition(job.stage, job.lostFromStage ?? "lead", { lostFromStage: job.lostFromStage });
  if (job.stage !== "lost" || !gate.ok) refuse("PRECONDITION_FAILED", "Only a lost job can be reopened.");
  const { data, error } = await supabase().rpc("reopen_job", { p_job_id: jobId });
  if (error) dbError(error);
  const reopened = mapJob(data);
  await audit(reopened, "Job reopened", `back to ${reopened.stage}.`);
  return reopened;
}
