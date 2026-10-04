import { describe, expect, it, vi } from "vitest";
import { faqEntriesFromModel, generateClientFaqs, instantAnswersFor, knowledgeFingerprint } from "./faq-generator";
import { matchFaqCache } from "./faq-cache";
import { approvedRestaurantProject } from "./project";

const project = approvedRestaurantProject;
const faq = (q: string, a: string, alt: string[] = []) => ({ q, alt, a });
const modelReply = (faqs: unknown[]) => ({ choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ faqs }) }, finish_reason: "stop" }] }) as any;

describe("client FAQ generation", () => {
  it("turns the model's list into entries the cache can match", async () => {
    const callModel = vi.fn().mockResolvedValue(modelReply([faq("How much does the package cost?", "The package is LKR 85,000.", ["price?", "what's the fee?"])]));
    const entries = await generateClientFaqs(project, { callModel });

    expect(entries).toEqual([{ question: "How much does the package cost?", alternatives: ["price?", "what's the fee?"], answer: "The package is LKR 85,000.", source: "generated" }]);
    expect(callModel).toHaveBeenCalledOnce();
    expect(callModel.mock.calls[0][0].messages[0].content).toContain("LKR 85,000");
  });

  it("drops answers that would not pass the engine's own checks", () => {
    const entries = faqEntriesFromModel(JSON.stringify({ faqs: [
      faq("How much is it?", "The package is LKR 60,000."),
      faq("How long does it take?", "It takes 5 business days."),
      faq("Is the result guaranteed?", "Yes, we guarantee top rankings."),
      faq("Do you do logos?", "Let me check that with a team agent."),
      faq("Can I get a discount?", "The price is LKR 85,000."),
      faq("How many revisions?", "**Two rounds** of revisions are included — after the first preview."),
    ] }), project);

    expect(entries.map((entry) => entry.question)).toEqual(["How many revisions?"]);
    expect(entries[0].answer).toBe("Two rounds of revisions are included, after the first preview.");
  });

  it("keeps the complete questions of a reply that was cut off", () => {
    const cutOff = `{"faqs": [{"q": "How much is it?", "alt": ["price?"], "a": "The package is LKR 85,000."}, {"q": "How long does it ta`;
    expect(faqEntriesFromModel(cutOff, project).map((entry) => entry.question)).toEqual(["How much is it?"]);
    expect(faqEntriesFromModel("Sorry, I cannot do that.", project)).toEqual([]);
  });
});

describe("instant answers for a project", () => {
  const entries = [{ question: "How much does the package cost?", alternatives: ["price?"], answer: "The package is LKR 85,000.", source: "generated" as const }];

  it("uses the generated FAQs while the knowledge they were written from is unchanged", () => {
    const current = { ...project, generatedFaqs: { factsHash: knowledgeFingerprint(project), generatedAt: "2026-10-04T00:00:00.000Z", entries } };
    expect(matchFaqCache("price?", instantAnswersFor(current))?.entry.answer).toBe("The package is LKR 85,000.");
  });

  it("stops using them once the project knowledge changes, but keeps the owner's FAQs", () => {
    const stale = { ...project, priceLkr: 95000, faqs: "Q: Do you provide hosting?\nA: Hosting is not included.", generatedFaqs: { factsHash: knowledgeFingerprint(project), generatedAt: "2026-10-04T00:00:00.000Z", entries } };
    const answers = instantAnswersFor(stale);
    expect(matchFaqCache("price?", answers)).toBeNull();
    expect(matchFaqCache("do you provide hosting?", answers)?.entry.answer).toBe("Hosting is not included.");
  });
});
