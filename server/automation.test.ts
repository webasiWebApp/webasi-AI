import { describe, expect, it, vi } from "vitest";
import { buildWeeklySummary, dueForFollowUp, fallbackFollowUp, isSendingHours, weeklySummaryDue, type FollowUpCandidate } from "./automation";
import { draftFollowUp } from "./conversations/engine";
import { approvedRestaurantProject } from "./conversations/project";

// 2026-09-28 is a Monday. Sri Lanka is UTC+05:30, so 04:30Z = 10:00 in Colombo.
const now = new Date("2026-09-28T04:30:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const chat = (overrides: Partial<FollowUpCandidate> = {}): FollowUpCandidate => ({
  isPaused: false, handedOver: false, state: "collecting", intentScore: "medium", lastClientMessageAt: hoursAgo(8), followupSentAt: null,
  recentMessages: [{ role: "client", text: "how much?" }, { role: "assistant", text: "It's LKR 85,000. What's your deadline?" }], ...overrides,
});

describe("follow-ups", () => {
  it("nudges a client who went quiet after WEBASI's last message", () => {
    expect(dueForFollowUp(chat(), now)).toBe(true);
    expect(dueForFollowUp(chat({ state: "awaiting_deposit" }), now)).toBe(true);
  });

  it("waits at least 6 hours and stays inside the 24-hour window", () => {
    expect(dueForFollowUp(chat({ lastClientMessageAt: hoursAgo(2) }), now)).toBe(false);
    expect(dueForFollowUp(chat({ lastClientMessageAt: hoursAgo(30) }), now)).toBe(false);
  });

  it("sends only one follow-up per silence", () => {
    expect(dueForFollowUp(chat({ followupSentAt: hoursAgo(1) }), now)).toBe(false);
    expect(dueForFollowUp(chat({ followupSentAt: hoursAgo(20), lastClientMessageAt: hoursAgo(8) }), now)).toBe(true);
  });

  it("never nudges paused, handed-over, low-fit or finished chats, or when the client spoke last", () => {
    expect(dueForFollowUp(chat({ isPaused: true }), now)).toBe(false);
    expect(dueForFollowUp(chat({ handedOver: true }), now)).toBe(false);
    expect(dueForFollowUp(chat({ intentScore: "low" }), now)).toBe(false);
    expect(dueForFollowUp(chat({ state: "confirmed_by_owner" }), now)).toBe(false);
    expect(dueForFollowUp(chat({ recentMessages: [{ role: "client", text: "ok" }] }), now)).toBe(false);
  });

  it("only messages clients between 9am and 8pm Sri Lanka time", () => {
    expect(isSendingHours(new Date("2026-09-28T03:30:00Z"))).toBe(true); // 09:00
    expect(isSendingHours(new Date("2026-09-28T03:29:00Z"))).toBe(false); // 08:59
    expect(isSendingHours(new Date("2026-09-28T14:29:00Z"))).toBe(true); // 19:59
    expect(isSendingHours(new Date("2026-09-28T14:30:00Z"))).toBe(false); // 20:00
  });

  it("has a friendly fallback that fits the order stage", () => {
    expect(fallbackFollowUp("awaiting_deposit", "Nimal Perera")).toMatch(/^Hi Nimal,.*deposit/);
    expect(fallbackFollowUp("collecting", null)).toMatch(/^Hi,.*/);
  });

  it("rejects AI follow-ups that invent prices or escalate", async () => {
    const reply = (content: object) => vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(content) } }] });
    const base = { project: approvedRestaurantProject, recentMessages: [], orderState: "collecting" as const };
    expect(await draftFollowUp({ ...base, callModel: reply({ reply: "Hi! Still keen on the site? 🙂" }) })).toBe("Hi! Still keen on the site? 🙂");
    expect(await draftFollowUp({ ...base, callModel: reply({ reply: "I can do it for LKR 60,000 today!" }) })).toBeNull();
    expect(await draftFollowUp({ ...base, callModel: reply({ reply: "" }) })).toBeNull();
    expect(await draftFollowUp({ ...base, callModel: vi.fn().mockRejectedValue(new Error("429")) })).toBeNull();
  });
});

describe("weekly summary", () => {
  it("is due on Monday from 9am Sri Lanka time, once a week", () => {
    expect(weeklySummaryDue(now, null)).toBe(true);
    expect(weeklySummaryDue(new Date("2026-09-28T03:00:00Z"), null)).toBe(false); // Monday 08:30
    expect(weeklySummaryDue(new Date("2026-09-29T04:30:00Z"), null)).toBe(false); // Tuesday
    expect(weeklySummaryDue(now, hoursAgo(1))).toBe(false);
    expect(weeklySummaryDue(now, hoursAgo(7 * 24))).toBe(true);
  });

  it("reads like a short WhatsApp report", () => {
    const text = buildWeeklySummary({ activeChats: 12, newChats: 5, hotLeads: 1, frustrated: 0, handovers: 3, messagesIn: 80, messagesOut: 75, ordersCreated: 2, slipsWaiting: 1, confirmedOrders: 1, confirmedDeposits: 34000, followUpsSent: 4, knowledgeAdded: 2, learnedAnswersPending: 1, topObjections: [["price", 4], ["thinking_it_over", 2]] }, { outboundWhatsApp: 300 }, { whatsappMonthlyCap: 900 });
    expect(text).toContain("12 active chats (5 new)");
    expect(text).toContain("1 hot lead ·");
    expect(text).toContain("LKR 34,000 deposits");
    expect(text).toContain("1 slip to verify");
    expect(text).toContain("price (4), thinking it over (2)");
    expect(text).toContain("1 learned answer waiting");
    expect(text).not.toContain("frustrated");
  });
});
