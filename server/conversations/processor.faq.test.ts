import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../db";
import { approvedRestaurantProject } from "./project";
import { knowledgeFingerprint } from "./faq-generator";

const project = {
  ...approvedRestaurantProject,
  generatedFaqs: {
    factsHash: knowledgeFingerprint(approvedRestaurantProject),
    generatedAt: "2026-10-04T00:00:00.000Z",
    entries: [
      { question: "How much does the package cost?", alternatives: ["price?", "what's the fee?"], answer: "The package is LKR 85,000.", source: "generated" as const },
      { question: "How many revisions are included?", alternatives: ["revisions?"], answer: "Two rounds of revisions are included.", source: "generated" as const },
    ],
  },
};

vi.mock("../module-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module-db")>()),
  getActiveProject: async () => ({ projectKey: project.id }),
  compileProjectSnapshot: async () => project,
}));

const { processWhatsAppMessage } = await import("./processor");

const snapshot = (overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  clientId: "c1", waId: "94770001111", profileName: "Nimal", state: "collecting", isPaused: false,
  missingFields: ["deadline"], extractedFields: {}, recentMessages: [], ...overrides,
});
const text = (body: string) => ({ id: `wamid.${body}`, from: "94770001111", waId: "94770001111", profileName: "Nimal", type: "text", text: { body } }) as any;

function harness(current: ConversationSnapshot, geminiRequests = 0) {
  const sendText = vi.fn().mockResolvedValue({ accepted: true, messageId: "out-1", parts: 1 });
  const runEngine = vi.fn().mockResolvedValue({ reply: "From the engine.", extractedFields: {}, intent: "question", needsOwner: false, needsOwnerReason: null, reliedOnFacts: [] });
  const incrementUsage = vi.fn().mockResolvedValue(undefined);
  const recordEvent = vi.fn().mockResolvedValue(undefined);
  const deps = {
    claimMessage: async () => true, getConversation: async () => current, saveConversation: async () => undefined,
    getUsageCounts: async () => ({ outboundWhatsApp: 0, geminiRequests }), incrementUsage, recordEvent,
    logMessage: async () => undefined, createOrder: async () => true, notifyOwner: async () => true, sendText, runEngine, isOn: true,
  };
  return { deps, sendText, runEngine, incrementUsage, recordEvent };
}

describe("FAQ fast path", () => {
  it("answers a known question from the FAQs without calling the engine or spending an AI request", async () => {
    const h = harness(snapshot());
    const result = await processWhatsAppMessage(text("How many revisions do I get?"), h.deps);

    expect(result.replied).toBe(true);
    expect(h.sendText).toHaveBeenCalledWith({ to: "94770001111", body: "Two rounds of revisions are included.", humanize: true });
    expect(h.runEngine).not.toHaveBeenCalled();
    expect(h.incrementUsage).not.toHaveBeenCalledWith("geminiRequests");
    expect(h.recordEvent.mock.calls.map(([event]) => event.eventType)).toContain("faq_cache_hit");
  });

  it("asks whether the price works when the instant answer states it, until the client has said", async () => {
    const first = harness(snapshot());
    await processWhatsAppMessage(text("What is the price?"), first.deps);
    expect(first.sendText).toHaveBeenCalledWith({ to: "94770001111", body: "The package is LKR 85,000.\n\nDoes that work for your budget?", humanize: true });

    const answered = harness(snapshot({ extractedFields: { priceOk: "yes" } }));
    await processWhatsAppMessage(text("What is the price?"), answered.deps);
    expect(answered.sendText).toHaveBeenCalledWith({ to: "94770001111", body: "The package is LKR 85,000.", humanize: true });
  });

  it("still answers known questions after the daily AI limit is reached", async () => {
    const h = harness(snapshot(), 100_000);
    expect((await processWhatsAppMessage(text("price?"), h.deps)).replied).toBe(true);
    expect((await processWhatsAppMessage(text("Can I send the logo later?"), h.deps)).reason).toBe("usage_guard_hard_stop");
  });

  it("sends everything else to the engine", async () => {
    for (const body of ["Can I send the logo later?", "price eka kiyada?", "can you reduce the price", "Hi"]) {
      const h = harness(snapshot());
      await processWhatsAppMessage(text(body), h.deps);
      expect(h.runEngine, body).toHaveBeenCalledOnce();
      expect(h.sendText, body).toHaveBeenCalledWith({ to: "94770001111", body: "From the engine.", humanize: true });
    }
  });

  it("leaves a client who is past the questions stage to the engine", async () => {
    const h = harness(snapshot({ state: "awaiting_deposit" }));
    await processWhatsAppMessage(text("What is the price?"), h.deps);
    expect(h.runEngine).toHaveBeenCalledOnce();
  });
});
