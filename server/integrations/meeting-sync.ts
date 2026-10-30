import { isMissingSchema } from "../data/errors";
import { getJob } from "../data/jobs";
import { SYNC_MAX_ATTEMPTS, getMeeting, meetingsDueForSync, recordSyncResult, type Meeting } from "../data/meetings";
import { deleteEvent, readGoogleConfig, upsertEvent, type FetchLike } from "./google-calendar";

// Failed syncs wait 5, 10, 20, 40 minutes between attempts and stop after SYNC_MAX_ATTEMPTS; the Retry button starts over.
export const retryDelayMs = (attempts: number) => 5 * 60_000 * 2 ** Math.max(attempts - 1, 0);

// Sends one meeting to Google. A meeting without a google_event_id that is cancelled has nothing to delete remotely.
export async function syncMeeting(meeting: Meeting, options: { fetchFn?: FetchLike; now?: Date } = {}): Promise<Meeting> {
  const config = readGoogleConfig();
  if (!config) return meeting;
  const now = options.now ?? new Date();
  try {
    if (meeting.status === "cancelled") {
      await deleteEvent(config, meeting.id, options.fetchFn);
      await recordSyncResult(meeting.id, { ok: true, googleEventId: null });
    } else {
      const job = await getJob(meeting.jobId);
      const googleEventId = await upsertEvent(config, { ...meeting, clientName: job?.clientName, jobTitle: job?.title }, options.fetchFn);
      await recordSyncResult(meeting.id, { ok: true, googleEventId });
    }
  } catch (error) {
    const attempts = meeting.syncAttempts + 1;
    await recordSyncResult(meeting.id, { ok: false, error: error instanceof Error ? error.message : "Google Calendar sync failed", attempts, retryAt: attempts < SYNC_MAX_ATTEMPTS ? new Date(now.getTime() + retryDelayMs(attempts)).toISOString() : null });
  }
  return (await getMeeting(meeting.id)) ?? meeting;
}

export async function syncMeetingById(id: string, options: { fetchFn?: FetchLike; now?: Date } = {}) {
  const meeting = await getMeeting(id);
  return meeting ? syncMeeting(meeting, options) : null;
}

// The automation loop's share: everything pending, or failed with its backoff over.
export async function runMeetingSync(now = new Date(), options: { fetchFn?: FetchLike } = {}) {
  let done = 0;
  let pending: Meeting[];
  try { pending = await meetingsDueForSync(now); } catch (error) {
    if (isMissingSchema(error)) return 0; // the pipeline migrations have not been applied yet
    throw error;
  }
  for (const meeting of pending) {
    const result = await syncMeeting(meeting, { now, fetchFn: options.fetchFn });
    if (result.syncStatus === "synced") done++;
  }
  return done;
}
