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
}));

vi.mock("./module-db", () => ({
  getSettings: async () => state.settings,
  getActiveProject: async () => ({ projectKey: "mine" }),
  compileProjectSnapshot: async () => ({ id: "mine", packageName: "Site", priceLkr: 0, depositPercent: 0, timelineBusinessDays: "" }),
  listConversations: async () => state.chats,
  recordEvent: state.recordEvent,
  recordFollowUp: state.recordFollowUp,
  getWeeklyStats: async () => null,
  lastEventAt: async () => null,
}));
vi.mock("./db", () => ({ getUsageCounts: async () => state.usage, incrementUsage: state.incrementUsage, logMessage: async () => undefined }));
vi.mock("./whatsapp/baileys", () => ({ baileysTransport: { isConnected: () => state.connected, sendText: state.sendText, sendToSelf: async () => true } }));
vi.mock("./conversations/engine", () => ({ draftFollowUp: state.draftFollowUp, modelForProvider: () => vi.fn() }));

const { runFollowUps } = await import("./automation");

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
