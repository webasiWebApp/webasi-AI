import { describe, expect, it, vi } from "vitest";
import { processWhatsAppMessage, type MessageProcessorDeps } from "./processor";
import type { ConversationSnapshot, TranscriptMessage } from "../db";

// How a turn writes what happened: transcript messages one by one as they happen, drafts for review in shadow mode,
// and nothing lost when the transport fails.
const state = vi.hoisted(() => ({ shadowMode: false }));
vi.mock("../module-db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../module-db")>();
  return { ...original, getSettings: async () => ({ ...(await original.getSettings()), shadowMode: state.shadowMode }) };
});

const snapshot = (overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  clientId: "c1", waId: "94770001111", profileName: "Nimal", state: "collecting", isPaused: false,
  missingFields: ["deadline"], extractedFields: {}, recentMessages: [], ...overrides,
});
const text = (body: string) => ({ id: `wamid.${body}`, from: "94770001111", waId: "94770001111", profileName: "Nimal", type: "text", text: { body } }) as any;

function harness(current: ConversationSnapshot, overrides: Partial<MessageProcessorDeps> = {}) {
  const order: string[] = [];
  const appended: TranscriptMessage[] = [];
  const saved: ConversationSnapshot[] = [];
  const saveShadowDraft = vi.fn(async () => true);
  const deps: MessageProcessorDeps = {
    claimMessage: async () => true, getConversation: async () => current,
    saveConversation: async (value) => { order.push("save"); saved.push(structuredClone(value)); },
    appendMessage: async (_clientId, message) => { order.push(`append:${message.role}`); appended.push(message); },
    getUsageCounts: async () => ({ outboundWhatsApp: 0, geminiRequests: 0 }), incrementUsage: async () => undefined, recordEvent: async () => undefined,
    logMessage: async () => undefined, createOrder: async () => true, notifyOwner: async () => true, saveShadowDraft,
    sendText: vi.fn(async () => { order.push("send"); return { accepted: true, messageId: "out-1", parts: 1 }; }),
    runEngine: vi.fn(async () => { order.push("engine"); return { reply: "Sure, send it whenever.", extractedFields: {}, intent: "question" as const, needsOwner: false, needsOwnerReason: null, reliedOnFacts: [] }; }),
    isOn: true, ...overrides,
  };
  return { deps, order, appended, saved, saveShadowDraft };
}

describe("what a turn writes", () => {
  it("stores the client's message before the reply is written, and the reply once it has been sent", async () => {
    const h = harness(snapshot());
    await processWhatsAppMessage(text("Can I send the logo later?"), h.deps);
    expect(h.order).toEqual(["append:client", "engine", "send", "append:assistant", "save"]);
    expect(h.appended.map((message) => message.text)).toEqual(["Can I send the logo later?", "Sure, send it whenever."]);
  });

  it("stores the client's message even when WEBASI stays silent", async () => {
    for (const current of [snapshot({ isPaused: true }), snapshot({ handedOver: true })]) {
      const h = harness(current);
      await processWhatsAppMessage(text("hello?"), h.deps);
      expect(h.order).toEqual(["append:client", "save"]);
    }
  });

  it("keeps what it learned and stores no reply when the transport throws", async () => {
    const h = harness(snapshot(), { sendText: vi.fn(async () => { throw new Error("socket hang up"); }) });
    const result = await processWhatsAppMessage(text("price?"), h.deps);
    expect(result).toMatchObject({ accepted: true, replied: false, reason: "send_failed: socket hang up" });
    expect(h.appended.map((message) => message.role)).toEqual(["client"]);
    expect(h.saved).toHaveLength(1);
  });

  it("does not let a failed transcript write cost the client their answer", async () => {
    const h = harness(snapshot(), { appendMessage: vi.fn(async () => { throw new Error("database busy"); }) });
    const result = await processWhatsAppMessage(text("price?"), h.deps);
    expect(result.replied).toBe(true);
    expect(h.saved).toHaveLength(1);
  });
});

describe("shadow mode", () => {
  it("keeps the draft next to the message it answers, and sends and stores no reply", async () => {
    state.shadowMode = true;
    try {
      const h = harness(snapshot());
      const result = await processWhatsAppMessage(text("Can I send the logo later?"), h.deps);
      expect(result.reason).toBe("shadow_mode");
      expect(h.saveShadowDraft).toHaveBeenCalledWith({ clientId: expect.stringMatching(/^client_/), clientMessage: "Can I send the logo later?", draft: "Sure, send it whenever." });
      expect(h.order).toEqual(["append:client", "engine", "save"]);
    } finally {
      state.shadowMode = false;
    }
  });

  it("stores no draft when sending is on", async () => {
    const h = harness(snapshot());
    await processWhatsAppMessage(text("price?"), h.deps);
    expect(h.saveShadowDraft).not.toHaveBeenCalled();
  });
});
