import { beforeEach, describe, expect, it, vi } from "vitest";

// The follow-up run with its collaborators replaced: no database, no AI provider and no WhatsApp connection.
const state = vi.hoisted(() => ({
  settings: { webasiEnabled: true, followupsEnabled: true, shadowMode: false, whatsappMonthlyCap: 900, geminiDailyCap: 500, aiProvider: "groq" },
  chats: [] as Array<Record<string, unknown>>,
  usage: { outboundWhatsApp: 0, geminiRequests: 0 },
  connected: true,
  sendText: vi.fn(),
  draftFollowUp: vi.fn(),
  recordEvent: vi.fn(async (_event: { eventType: string }) => undefined),
  recordFollowUp: vi.fn(async () => true),
  incrementUsage: vi.fn(async () => undefined),
  notifyOwner: vi.fn(async (_alert: { title: string; content: string }) => true),
  reminderEvents: [] as Array<{ clientId: string | null; createdAt: string }>,
  lastEvents: {} as Record<string, Date>,
  deleteOlderThan: vi.fn(async (_table: string, _cutoff: Date) => 0),
}));

vi.mock("./module-db", () => ({
  getSettings: async () => state.settings,
  getActiveProject: async () => ({ projectKey: "mine" }),
  compileProjectSnapshot: async () => ({ id: "mine", packageName: "Site", priceLkr: 0, depositPercent: 0, timelineBusinessDays: "" }),
  listConversations: async () => state.chats,
  recordEvent: state.recordEvent,
  recordFollowUp: state.recordFollowUp,
  getWeeklyStats: async () => null,
  lastEventAt: async (eventType: string) => state.lastEvents[eventType] ?? null,
  eventsSince: async () => state.reminderEvents,
  deleteOlderThan: state.deleteOlderThan,
}));
vi.mock("./_core/notification", () => ({ notifyOwner: state.notifyOwner }));
vi.mock("./db", () => ({ getUsageCounts: async () => state.usage, incrementUsage: state.incrementUsage, logMessage: async () => undefined }));
vi.mock("./whatsapp/baileys", () => ({ baileysTransport: { isConnected: () => state.connected, sendText: state.sendText, sendToSelf: async () => true } }));
vi.mock("./conversations/engine", () => ({ draftFollowUp: state.draftFollowUp, modelForProvider: () => vi.fn() }));

const { runFollowUps, runHandoverReminders, runRetention, waitingOnOwner } = await import("./automation");
const { ENV } = await import("./_core/env");

// Monday 10:00 in Colombo.
const now = new Date("2026-09-28T04:30:00Z");
const quietChat = (overrides: Record<string, unknown> = {}) => ({
  clientId: "c1", waId: "94770001111", profileName: "Nimal Perera", state: "collecting", isPaused: false, handedOver: false, intentScore: "medium",
  lastClientMessageAt: new Date(now.getTime() - 8 * 3_600_000).toISOString(), followupSentAt: null, extractedFields: {}, clientNotes: "",
  recentMessages: JSON.stringify([{ role: "client", text: "how much?" }, { role: "assistant", text: "It depends on what you need." }]), ...overrides,
});
const events = () => state.recordEvent.mock.calls.map(([event]) => event.eventType);

beforeEach(() => {
  Object.assign(state.settings, { webasiEnabled: true, followupsEnabled: true, shadowMode: false, whatsappMonthlyCap: 900, geminiDailyCap: 500 });
  state.chats = [quietChat()];
  state.usage = { outboundWhatsApp: 0, geminiRequests: 0 };
  state.connected = true;
  state.sendText.mockReset().mockResolvedValue({ accepted: true, messageId: "out-1", parts: 1 });
  state.draftFollowUp.mockReset().mockResolvedValue("Hi Nimal, still thinking about the site?");
  state.recordEvent.mockClear();
  state.recordFollowUp.mockClear();
  state.incrementUsage.mockClear();
  state.notifyOwner.mockReset().mockResolvedValue(true);
  state.reminderEvents = [];
  state.lastEvents = {};
  state.deleteOlderThan.mockReset().mockResolvedValue(0);
  Object.assign(ENV, { handoverReminderHours: 2, eventLogRetentionDays: 0, messageRetentionDays: 0 });
});

