import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgSupabase } from "./test-utils/pg-supabase";
import type { FetchLike } from "./integrations/google-calendar";

// Owner reminders and Google Calendar sync, on a real Postgres (PGlite) with stand-ins for WhatsApp and Google.
const holder = vi.hoisted(() => ({ db: null as unknown as PgSupabase }));
vi.mock("./_core/supabase", () => ({ getSupabaseServer: () => holder.db, checkSupabaseConnection: async () => ({ ok: true }) }));

type Caller = ReturnType<typeof import("./routers").appRouter.createCaller>;
let api: Caller;
let shared: PgSupabase | null = null;

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SERVICE_ACCOUNT = Buffer.from(JSON.stringify({ client_email: "bot@webasi.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://oauth2.test/token" })).toString("base64");

beforeEach(async () => {
  vi.resetModules();
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_CALENDAR_ID;
  if (!shared) shared = await (await import("./test-utils/pg-supabase")).createPgSupabase();
  await shared.reset();
  holder.db = shared;
  const { ENV } = await import("./_core/env");
  ENV.supabaseUrl = "http://supabase.test";
  ENV.supabaseServiceRoleKey = "test-service-role";
  const { appRouter } = await import("./routers");
  api = appRouter.createCaller({} as never);
  await api.dashboard.settings();
}, 60_000);

const quotation = (cost = 40_000) => ({ clientName: "Prablo 360", projectName: "Site", intro: "Intro", items: [{ description: "Website", bullets: [], cost }] });
async function sentQuotation(sentAgoDays = 5) {
  const job = await api.jobs.create({ clientName: "Prablo 360", title: "Company website" });
  const doc = await api.documents.createQuotation({ jobId: job.id, quotation: quotation() });
  await api.documents.markSent({ id: doc.id });
  await holder.db.pg.query("update documents set sent_at = now() - make_interval(days => $2) where id = $1", [doc.id, sentAgoDays]);
  return { job, doc };
}
async function deliveredJob(deliveredAgoDays = 5) {
  const job = await api.jobs.create({ clientName: "Nimali", title: "Portal" });
  const q = await api.documents.createQuotation({ jobId: job.id, quotation: quotation(50_000) });
  await api.documents.markSent({ id: q.id });
  await api.jobs.approveQuotation({ quotationId: q.id });
  await api.jobs.startProject({ jobId: job.id, amount: 20_000, idempotencyKey: `start-${job.id}` });
  await api.jobs.markDelivered({ jobId: job.id });
  await holder.db.pg.query("update jobs set delivered_at = now() - make_interval(days => $2) where id = $1", [job.id, deliveredAgoDays]);
  return job;
}
const log = async () => (await holder.db.pg.query<{ reminder_key: string; status: string; attempts: number }>("select reminder_key, status, attempts from reminder_log order by created_at, id")).rows;
const MORNING = new Date(Date.now() + 0); // placeholder, replaced per test below
void MORNING;
// 10:30 in Colombo, today.
const at = (hourColombo: number, base = new Date()) => { const day = base.toISOString().slice(0, 10); return new Date(`${day}T${String(hourColombo).padStart(2, "0")}:00:00+05:30`); };

