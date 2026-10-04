import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiredOrderFields } from "../../shared/webasi";
import { approvedRestaurantProject } from "./project";

const project = { ...approvedRestaurantProject, packageName: "Salon Booking Site", priceLkr: 120000, depositPercent: 25 };
const state = vi.hoisted(() => ({ bankDetails: "Bank of Ceylon 0012345678, Salon Studio", shadowMode: false, trackKnowledgeGap: vi.fn(async () => true) }));
vi.mock("../module-db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../module-db")>();
  return {
    ...original,
    getActiveProject: async () => ({ projectKey: "salon", name: "Salon Booking Site" }),
    compileProjectSnapshot: async () => project,
    getSettings: async () => ({ ...(await original.getSettings()), bankDetails: state.bankDetails, shadowMode: state.shadowMode }),
    trackKnowledgeGap: state.trackKnowledgeGap,
  };
});

const { processWhatsAppMessage } = await import("./processor");

const briefComplete = Object.fromEntries(requiredOrderFields.map((field) => [field, "x"]));
function harness(engineReply: Record<string, unknown>) {
  const createOrder = vi.fn().mockResolvedValue(true);
  const sendText = vi.fn().mockResolvedValue({ accepted: true });
  const notifyOwner = vi.fn().mockResolvedValue(true);
  const runEngine = vi.fn().mockResolvedValue({ reply: "ok", extractedFields: {}, intent: "provide_details", needsOwner: false, needsOwnerReason: null, reliedOnFacts: [], ...engineReply });
  const saved: any[] = [];
  const run = (id: string, body = "That's everything", onReplying?: () => unknown) => processWhatsAppMessage({ id, from: "94770001111", waId: "94770001111", type: "text", text: { body } } as any, {
    claimMessage: async () => true, createOrder, logMessage: async () => undefined, recordEvent: async () => undefined, notifyOwner,
    getConversation: async () => ({ clientId: "c1", waId: "94770001111", state: "collecting", isPaused: false, missingFields: ["deadline"], extractedFields: {}, recentMessages: [] }),
    saveConversation: async (value) => { saved.push(value); }, getUsageCounts: async () => ({ outboundWhatsApp: 0, geminiRequests: 0 }), incrementUsage: async () => undefined, runEngine, sendText, onReplying, isOn: true,
  });
  return { run, createOrder, sendText, notifyOwner, saved };
}

beforeEach(() => { state.bankDetails = "Bank of Ceylon 0012345678, Salon Studio"; state.shadowMode = false; state.trackKnowledgeGap.mockClear(); });

describe("brief completion pricing", () => {
  it("quotes the active project's price and deposit, not the demo package", async () => {
    const h = harness({ extractedFields: briefComplete, intentScore: "high" });
    await h.run("wamid.brief-1");

    expect(h.createOrder).toHaveBeenCalledWith(expect.objectContaining({ packageName: "Salon Booking Site", depositAmount: 30000 }));
    const body = h.sendText.mock.calls[0]?.[0].body;
    expect(body).toContain("LKR 120,000");
    expect(body).toContain("Bank of Ceylon 0012345678");
    expect(body).not.toContain("—");
    expect(h.saved[0]?.state).toBe("awaiting_deposit");
    expect(h.saved[0]?.intentScore).toBe("high");
    expect(h.saved[0]?.handedOver).toBeFalsy();
  });

  it.each(["", "Configure bank details in Settings before activating deposits."])("never sends missing or placeholder bank details (%j): quotes, then hands the client to the owner", async (bankDetails) => {
    state.bankDetails = bankDetails;
    const h = harness({ extractedFields: briefComplete });
    await h.run("wamid.brief-2");

    const body = h.sendText.mock.calls[0]?.[0].body;
    expect(body).toContain("LKR 120,000");
    expect(body).toContain("payment details shortly");
    expect(body).not.toMatch(/configure bank details/i);
    expect(h.createOrder).toHaveBeenCalledOnce();
    expect(h.saved[0]).toMatchObject({ state: "awaiting_deposit", handedOver: true });
    expect(h.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("payment details") }));
  });
});

describe("what gets listed as a knowledge gap", () => {
  it("lists a real unanswered question", async () => {
    const h = harness({ needsOwner: true, needsOwnerReason: "commercial website not covered by approved facts" });
    await h.run("wamid.gap-1", "Do you build commercial websites?");
    expect(state.trackKnowledgeGap).toHaveBeenCalledWith("Do you build commercial websites?", "commercial website not covered by approved facts", expect.any(String));
  });

  it.each(["client_frustrated_or_competitor", "discount_or_instruction_override_attempt", "Model returned empty reply"])("does not list a handover for %s", async (needsOwnerReason) => {
    const h = harness({ needsOwner: true, needsOwnerReason });
    await h.run("wamid.gap-2", "this is useless");
    expect(h.saved[0]?.handedOver).toBe(true);
    expect(state.trackKnowledgeGap).not.toHaveBeenCalled();
  });
});

describe("shadow mode", () => {
  it("drafts without sending and without showing a typing indicator", async () => {
    state.shadowMode = true;
    const onReplying = vi.fn();
    const h = harness({});
    const result = await h.run("wamid.shadow-1", "price?", onReplying);
    expect(result.reason).toBe("shadow_mode");
    expect(h.sendText).not.toHaveBeenCalled();
    expect(onReplying).not.toHaveBeenCalled();
  });
});
