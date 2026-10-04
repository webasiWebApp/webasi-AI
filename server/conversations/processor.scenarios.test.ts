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

  it("a voice note gets a polite request to type, the owner is told, and WEBASI keeps answering typed messages", async () => {
    const h = harness(snapshot());
    await processWhatsAppMessage({ ...text(""), type: "audio", text: undefined }, h.deps);
    expect(h.sendText.mock.calls[0]?.[0].body).toMatch(/voice note/i);
    expect(h.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("voice note") }));
    expect(h.saved.at(-1)?.handedOver).toBeFalsy();
    expect(h.saved.at(-1)?.recentMessages.at(0)?.text).toBe("[Voice note]");
  });

  it("a second voice note straight after that request goes to the owner instead of repeating it", async () => {
    const first = harness(snapshot());
    await processWhatsAppMessage({ ...text("", "wamid.voice-1"), type: "audio", text: undefined }, first.deps);
    const second = harness(first.saved.at(-1)!);
    const result = await processWhatsAppMessage({ ...text("", "wamid.voice-2"), type: "audio", text: undefined }, second.deps);
    expect(result.reason).toBe("voice_note_handed_over");
    expect(second.sendText).not.toHaveBeenCalled();
    expect(second.saved.at(-1)).toMatchObject({ handedOver: true });
  });

  it("a failing event log or alert never costs the client their answer", async () => {
    const h = harness(snapshot(), { recordEvent: vi.fn().mockRejectedValue(new Error("event_log down")), notifyOwner: vi.fn().mockRejectedValue(new Error("alert down")), runEngine: vi.fn().mockResolvedValue(engineReply({ reply: "The package is ready in 14 days.", intentScore: "high" })) });
    const result = await processWhatsAppMessage(text("how long?"), h.deps);
    expect(result.replied).toBe(true);
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({ body: "The package is ready in 14 days." }));
    expect(h.saved.at(-1)?.handedOver).toBeFalsy();
  });

  it("starts the typing indicator before the AI is asked, and not at all when WEBASI stays quiet", async () => {
    const onReplying = vi.fn();
    const live = harness(snapshot(), { onReplying });
    await processWhatsAppMessage(text("do you do logos?"), live.deps);
    expect(onReplying).toHaveBeenCalledOnce();
    expect(onReplying.mock.invocationCallOrder[0]).toBeLessThan(live.runEngine.mock.invocationCallOrder[0]);

    const paused = harness(snapshot({ isPaused: true }), { onReplying: vi.fn() });
    await processWhatsAppMessage(text("anyone there?"), paused.deps);
    expect(paused.deps.onReplying).not.toHaveBeenCalled();
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