describe("reminders for clients who are waiting on the owner", () => {
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const waitingChat = (overrides: Record<string, unknown> = {}) => quietChat({
    handedOver: true, needsOwner: true, lastClientMessageAt: hoursAgo(3),
    recentMessages: JSON.stringify([{ role: "assistant", text: "Let me check that with the team." }, { role: "client", text: "Any update on the price?" }]), ...overrides,
  });

  it("tells the owner once that a handed-over client has been waiting", async () => {
    state.chats = [waitingChat(), waitingChat({ clientId: "c2", profileName: "Kasun", isPaused: true, handedOver: false, needsOwner: false })];
    expect(await runHandoverReminders(now)).toBe(2);
    expect(state.notifyOwner).toHaveBeenCalledOnce();
    const alert = state.notifyOwner.mock.calls[0][0];
    expect(alert.title).toBe("WEBASI: 2 clients are still waiting for you");
    expect(alert.content).toContain("Nimal Perera, waiting about 3 h: \"Any update on the price?\"");
    expect(alert.content).toContain("Kasun");
    expect(events()).toEqual(["handover_reminder", "handover_reminder"]);
  });

  it("does not repeat itself for the same wait, and reminds again when the client writes and waits again", async () => {
    state.chats = [waitingChat()];
    state.reminderEvents = [{ clientId: "c1", createdAt: hoursAgo(1) }];
    expect(await runHandoverReminders(now)).toBe(0);
    expect(state.notifyOwner).not.toHaveBeenCalled();

    state.reminderEvents = [{ clientId: "c1", createdAt: hoursAgo(20) }];
    expect(await runHandoverReminders(now)).toBe(1);
    expect(state.notifyOwner.mock.calls[0][0].title).toBe("WEBASI: a client is still waiting for you");
  });

  it("leaves alone chats WEBASI is answering, chats where the owner spoke last, short waits and very old ones", () => {
    const base = { isPaused: false, handedOver: true, lastClientMessageAt: hoursAgo(3), recentMessages: [{ role: "client" }] };
    expect(waitingOnOwner(base, now, 2)).toBe(true);
    expect(waitingOnOwner({ ...base, handedOver: false }, now, 2)).toBe(false);
    expect(waitingOnOwner({ ...base, handedOver: false, isPaused: true }, now, 2)).toBe(true);
    expect(waitingOnOwner({ ...base, recentMessages: [{ role: "client" }, { role: "owner" }] }, now, 2)).toBe(false);
    expect(waitingOnOwner({ ...base, lastClientMessageAt: hoursAgo(1) }, now, 2)).toBe(false);
    expect(waitingOnOwner({ ...base, lastClientMessageAt: hoursAgo(100) }, now, 2)).toBe(false);
  });

  it("tries again on the next run when the reminder could not be delivered", async () => {
    state.chats = [waitingChat()];
    state.notifyOwner.mockResolvedValue(false);
    expect(await runHandoverReminders(now)).toBe(0);
    expect(state.recordEvent).not.toHaveBeenCalled();
  });

  it("stays quiet at night and when reminders are switched off", async () => {
    state.chats = [waitingChat({ lastClientMessageAt: new Date("2026-09-28T17:30:00Z").toISOString() })];
    expect(await runHandoverReminders(new Date("2026-09-28T20:30:00Z"))).toBe(0);
    ENV.handoverReminderHours = 0;
    state.chats = [waitingChat()];
    expect(await runHandoverReminders(now)).toBe(0);
    expect(state.notifyOwner).not.toHaveBeenCalled();
  });
});