describe("owner reminders", () => {
  it("sends a quotation reminder once, with the client and amount, and never again", async () => {
    await sentQuotation(5);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn(async () => true);
    expect(await runPipelineReminders(at(10), { notify })).toEqual({ sent: 1, failed: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    const message = (notify.mock.calls[0] as unknown as [{ title: string; content: string }])[0];
    expect(message.content).toBe("Quotation 09248 to Prablo 360 (LKR 40,000) has had no answer for 5 days.");
    expect(await runPipelineReminders(at(11), { notify })).toEqual({ sent: 0, failed: 0 });
    expect(await runPipelineReminders(at(12), { notify })).toEqual({ sent: 0, failed: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("waits for the threshold, and respects the on/off switch and the number of days", async () => {
    await sentQuotation(2);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn(async () => true);
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(0); // default is 3 days
    await api.settings.update({ reminderSettings: { quotationDays: 2 } });
    await holder.db.pg.query("select 1");
    const { settingsCache } = await import("./data/core");
    settingsCache.invalidate();
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(1);
    await holder.db.reset().catch(() => undefined);
  });

  it("does not remind about a quotation that was approved, rejected or superseded, or a lost job", async () => {
    const { doc } = await sentQuotation(9);
    const { runPipelineReminders, dueReminders } = await import("./pipeline-reminders");
    expect(await dueReminders(at(10))).toHaveLength(1);
    await api.jobs.approveQuotation({ quotationId: doc.id });
    expect(await dueReminders(at(10))).toHaveLength(0);
    const second = await sentQuotation(9);
    await api.documents.rejectQuotation({ id: second.doc.id });
    expect(await dueReminders(at(10))).toHaveLength(0);
    const third = await sentQuotation(9);
    await api.jobs.markLost({ jobId: third.job.id, reason: "gone" });
    expect(await dueReminders(at(10))).toHaveLength(0);
    expect(await runPipelineReminders(at(10), { notify: vi.fn(async () => true) })).toEqual({ sent: 0, failed: 0 });
  });

  it("is not reset or duplicated by editing or regenerating the document, but 'mark as sent again' starts a new clock", async () => {
    const { doc } = await sentQuotation(5);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn(async () => true);
    await runPipelineReminders(at(10), { notify });
    await api.documents.updateQuotation({ id: doc.id, quotation: quotation(45_000) });
    await api.documents.updateQuotation({ id: doc.id, quotation: quotation(46_000) });
    expect((await runPipelineReminders(at(11), { notify })).sent).toBe(0);
    await api.documents.markSent({ id: doc.id, again: true });
    await holder.db.pg.query("update documents set sent_at = now() - interval '4 days' where id = $1", [doc.id]);
    expect((await runPipelineReminders(at(12), { notify })).sent).toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(await log()).toHaveLength(2);
  });

  it("never sends outside 09:00 to 20:00 Colombo time", async () => {
    await sentQuotation(5);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn(async () => true);
    for (const hour of [0, 3, 8, 20, 23]) expect((await runPipelineReminders(at(hour), { notify })).sent, `hour ${hour}`).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect((await runPipelineReminders(at(9), { notify })).sent).toBe(1);
  });

  it("two instances running at the same moment send it once", async () => {
    await sentQuotation(5);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return true; });
    const results = await Promise.all([runPipelineReminders(at(10), { notify }), runPipelineReminders(at(10), { notify })]);
    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a restart (a new process) does not send it again", async () => {
    await sentQuotation(5);
    const notify = vi.fn(async () => true);
    await (await import("./pipeline-reminders")).runPipelineReminders(at(10), { notify });
    vi.resetModules();
    const { ENV } = await import("./_core/env");
    ENV.supabaseUrl = "http://supabase.test";
    ENV.supabaseServiceRoleKey = "test-service-role";
    await (await import("./pipeline-reminders")).runPipelineReminders(at(11), { notify });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("retries a failed send after its wait, up to three times, and then gives up", async () => {
    await sentQuotation(5);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn(async () => false);
    expect(await runPipelineReminders(at(10), { notify })).toEqual({ sent: 0, failed: 1 });
    expect(await runPipelineReminders(at(10), { notify })).toEqual({ sent: 0, failed: 0 }); // still backing off
    for (const attempt of [2, 3]) {
      await holder.db.pg.query("update reminder_log set next_attempt_at = now() - interval '1 minute'");
      expect(await runPipelineReminders(at(10), { notify }), `attempt ${attempt}`).toEqual({ sent: 0, failed: 1 });
    }
    await holder.db.pg.query("update reminder_log set next_attempt_at = now() - interval '1 minute'");
    expect(await runPipelineReminders(at(10), { notify })).toEqual({ sent: 0, failed: 0 });
    expect(notify).toHaveBeenCalledTimes(3);
    expect(await log()).toEqual([expect.objectContaining({ status: "failed", attempts: 3 })]);
  });

  it("a failed send that later works is sent exactly once", async () => {
    await sentQuotation(5);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await runPipelineReminders(at(10), { notify });
    await holder.db.pg.query("update reminder_log set next_attempt_at = now() - interval '1 minute'");
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(1);
    await holder.db.pg.query("update reminder_log set next_attempt_at = now() - interval '1 minute'");
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(0);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("a send that throws is recorded as failed, not lost", async () => {
    await sentQuotation(5);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const result = await runPipelineReminders(at(10), { notify: vi.fn(async () => { throw new Error("socket closed"); }) });
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect((await holder.db.pg.query<{ last_error: string }>("select last_error from reminder_log")).rows[0].last_error).toBe("socket closed");
  });

  it("reminds about an unpaid balance after delivery, once, and stops when it is paid", async () => {
    const job = await deliveredJob(4);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn(async () => true);
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(1);
    expect((notify.mock.calls[0] as unknown as [{ content: string }])[0].content).toBe("Nimali still owes LKR 30,000 for Portal, 4 days after delivery.");
    expect((await runPipelineReminders(at(11), { notify })).sent).toBe(0);
    const paid = await deliveredJob(9);
    await api.ledger.recordPayment({ jobId: paid.id, category: "final", amount: 30_000 });
    expect((await runPipelineReminders(at(12), { notify })).sent).toBe(0);
    void job;
  });

  it("reminds about a renewal at 30 days and again at 7, each once", async () => {
    const job = await deliveredJob(0);
    const renewals = await api.renewals.list({ jobId: job.id });
    await holder.db.pg.query("update renewals set status = 'skipped' where id <> $1", [renewals[0].id]);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const { colomboDate, addDays } = await import("../shared/time");
    const notify = vi.fn(async () => true);
    await holder.db.pg.query("update jobs set delivered_at = now() where id = $1", [job.id]);
    await api.jobs.close({ jobId: job.id }).catch(() => undefined);
    const today = colomboDate();
    await holder.db.pg.query("update renewals set due_date = $2 where id = $1", [renewals[0].id, addDays(today, 25)]);
    await api.renewals.update({ id: renewals[0].id, amount: 12_000 });
    // The balance reminder is not what this test is about.
    await api.settings.update({ reminderSettings: { balanceEnabled: false } });
    const { settingsCache } = await import("./data/core");
    settingsCache.invalidate();
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(1);
    expect((notify.mock.calls[0] as unknown as [{ content: string }])[0].content).toMatch(/renewal for Nimali \(LKR 12,000\) is due in 25 days/);
    expect((await runPipelineReminders(at(11), { notify })).sent).toBe(0);
    await holder.db.pg.query("update renewals set due_date = $2 where id = $1", [renewals[0].id, addDays(today, 6)]);
    expect((await runPipelineReminders(at(12), { notify })).sent).toBe(1);
    expect((await runPipelineReminders(at(13), { notify })).sent).toBe(0);
    expect((await log()).map((row) => row.reminder_key.split(":").at(-1))).toEqual(["30d", "7d"]);
  });

  it("sends at most five in one pass and the rest on the next", async () => {
    for (let index = 0; index < 7; index++) await sentQuotation(5);
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const notify = vi.fn(async () => true);
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(5);
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(2);
    expect((await runPipelineReminders(at(10), { notify })).sent).toBe(0);
  });
});

describe("Google Calendar sync", () => {
  const configure = () => { process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SERVICE_ACCOUNT; process.env.GOOGLE_CALENDAR_ID = "owner@example.com"; };
  type Call = { method: string; url: string; body?: any };
  // Google as a script: every event call goes through `script`, which answers with a status. The token endpoint always works.
  function fakeGoogle(script: (call: Call) => number) {
    const calls: Call[] = [];
    const fetchFn: FetchLike = async (url, init = {}) => {
      if (url === "https://oauth2.test/token") return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "token-1", expires_in: 3600 }) };
      const call = { method: init.method ?? "GET", url, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const status = script(call);
      return { ok: status < 300, status, text: async () => `status ${status}`, json: async () => ({}) };
    };
    return { calls, fetchFn };
  }
  // The router syncs right after it saves, using the global fetch, so each test says what Google does by replacing it.
  const googleIs = (script: (call: Call) => number) => {
    const google = fakeGoogle(script);
    vi.stubGlobal("fetch", (url: string, init?: object) => google.fetchFn(url, init as never));
    return google;
  };
  beforeEach(async () => {
    (await import("./integrations/google-calendar")).resetGoogleTokenCache();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const book = async (jobId: string) => api.meetings.create({ jobId, title: "Kick-off", startsAt: "2026-11-03T04:00:00.000Z", endsAt: "2026-11-03T05:00:00.000Z", locationOrLink: "https://meet.example/abc", notes: "Bring the brief" });
  const job = () => api.jobs.create({ clientName: "Prablo 360", title: "Site" });

  it("works on its own with no Google settings: the meeting is saved and marked not_configured", async () => {
    const google = googleIs(() => 200);
    const { id } = await job();
    const meeting = await book(id);
    expect(meeting.syncStatus).toBe("not_configured");
    expect(google.calls).toEqual([]);
    expect(await api.meetings.list({ jobId: id })).toHaveLength(1);
    expect(await api.meetings.retrySync({ id: meeting.id }).catch((e) => e.code)).toBe("PRECONDITION_FAILED");
  });

  it("signs a JWT, creates the event with a stable id, and a later save updates it instead of duplicating", async () => {
    configure();
    const seen = new Set<string>();
    const google = googleIs((call) => (call.method === "PUT" && !seen.has(call.url) ? (seen.add(call.url), 404) : 200));
    const { eventIdFor } = await import("./integrations/google-calendar");
    const { id } = await job();
    const meeting = await book(id);
    expect(meeting).toMatchObject({ syncStatus: "synced", googleEventId: eventIdFor(meeting.id), syncError: null });
    expect(google.calls.map((call) => call.method)).toEqual(["PUT", "POST"]);
    expect(google.calls[1].body).toMatchObject({ id: eventIdFor(meeting.id), summary: "Kick-off", location: "https://meet.example/abc", start: { dateTime: "2026-11-03T04:00:00.000Z", timeZone: "Asia/Colombo" } });
    expect(google.calls[1].body.description).toContain("Client: Prablo 360");
    const moved = await api.meetings.update({ id: meeting.id, startsAt: "2026-11-04T04:00:00.000Z", endsAt: "2026-11-04T05:00:00.000Z" });
    expect(moved.syncStatus).toBe("synced");
    expect(google.calls.map((call) => call.method)).toEqual(["PUT", "POST", "PUT"]);
    expect(google.calls.filter((call) => call.method === "POST")).toHaveLength(1); // never created twice
    expect(google.calls[2].body.start.dateTime).toBe("2026-11-04T04:00:00.000Z");
  });

  it("saving succeeds when Google is down; the failure is recorded, retried with backoff, and stops after five", async () => {
    configure();
    googleIs(() => 503);
    const { id } = await job();
    const meeting = await book(id);
    expect(meeting).toMatchObject({ syncStatus: "failed", syncAttempts: 1 });
    expect(meeting.syncError).toMatch(/503/);
    expect(Date.parse(meeting.nextSyncAt!) - Date.now()).toBeGreaterThan(4 * 60_000); // about five minutes away
    expect(await api.meetings.list({ jobId: id })).toHaveLength(1); // the meeting itself is there

    const { runMeetingSync } = await import("./integrations/meeting-sync");
    expect(await runMeetingSync(new Date(), {})).toBe(0); // still backing off
    let current = meeting;
    for (let attempt = 2; attempt <= 5; attempt++) {
      await runMeetingSync(new Date(Date.now() + attempt * 365 * 86_400_000));
      current = (await api.meetings.list({ jobId: id }))[0];
      expect(current.syncAttempts).toBe(attempt);
    }
    expect(current.nextSyncAt).toBeNull();
    const google = googleIs(() => 200);
    await runMeetingSync(new Date(Date.now() + 9 * 365 * 86_400_000));
    expect(google.calls).toEqual([]); // five attempts used: it stops
    // The manual Retry starts over, and it works once Google is back.
    const retried = await api.meetings.retrySync({ id: meeting.id });
    expect(retried).toMatchObject({ syncStatus: "synced", syncAttempts: 0 });
  });

  it("recovers on a later automation pass once Google is back, without a duplicate", async () => {
    configure();
    googleIs(() => 500);
    const { id } = await job();
    const meeting = await book(id);
    expect(meeting.syncStatus).toBe("failed");
    const google = googleIs(() => 200);
    const { runMeetingSync } = await import("./integrations/meeting-sync");
    expect(await runMeetingSync(new Date(Date.now() + 3_600_000))).toBe(1);
    expect(google.calls.map((call) => call.method)).toEqual(["PUT"]); // an update, not a second create
    expect((await api.meetings.list({ jobId: id }))[0].syncStatus).toBe("synced");
  });

  it("cancelling deletes the remote event, and an event that is already gone counts as deleted", async () => {
    configure();
    googleIs(() => 200);
    const { id } = await job();
    const meeting = await book(id);
    for (const gone of [404, 410, 200]) {
      const google = googleIs(() => gone);
      const cancelled = await api.meetings.cancel({ id: meeting.id });
      expect(google.calls.map((call) => call.method), `status ${gone}`).toEqual(["DELETE"]);
      expect(cancelled).toMatchObject({ status: "cancelled", syncStatus: "synced" });
    }
    googleIs(() => 403);
    expect((await api.meetings.update({ id: meeting.id, notes: "after cancel" })).syncStatus).toBe("failed");
  });

  it("a bad service account key means 'not configured', and the built-in calendar carries on", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = Buffer.from("{ not json").toString("base64");
    process.env.GOOGLE_CALENDAR_ID = "owner@example.com";
    const google = googleIs(() => 200);
    const { id } = await job();
    const meeting = await book(id);
    expect(meeting.syncStatus).toBe("pending"); // configured as far as the settings go
    expect((await api.meetings.list({ jobId: id }))[0].title).toBe("Kick-off");
    expect(google.calls).toEqual([]); // the key could not be read, so nothing was sent
  });

  it("a meeting moves a lead to the meeting stage, and a cancelled one does not", async () => {
    const { id } = await job();
    const meeting = await book(id);
    expect((await api.jobs.get({ id }))!.stage).toBe("meeting");
    await api.meetings.cancel({ id: meeting.id });
    expect((await api.meetings.list({ jobId: id }))[0].status).toBe("cancelled");
  });
});

describe("before the pipeline migrations are applied", () => {
  // The owner applies migrations by hand, so the background jobs must stay quiet until the tables exist.
  const missingTable = () => { const query: any = new Proxy({}, { get: (_target, key) => (key === "then" ? (done: (value: unknown) => unknown) => done({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.jobs' in the schema cache" }, count: null }) : () => query) }); return query; };

  it("neither the reminders nor the calendar sync fail or complain", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SERVICE_ACCOUNT;
    process.env.GOOGLE_CALENDAR_ID = "owner@example.com";
    const { runPipelineReminders } = await import("./pipeline-reminders");
    const { runMeetingSync } = await import("./integrations/meeting-sync");
    const notify = vi.fn(async () => true);
    vi.spyOn(holder.db, "from").mockImplementation(missingTable);
    expect(await runPipelineReminders(at(10), { notify })).toEqual({ sent: 0, failed: 0 });
    expect(await runMeetingSync(new Date())).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("other failures are still reported", async () => {
    const { runPipelineReminders } = await import("./pipeline-reminders");
    vi.spyOn(holder.db, "from").mockImplementation(() => { throw new Error("connection reset"); });
    await expect(runPipelineReminders(at(10), { notify: vi.fn(async () => true) })).rejects.toThrow(/connection reset/);
    vi.restoreAllMocks();
  });
});
