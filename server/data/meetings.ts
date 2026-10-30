import { getSupabaseServer } from "../_core/supabase";
import { hasDatabase } from "./core";
import { dbError, refuse, requireDb } from "./errors";
import { recordEvent } from "./events";
import { advanceToMeeting, getJob } from "./jobs";

export const SYNC_MAX_ATTEMPTS = 5;

export const mapMeeting = (row: any) => ({
  id: row.id as string, jobId: row.job_id as string, title: row.title as string, startsAt: row.starts_at as string, endsAt: row.ends_at as string,
  locationOrLink: (row.location_or_link ?? "") as string, notes: (row.notes ?? "") as string, status: row.status as "scheduled" | "done" | "cancelled",
  googleEventId: (row.google_event_id ?? null) as string | null, syncStatus: row.sync_status as "pending" | "synced" | "failed" | "not_configured",
  syncError: (row.sync_error ?? null) as string | null, syncAttempts: Number(row.sync_attempts ?? 0), nextSyncAt: (row.next_sync_at ?? null) as string | null,
});
export type Meeting = ReturnType<typeof mapMeeting>;

const supabase = () => getSupabaseServer();
export const googleConfigured = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CALENDAR_ID);

export async function listMeetings(filter: { jobId?: string; from?: string; to?: string } = {}): Promise<Meeting[]> {
  if (!hasDatabase()) return [];
  let query = supabase().from("meetings").select("*");
  if (filter.jobId) query = query.eq("job_id", filter.jobId);
  if (filter.from) query = query.gte("starts_at", filter.from);
  if (filter.to) query = query.lt("starts_at", filter.to);
  const { data, error } = await query.order("starts_at", { ascending: true }).limit(1000);
  if (error) dbError(error);
  return (data ?? []).map(mapMeeting);
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  if (!hasDatabase()) return null;
  const { data, error } = await supabase().from("meetings").select("*").eq("id", id).maybeSingle();
  if (error) dbError(error);
  return data ? mapMeeting(data) : null;
}

export type MeetingInput = { title: string; startsAt: string; endsAt: string; locationOrLink?: string; notes?: string };

function checkTimes(input: { startsAt: string; endsAt: string }) {
  if (Number.isNaN(Date.parse(input.startsAt)) || Number.isNaN(Date.parse(input.endsAt))) refuse("BAD_REQUEST", "Enter a valid start and end time.");
  if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) refuse("BAD_REQUEST", "The meeting must end after it starts.");
}

// Saving always succeeds on its own. The sync to Google Calendar is marked pending (or not_configured) here and done
// afterwards by syncMeeting, so a Google outage never blocks saving.
const syncFields = () => (googleConfigured() ? { sync_status: "pending", sync_error: null, sync_attempts: 0, next_sync_at: new Date().toISOString() } : { sync_status: "not_configured", sync_error: null, sync_attempts: 0, next_sync_at: null });

export async function createMeeting(jobId: string, input: MeetingInput): Promise<Meeting> {
  requireDb();
  checkTimes(input);
  const job = await getJob(jobId);
  if (!job) refuse("NOT_FOUND", "That job does not exist.");
  if (job.stage === "lost" || job.stage === "closed") refuse("PRECONDITION_FAILED", `A ${job.stage} job cannot get new meetings.`);
  const { data, error } = await supabase().from("meetings").insert({ job_id: jobId, title: input.title.trim(), starts_at: input.startsAt, ends_at: input.endsAt, location_or_link: input.locationOrLink ?? "", notes: input.notes ?? "", ...syncFields() }).select("*").single();
  if (error) dbError(error);
  await advanceToMeeting(jobId);
  await recordEvent({ eventType: "meeting_created", title: "Meeting booked", detail: `${job.clientName}: ${input.title.trim()} at ${input.startsAt}.`, clientId: job.conversationClientId ?? undefined });
  return mapMeeting(data);
}

export async function updateMeeting(id: string, patch: Partial<MeetingInput> & { status?: "scheduled" | "done" | "cancelled" }): Promise<Meeting> {
  requireDb();
  const current = await getMeeting(id);
  if (!current) refuse("NOT_FOUND", "That meeting does not exist.");
  const next = { startsAt: patch.startsAt ?? current.startsAt, endsAt: patch.endsAt ?? current.endsAt };
  checkTimes(next);
  const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.startsAt !== undefined) set.starts_at = patch.startsAt;
  if (patch.endsAt !== undefined) set.ends_at = patch.endsAt;
  if (patch.locationOrLink !== undefined) set.location_or_link = patch.locationOrLink;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.status !== undefined) set.status = patch.status;
  // Anything the calendar shows needs to reach Google again.
  if (patch.title !== undefined || patch.startsAt !== undefined || patch.endsAt !== undefined || patch.locationOrLink !== undefined || patch.notes !== undefined || patch.status !== undefined) Object.assign(set, syncFields());
  const { data, error } = await supabase().from("meetings").update(set).eq("id", id).select("*").single();
  if (error) dbError(error);
  if (patch.status === "cancelled") await recordEvent({ eventType: "meeting_cancelled", title: "Meeting cancelled", detail: `${current.title} (${current.startsAt}) was cancelled.` });
  return mapMeeting(data);
}

export const cancelMeeting = (id: string) => updateMeeting(id, { status: "cancelled" });
export const completeMeeting = (id: string) => updateMeeting(id, { status: "done" });

// A manual retry starts the attempts over.
export async function retryMeetingSync(id: string): Promise<Meeting> {
  requireDb();
  if (!googleConfigured()) refuse("PRECONDITION_FAILED", "Google Calendar is not set up on this server. The built-in calendar works on its own.");
  const { data, error } = await supabase().from("meetings").update({ sync_status: "pending", sync_error: null, sync_attempts: 0, next_sync_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
  if (error) dbError(error);
  if (!data) refuse("NOT_FOUND", "That meeting does not exist.");
  return mapMeeting(data);
}

export async function recordSyncResult(id: string, result: { ok: true; googleEventId: string | null } | { ok: false; error: string; attempts: number; retryAt: string | null }) {
  const set = result.ok
    ? { sync_status: "synced", sync_error: null, sync_attempts: 0, ...(result.googleEventId ? { google_event_id: result.googleEventId } : {}), next_sync_at: null }
    : { sync_status: "failed", sync_error: result.error.slice(0, 500), sync_attempts: result.attempts, next_sync_at: result.retryAt };
  const { error } = await supabase().from("meetings").update(set).eq("id", id);
  if (error) throw error;
}

// Meetings still waiting to reach Google: new or changed ones, and failed ones whose backoff has passed.
export async function meetingsDueForSync(now = new Date()): Promise<Meeting[]> {
  if (!hasDatabase() || !googleConfigured()) return [];
  const { data, error } = await supabase().from("meetings").select("*").in("sync_status", ["pending", "failed"]).lte("next_sync_at", now.toISOString()).limit(50);
  if (error) throw error;
  return (data ?? []).map(mapMeeting).filter((meeting) => meeting.syncAttempts < SYNC_MAX_ATTEMPTS);
}
