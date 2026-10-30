import { notifyOwner } from "./_core/notification";
import { getSupabaseServer } from "./_core/supabase";
import { balanceReminderKey, quotationReminderKey, renewalReminderKey } from "../shared/reminders";
import { formatLkr } from "../shared/money";
import { daysBetween, daysSince, colomboDate, isCivilHour } from "../shared/time";
import { hasDatabase } from "./data/core";
import { claimReminder, finishReminder } from "./data/reminders";
import { listJobs } from "./data/jobs";
import { listRenewals } from "./data/renewals";
import { recordEvent } from "./data/events";
import { getSettings } from "./data/settings";
import { isMissingSchema } from "./data/errors";

// At most this many reminders go out in one pass, so a long backlog (the first run after a deploy) cannot flood the owner.
export const MAX_REMINDERS_PER_RUN = 5;

type Candidate = { key: string; kind: "quotation" | "balance" | "renewal"; subjectId: string; title: string; line: string; clientId?: string };

// What is due now, from the data alone. Whether it was already sent is the reminder log's business, not this function's.
export async function dueReminders(now = new Date()): Promise<Candidate[]> {
  if (!hasDatabase()) return [];
  const settings = await getSettings();
  const rules = settings.reminderSettings;
  const found: Candidate[] = [];
  const jobs = await listJobs();
  const byId = new Map(jobs.map((job) => [job.id, job]));

  if (rules.quotationEnabled) {
    const { data, error } = await getSupabaseServer().from("documents").select("*").eq("kind", "quotation").eq("status", "sent").not("sent_at", "is", null);
    if (error) throw error;
    for (const row of data ?? []) {
      const job = byId.get(row.job_id);
      const days = daysSince(row.sent_at, now);
      if (!job || job.stage === "lost" || days < rules.quotationDays) continue;
      found.push({ key: quotationReminderKey(row.id, row.sent_at), kind: "quotation", subjectId: row.id, title: "Quotation waiting", clientId: job.conversationClientId ?? undefined,
        line: `Quotation ${row.number} to ${job.clientName} (${formatLkr(row.payload?.total)}) has had no answer for ${days} day${days === 1 ? "" : "s"}.` });
    }
  }

  if (rules.balanceEnabled) {
    for (const job of jobs) {
      if (job.stage !== "delivered" || !job.deliveredAt || job.money.outstanding <= 0) continue;
      const days = daysSince(job.deliveredAt, now);
      if (days < rules.balanceDays) continue;
      found.push({ key: balanceReminderKey(job.id, job.deliveredAt), kind: "balance", subjectId: job.id, title: "Balance unpaid", clientId: job.conversationClientId ?? undefined,
        line: `${job.clientName} still owes ${formatLkr(job.money.outstanding)} for ${job.title}, ${days} day${days === 1 ? "" : "s"} after delivery.` });
    }
  }

  if (rules.renewalEnabled) {
    const today = colomboDate(now);
    for (const renewal of await listRenewals({ status: ["upcoming", "invoiced"], dueBefore: colomboDate(new Date(now.getTime() + 30 * 86_400_000)) })) {
      const job = byId.get(renewal.jobId);
      const daysUntil = daysBetween(today, renewal.dueDate);
      if (!job || daysUntil < 0) continue;
      const window = daysUntil <= 7 ? "7d" : "30d";
      found.push({ key: renewalReminderKey(renewal.id, renewal.dueDate, window), kind: "renewal", subjectId: renewal.id, title: "Renewal due", clientId: job.conversationClientId ?? undefined,
        line: `${renewal.kind[0].toUpperCase()}${renewal.kind.slice(1)} renewal for ${job.clientName} (${formatLkr(renewal.amount)}) is due ${daysUntil === 0 ? "today" : `in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`}.` });
    }
  }
  return found;
}

export type ReminderDeps = { notify?: typeof notifyOwner };

/**
 * Sends the reminders that are due, each at most once. A reminder is claimed in the database first (the first claimer
 * wins, even across restarts and across two server instances), then sent, then marked sent. A failed send is marked
 * failed and tried again later, up to three times, with a growing wait. Nothing goes out outside 09:00 to 20:00 in
 * Sri Lanka.
 */
export async function runPipelineReminders(now = new Date(), { notify = notifyOwner }: ReminderDeps = {}) {
  if (!isCivilHour(now)) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  let due: Candidate[];
  try { due = await dueReminders(now); } catch (error) {
    if (isMissingSchema(error)) return { sent: 0, failed: 0 }; // the pipeline migrations have not been applied yet
    throw error;
  }
  for (const reminder of due) {
    if (sent + failed >= MAX_REMINDERS_PER_RUN) break;
    if (!(await claimReminder(reminder.key, reminder.kind, reminder.subjectId))) continue;
    let delivered = false;
    let reason = "not delivered";
    try { delivered = await notify({ title: `WEBASI: ${reminder.title}`, content: reminder.line }); } catch (error) { reason = error instanceof Error ? error.message : "send failed"; }
    await finishReminder(reminder.key, delivered, delivered ? undefined : reason);
    if (delivered) {
      sent++;
      await recordEvent({ eventType: "pipeline_reminder", title: `Reminder sent: ${reminder.title}`, detail: reminder.line, clientId: reminder.clientId }).catch(() => undefined);
    } else failed++;
  }
  return { sent, failed };
}
