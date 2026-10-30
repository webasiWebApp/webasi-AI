import { getSupabaseServer } from "../_core/supabase";
import { addDays, colomboDate, daysBetween, daysSince } from "../../shared/time";
import { colomboLocalToInstant } from "../../shared/time";
import { hasDatabase } from "./core";
import { dbError } from "./errors";
import { listJobs } from "./jobs";
import { listMeetings } from "./meetings";
import { listRenewals } from "./renewals";
import { getSettings } from "./settings";

// The one-screen replacement for a task board: what is on today and what needs chasing. Every row carries its job id.
export async function todayOverview(now = new Date()) {
  const today = colomboDate(now);
  const empty = { date: today, meetings: [], tasks: { dueOrOverdue: [], next: [] }, moneyToChase: { awaitingAdvance: [], balances: [] }, quotationsWaiting: [], renewalsDue: [] };
  if (!hasDatabase()) return empty;
  const settings = await getSettings();
  const jobs = await listJobs();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const label = (jobId: string) => { const job = byId.get(jobId); return { jobId, clientName: job?.clientName ?? "", jobTitle: job?.title ?? "" }; };
  const supabase = getSupabaseServer();

  const from = colomboLocalToInstant(`${today}T00:00`).toISOString();
  const to = colomboLocalToInstant(`${addDays(today, 8)}T00:00`).toISOString();
  const meetings = (await listMeetings({ from, to })).filter((meeting) => meeting.status === "scheduled" && byId.get(meeting.jobId)?.stage !== "lost").map((meeting) => ({ ...meeting, ...label(meeting.jobId) }));

  const openJobs = jobs.filter((job) => !["closed", "lost"].includes(job.stage));
  const { data: due, error: dueError } = await supabase.from("job_tasks").select("*").lte("due_date", today).neq("status", "done").order("due_date", { ascending: true });
  if (dueError) dbError(dueError);
  const dueOrOverdue = (due ?? []).filter((task: any) => openJobs.some((job) => job.id === task.job_id)).map((task: any) => ({ id: task.id as string, title: task.title as string, dueDate: task.due_date as string, overdue: task.due_date < today, ...label(task.job_id) }));

  // Delivered jobs keep open tasks (collect payment, credentials, feedback), so they count like active ones.
  const working = jobs.filter((job) => ["active", "delivered"].includes(job.stage));
  const next: Array<{ id: string; title: string; position: number; jobId: string; clientName: string; jobTitle: string; progress: string }> = [];
  if (working.length) {
    const { data: tasks, error } = await supabase.from("job_tasks").select("*").in("job_id", working.map((job) => job.id)).order("position", { ascending: true });
    if (error) dbError(error);
    for (const job of working) {
      const mine = (tasks ?? []).filter((task: any) => task.job_id === job.id);
      const open = mine.find((task: any) => task.status !== "done");
      if (open) next.push({ id: open.id, title: open.title, position: open.position, ...label(job.id), progress: `${mine.filter((task: any) => task.status === "done").length} / ${mine.length}` });
    }
  }

  // The approval date is when its quotation was last updated (approving is that update).
  const approvedIds = jobs.filter((job) => job.stage === "approved" && job.approvedQuotationId).map((job) => job.approvedQuotationId!);
  const approvedAt = new Map<string, string>();
  if (approvedIds.length) {
    const { data, error } = await supabase.from("documents").select("id, updated_at").in("id", approvedIds);
    if (error) dbError(error);
    for (const row of data ?? []) approvedAt.set(row.id, row.updated_at);
  }
  const awaitingAdvance = jobs.filter((job) => job.stage === "approved").map((job) => ({ ...label(job.id), amount: job.requiredAdvance ?? 0, daysWaiting: approvedAt.get(job.approvedQuotationId ?? "") ? daysSince(approvedAt.get(job.approvedQuotationId!)!, now) : 0 }));
  const balances = jobs.filter((job) => job.stage === "delivered" && job.money.outstanding > 0).map((job) => ({ ...label(job.id), amount: job.money.outstanding, daysWaiting: job.deliveredAt ? daysSince(job.deliveredAt, now) : 0 }));

  const quotationDays = settings.reminderSettings.quotationDays;
  const { data: sent, error: sentError } = await supabase.from("documents").select("*").eq("kind", "quotation").eq("status", "sent").not("sent_at", "is", null);
  if (sentError) dbError(sentError);
  const quotationsWaiting = (sent ?? []).map((row: any) => ({ id: row.id as string, number: row.number as string, total: Number(row.payload?.total ?? 0), daysWaiting: daysSince(row.sent_at, now), ...label(row.job_id) })).filter((row) => row.daysWaiting >= quotationDays && byId.get(row.jobId)?.stage !== "lost");

  const renewalsDue = (await listRenewals({ status: ["upcoming", "invoiced"], dueBefore: addDays(today, 30) })).map((renewal) => ({ ...renewal, daysUntil: daysBetween(today, renewal.dueDate), ...label(renewal.jobId) }));
  return { date: today, meetings, tasks: { dueOrOverdue, next }, moneyToChase: { awaitingAdvance, balances }, quotationsWaiting, renewalsDue };
}
