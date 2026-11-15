import { describe, expect, it, vi } from "vitest";
import { processWhatsAppMessage } from "./processor";
import { buildTextMessagePayload, createWhatsAppSender, outboundCapAllows } from "./sender";
import type { ConversationSnapshot } from "../db";

const snapshot = (overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  clientId: "client_test_001",
  waId: "94770001111",
  profileName: "Nimal",
  state: "collecting",
  isPaused: false,
  missingFields: ["deadline"],
  extractedFields: {},
  recentMessages: [],
  ...overrides,
});

const message = (overrides: Record<string, unknown> = {}) => ({
  id: "wamid.processor-1",
  from: "94770001111",
  waId: "94770001111",
  profileName: "Nimal",
  type: "text",
  text: { body: "Can I send the logo later?" },
  ...overrides,
}) as any;

describe("WEBASI message processor", () => {
  it("routes a text turn through the engine and records the outbound reply", async () => {
    const current = snapshot();
    const saved: ConversationSnapshot[] = [];
    const sendText = vi.fn().mockResolvedValue({ accepted: true, messageId: "wamid.outbound-1" });
    const runEngine = vi.fn().mockResolvedValue({ reply: "Yes, you can send the logo later.", extractedFields: {}, intent: "question", needsOwner: false, needsOwnerReason: null, reliedOnFacts: ["requiredClientInputs"] });
    const result = await processWhatsAppMessage(message(), { claimMessage: async () => true, getConversation: async () => current, saveConversation: async (value) => { saved.push(value); }, getUsageCounts: async () => ({ outboundWhatsApp: 10, geminiRequests: 2 }), incrementUsage: async () => undefined, runEngine, sendText, isOn: true });

    expect(result.replied).toBe(true);
    expect(runEngine).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith({ to: "94770001111", body: "Yes, you can send the logo later.", humanize: true });
    expect(saved[0]?.recentMessages.at(-1)?.role).toBe("assistant");
  });

  it("handles an image as a slip only while awaiting deposit", async () => {
    const current = snapshot({ state: "awaiting_deposit" });
    const sendText = vi.fn().mockResolvedValue({ accepted: true });
    const saved: ConversationSnapshot[] = [];
    const result = await processWhatsAppMessage(message({ id: "wamid.slip-1", type: "image", text: undefined, image: { id: "media-1" } }), { claimMessage: async () => true, createOrder: async () => true, recordEvent: async () => undefined, notifyOwner: async () => true, getConversation: async () => current, saveConversation: async (value) => { saved.push(value); }, getUsageCounts: async () => ({ outboundWhatsApp: 10, geminiRequests: 2 }), incrementUsage: async () => undefined, sendText, isOn: true });

    expect(result.replied).toBe(true);
    expect(saved[0]?.state).toBe("slip_received");
    expect(sendText.mock.calls[0]?.[0].body).toContain("slip");
    expect(sendText.mock.calls[0]?.[0].body).not.toMatch(/payment is confirmed/i);
  });

  it("does not send when the monthly WhatsApp hard stop is reached", async () => {
    const sendText = vi.fn();
    const runEngine = vi.fn();
    const result = await processWhatsAppMessage(message({ id: "wamid.cap-1" }), { claimMessage: async () => true, getConversation: async () => snapshot(), saveConversation: async () => undefined, getUsageCounts: async () => ({ outboundWhatsApp: 810, geminiRequests: 2 }), incrementUsage: async () => undefined, runEngine, sendText, isOn: true });

    expect(result.replied).toBe(false);
    expect(result.reason).toBe("usage_guard_hard_stop");
    expect(runEngine).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("WhatsApp sender", () => {
  it("builds the official individual text payload", () => {
    expect(buildTextMessagePayload({ to: "94770001111", body: "Hello" })).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "94770001111", type: "text", text: { preview_url: false, body: "Hello" } });
  });

  it("uses the Graph API and returns the accepted message ID", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.sent-1" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await createWhatsAppSender({ fetchImpl, phoneNumberId: "phone-1", accessToken: "token-1", graphVersion: "v26.0" })({ to: "94770001111", body: "Hello" });
    expect(result).toEqual({ accepted: true, messageId: "wamid.sent-1" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://graph.facebook.com/v26.0/phone-1/messages");
  });

  it("enforces the 90 percent hard stop", () => {
    expect(outboundCapAllows(809, 900)).toBe(true);
    expect(outboundCapAllows(810, 900)).toBe(false);
  });
});

describe("small talk", () => {
  const deps = (overrides: Record<string, unknown>) => ({ claimMessage: async () => true, saveConversation: async () => undefined, getUsageCounts: async () => ({ outboundWhatsApp: 10, geminiRequests: 2 }), incrementUsage: async () => undefined, recordEvent: async () => undefined, isOn: true, ...overrides }) as any;

  it("reacts to 'thanks' instead of running the engine, once the chat has had a reply", async () => {
    const runEngine = vi.fn();
    const react = vi.fn().mockResolvedValue(true);
    const sendText = vi.fn();
    const current = snapshot({ recentMessages: [{ role: "client", text: "price?", at: "2026-11-14T10:00:00Z" }, { role: "assistant", text: "LKR 50,000.", at: "2026-11-14T10:00:05Z" }] });
    const result = await processWhatsAppMessage(message({ id: "wamid.thanks-1", text: { body: "Thanks a lot 🙏" } }), deps({ getConversation: async () => current, runEngine, react, sendText }));
    expect(result).toMatchObject({ replied: true, reason: "small_talk_reaction" });
    expect(react).toHaveBeenCalledWith({ to: "94770001111", emoji: "🙏" });
    expect(runEngine).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("still lets the engine greet a client whose first message is 'ok'", async () => {
    const runEngine = vi.fn().mockResolvedValue({ reply: "Hi! How can I help?", extractedFields: {}, intent: "greeting", needsOwner: false, needsOwnerReason: null, reliedOnFacts: [] });
    const react = vi.fn();
    const result = await processWhatsAppMessage(message({ id: "wamid.ok-1", text: { body: "ok" } }), deps({ getConversation: async () => snapshot(), runEngine, react, sendText: vi.fn().mockResolvedValue({ accepted: true }) }));
    expect(result.replied).toBe(true);
    expect(react).not.toHaveBeenCalled();
    expect(runEngine).toHaveBeenCalledOnce();
  });
});