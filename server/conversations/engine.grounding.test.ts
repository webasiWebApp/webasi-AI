import { describe, expect, it, vi } from "vitest";
import { createConversationEngine, validateGroundedReply } from "./engine";
import { approvedRestaurantProject } from "./project";

// A project like the one in live use: trained, but with no price, deposit or timeline in its facts.
const unpriced = { ...approvedRestaurantProject, priceLkr: 0, depositPercent: 0, timelineBusinessDays: "Not specified", paymentTerms: "Full payment on delivery.", faqs: "Q: Extra page?\nA: Each extra page is LKR 5,000." };
const valid = (reply: string, project = approvedRestaurantProject) => validateGroundedReply(reply, project).valid;

describe("grounding check: what counts as a quoted price", () => {
  it("does not take a word ending in 'rs' followed by a number for a rupee amount", () => {
    expect(valid("The package covers 5 pages and offers 3 design options.")).toBe(true);
    expect(valid("We have built sites for restaurants and bars 12 times.")).toBe(true);
  });

  it("checks an amount written with the currency after it, or in Sinhala script", () => {
    for (const reply of ["The package is 60,000 LKR.", "It is 60000 rupees in total.", "That would be 60,000/-", "මිල රු. 60,000 යි.", "LKR60,000 all in.", "Rs60000 only.", "Around Rs. 60k."]) expect(valid(reply), reply).toBe(false);
    for (const reply of ["The package is 85,000 LKR.", "It is 85000 rupees in total.", "මිල රු. 85,000 යි.", "Rs.85,000 for the package.", "LKR85,000 all in.", "Rs 85k for the package."]) expect(valid(reply), reply).toBe(true);
  });

  it("reads a number next to a quoted price as part of the sentence, not as a second price", () => {
    expect(valid("For 5 pages LKR 85,000 covers everything.")).toBe(true);
  });
});

describe("grounding check: projects that state no price or deposit", () => {
  it("blocks an invented price", () => {
    expect(validateGroundedReply("It will be LKR 50,000 for the website.", unpriced)).toEqual({ valid: false, reason: "reply_contains_unapproved_price" });
    expect(valid("The price depends on what you need, the team will go through it with you.", unpriced)).toBe(true);
  });

  it("blocks an invented percentage, such as a discount", () => {
    expect(validateGroundedReply("I can give you a 10% discount.", unpriced)).toEqual({ valid: false, reason: "reply_contains_unapproved_percentage" });
  });

  it("still allows a price the owner put in an approved FAQ", () => {
    expect(valid("Each extra page is LKR 5,000.", unpriced)).toBe(true);
  });

  it("hands the chat to the owner when the model keeps inventing a price", async () => {
    const callModel = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ reply: "A business website is LKR 45,000.", extractedFields: {}, intent: "question", needsOwner: false, needsOwnerReason: null, reliedOnFacts: [] }) } }] });
    const result = await createConversationEngine({ project: unpriced, callModel }).runTurn({ clientId: "c1", state: "collecting", missingFields: [], recentMessages: [], incomingText: "How much is a website?", isOn: true, withinCustomerWindow: true, monthlyOutbound: 0, monthlyCap: 900 });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ needsOwner: true, needsOwnerReason: "grounding_or_scope_check_failed" });
    expect(result.reply).not.toContain("45,000");
  });
});
