import { describe, expect, it, vi } from "vitest";
import { processWhatsAppMessage, type MessageProcessorDeps } from "./processor";
import type { ConversationSnapshot } from "../db";

// task.md Phase 8 scenarios that can be exercised without a live WhatsApp number.
const snapshot = (overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  clientId: "c1", waId: "94770001111", profileName: "Nimal", state: "collecting", isPaused: false,
  missingFields: ["deadline"], extractedFields: {}, recentMessages: [], ...overrides,
});
const text = (body: string, id = `wamid.${body}`) => ({ id, from: "94770001111", waId: "94770001111", profileName: "Nimal", type: "text", text: { body } }) as any;
const engineReply = (extra: Record<string, unknown> = {}) => ({ reply: "Sure!", extractedFields: {}, intent: "question", needsOwner: false, needsOwnerReason: null, reliedOnFacts: [], ...extra });

function harness(current: ConversationSnapshot, overrides: Partial<MessageProcessorDeps> = {}) {
  const saved: ConversationSnapshot[] = [];
  const notifyOwner = vi.fn().mockResolvedValue(true);
  const sendText = vi.fn().mockResolvedValue({ accepted: true, messageId: "out-1", parts: 1 });
  const runEngine = vi.fn().mockResolvedValue(engineReply());
  const deps: MessageProcessorDeps = {
    claimMessage: async () => true, getConversation: async () => current, saveConversation: async (value) => { saved.push(structuredClone(value)); },
    getUsageCounts: async () => ({ outboundWhatsApp: 0, geminiRequests: 0 }), incrementUsage: async () => undefined, recordEvent: async () => undefined,
    logMessage: async () => undefined, createOrder: async () => true, notifyOwner, sendText, runEngine, isOn: true, ...overrides,
  };
  return { deps, saved, notifyOwner, sendText, runEngine: deps.runEngine as ReturnType<typeof vi.fn> };
}

describe("Phase 8 scenarios", () => {
  it("owner takeover: a paused chat still records the client's message but WEBASI stays quiet", async () => {
    const h = harness(snapshot({ isPaused: true }));
    const result = await processWhatsAppMessage(text("hello?"), h.deps);
    expect(result.reason).toBe("conversation_paused");
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.saved[0]?.recentMessages.at(-1)).toMatchObject({ role: "client", text: "hello?" });
  });

  it("mid-chat OFF: messages are logged, the engine is not called", async () => {
    const h = harness(snapshot(), { isOn: false });
    const result = await processWhatsAppMessage(text("price?"), h.deps);
    expect(result.reason).toBe("automation_off");
    expect(h.runEngine).not.toHaveBeenCalled();
    expect(h.saved[0]?.recentMessages).toHaveLength(1);
  });

  it("duplicate delivery is ignored", async () => {
    const h = harness(snapshot(), { claimMessage: async () => false });
    expect((await processWhatsAppMessage(text("hi"), h.deps)).duplicate).toBe(true);
    expect(h.runEngine).not.toHaveBeenCalled();
  });

  it("AI rate limit: sends a holding reply, flags the chat for the owner and alerts them", async () => {
    const h = harness(snapshot(), { runEngine: vi.fn().mockRejectedValue(new Error("429 quota")) });
    const result = await processWhatsAppMessage(text("hi"), h.deps);
    expect(result.replied).toBe(true);
    expect(h.saved.at(-1)?.handedOver).toBe(true);
    expect(h.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("AI engine") }));
  });

  it("a frustrated client is handed to the owner", async () => {
    const h = harness(snapshot(), { runEngine: vi.fn().mockResolvedValue(engineReply({ sentiment: "frustrated" })) });
    await processWhatsAppMessage(text("why is nobody answering"), h.deps);
    expect(h.saved.at(-1)).toMatchObject({ handedOver: true, sentiment: "frustrated" });
    expect(h.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("frustrated") }));
  });

  it("alerts the owner once when a lead turns hot and keeps the client memory", async () => {
    const h = harness(snapshot({ intentScore: "medium" }), { runEngine: vi.fn().mockResolvedValue(engineReply({ intentScore: "high", clientNotes: "Cafe in Kandy, wants launch by May" })) });
    await processWhatsAppMessage(text("let's do it"), h.deps);
    expect(h.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("hot lead") }));
    expect(h.saved.at(-1)?.clientNotes).toBe("Cafe in Kandy, wants launch by May");

    const again = harness(snapshot({ intentScore: "high" }), { runEngine: vi.fn().mockResolvedValue(engineReply({ intentScore: "high" })) });
    await processWhatsAppMessage(text("ok"), again.deps);
    expect(again.notifyOwner).not.toHaveBeenCalled();
  });

  it("voice notes get a polite reply and are flagged for the owner", async () => {
    const h = harness(snapshot());
    await processWhatsAppMessage({ ...text(""), type: "audio", text: undefined }, h.deps);
    expect(h.sendText.mock.calls[0]?.[0].body).toMatch(/voice note/i);
    expect(h.saved.at(-1)).toMatchObject({ handedOver: true });
    expect(h.saved.at(-1)?.recentMessages.at(0)?.text).toBe("[Voice note]");
  });

  it("never answers from demo facts when no project is active", async () => {
    const h = harness(snapshot(), { runEngine: undefined });
    const result = await processWhatsAppMessage(text("hi"), h.deps);
    expect(result.reason).toBe("no_active_project");
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("replies go out humanized and the transcript keeps both sides", async () => {
    const h = harness(snapshot());
    await processWhatsAppMessage(text("do you do logos?"), h.deps);
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({ humanize: true }));
    expect(h.saved.at(-1)?.recentMessages.map((m) => m.role)).toEqual(["client", "assistant"]);
  });
});
