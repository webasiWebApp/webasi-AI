import { describe, expect, it, vi } from "vitest";
import { requiredOrderFields } from "../../shared/webasi";
import { approvedRestaurantProject } from "./project";

const project = { ...approvedRestaurantProject, packageName: "Salon Booking Site", priceLkr: 120000, depositPercent: 25 };
vi.mock("../module-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../module-db")>()),
  getActiveProject: async () => ({ projectKey: "salon", name: "Salon Booking Site" }),
  compileProjectSnapshot: async () => project,
}));

const { processWhatsAppMessage } = await import("./processor");

describe("brief completion pricing", () => {
  it("quotes the active project's price and deposit, not the demo package", async () => {
    const createOrder = vi.fn().mockResolvedValue(true);
    const sendText = vi.fn().mockResolvedValue({ accepted: true });
    const extractedFields = Object.fromEntries(requiredOrderFields.map((field) => [field, "x"]));
    const runEngine = vi.fn().mockResolvedValue({ reply: "ok", extractedFields, intent: "provide_details", needsOwner: false, needsOwnerReason: null, reliedOnFacts: [], intentScore: "high" });
    const saved: any[] = [];
    await processWhatsAppMessage({ id: "wamid.brief-1", from: "94770001111", waId: "94770001111", type: "text", text: { body: "That's everything" } } as any, {
      claimMessage: async () => true, createOrder, logMessage: async () => undefined, recordEvent: async () => undefined,
      getConversation: async () => ({ clientId: "c1", waId: "94770001111", state: "collecting", isPaused: false, missingFields: ["deadline"], extractedFields: {}, recentMessages: [] }),
      saveConversation: async (value) => { saved.push(value); }, getUsageCounts: async () => ({ outboundWhatsApp: 0, geminiRequests: 0 }), incrementUsage: async () => undefined, runEngine, sendText, isOn: true,
    });

    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ packageName: "Salon Booking Site", depositAmount: 30000 }));
    expect(sendText.mock.calls[0]?.[0].body).toContain("LKR 120,000");
    expect(saved[0]?.state).toBe("awaiting_deposit");
    expect(saved[0]?.intentScore).toBe("high");
  });
});