describe("retention", () => {
  it("deletes nothing unless a retention period is configured", async () => {
    expect(await runRetention(now)).toBeNull();
    expect(state.deleteOlderThan).not.toHaveBeenCalled();
  });

  it("removes old records once a day and never cuts below the history the server itself reads", async () => {
    Object.assign(ENV, { eventLogRetentionDays: 90, messageRetentionDays: 5 });
    state.deleteOlderThan.mockImplementation(async (table: string) => (table === "event_log" ? 12 : 3));
    expect(await runRetention(now)).toEqual({ event_log: 12, messages: 3 });
    const cutoffs = Object.fromEntries(state.deleteOlderThan.mock.calls.map(([table, cutoff]) => [table, Math.round((now.getTime() - cutoff.getTime()) / 86_400_000)]));
    expect(cutoffs).toEqual({ event_log: 90, messages: 30 });
    expect(events()).toEqual(["retention_cleanup"]);

    state.deleteOlderThan.mockClear();
    state.lastEvents = { retention_cleanup: new Date(now.getTime() - 3 * 3_600_000) };
    expect(await runRetention(now)).toBeNull();
    expect(state.deleteOlderThan).not.toHaveBeenCalled();
  });
});

describe("follow-up run", () => {
  it("nudges a quiet client once and records it", async () => {
    expect(await runFollowUps(now)).toBe(1);
    expect(state.sendText).toHaveBeenCalledWith({ to: "94770001111", body: "Hi Nimal, still thinking about the site?", humanize: true });
    expect(state.recordFollowUp).toHaveBeenCalledWith("c1", "Hi Nimal, still thinking about the site?", now);
    expect(events()).toEqual(["follow_up_sent"]);
    expect(state.incrementUsage.mock.calls.map(([field]) => field)).toEqual(["geminiRequests", "outboundWhatsApp"]);
  });

  it("does nothing while WhatsApp is disconnected: no AI request, no failed-send entry in the event log", async () => {
    state.connected = false;
    expect(await runFollowUps(now)).toBe(0);
    expect(state.draftFollowUp).not.toHaveBeenCalled();
    expect(state.sendText).not.toHaveBeenCalled();
    expect(state.recordEvent).not.toHaveBeenCalled();
    expect(state.incrementUsage).not.toHaveBeenCalled();
  });

  it("only drafts in shadow mode, and marks the silence as handled", async () => {
    state.settings.shadowMode = true;
    state.connected = false; // a draft needs no connection
    expect(await runFollowUps(now)).toBe(0);
    expect(state.sendText).not.toHaveBeenCalled();
    expect(events()).toEqual(["shadow_draft"]);
    expect(state.recordFollowUp).toHaveBeenCalledWith("c1", null, now);
  });

  it("stays quiet when automation or follow-ups are off, outside sending hours, or at the monthly limit", async () => {
    state.settings.webasiEnabled = false;
    expect(await runFollowUps(now)).toBe(0);
    state.settings.webasiEnabled = true;
    state.settings.followupsEnabled = false;
    expect(await runFollowUps(now)).toBe(0);
    state.settings.followupsEnabled = true;
    expect(await runFollowUps(new Date("2026-09-28T20:30:00Z"))).toBe(0); // 02:00 in Colombo
    state.usage.outboundWhatsApp = 810;
    expect(await runFollowUps(now)).toBe(0);
    expect(state.sendText).not.toHaveBeenCalled();
  });

  it("falls back to the fixed wording when the AI limit is reached, without spending a request", async () => {
    state.usage.geminiRequests = 500;
    expect(await runFollowUps(now)).toBe(1);
    expect(state.draftFollowUp).not.toHaveBeenCalled();
    expect(state.sendText.mock.calls[0][0].body).toMatch(/^Hi Nimal, just following up/);
    expect(state.incrementUsage.mock.calls.map(([field]) => field)).toEqual(["outboundWhatsApp"]);
  });

  it("logs a failed send and leaves the chat due, so it is tried again", async () => {
    state.sendText.mockResolvedValue({ accepted: false, reason: "baileys_rate_limited" });
    expect(await runFollowUps(now)).toBe(0);
    expect(events()).toEqual(["send_failed"]);
    expect(state.recordFollowUp).not.toHaveBeenCalled();
  });
});
