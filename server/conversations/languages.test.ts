import { describe, expect, it } from "vitest";
import { mergeReplyLanguages, replyLanguageFor } from "../../shared/languages";
import { buildSystemPrompt } from "./engine";
import { approvedRestaurantProject } from "./project";
import { buildFaqCache, matchFaqCache } from "./faq-cache";

describe("reply language switches", () => {
  it("treats a missing or all-off value as all on", () => {
    expect(mergeReplyLanguages(null)).toEqual({ english: true, singlish: true, sinhala: true });
    expect(mergeReplyLanguages({ english: false, singlish: false, sinhala: false })).toEqual({ english: true, singlish: true, sinhala: true });
    expect(mergeReplyLanguages({ sinhala: false })).toEqual({ english: true, singlish: true, sinhala: false });
  });

  it("falls back to the closest language that is on", () => {
    const englishOnly = { english: true, singlish: false, sinhala: false };
    expect(replyLanguageFor("singlish", englishOnly)).toBe("english");
    expect(replyLanguageFor("singlish", { english: true, singlish: false, sinhala: true })).toBe("sinhala");
    expect(replyLanguageFor("english", { english: false, singlish: true, sinhala: true })).toBe("singlish");
  });

  it("mirrors the client when every language is on, and restricts the prompt otherwise", () => {
    expect(buildSystemPrompt(approvedRestaurantProject, {})).toContain("Mirror the client");
    const prompt = buildSystemPrompt(approvedRestaurantProject, {}, { english: true, singlish: true, sinhala: false });
    expect(prompt).toContain("Reply ONLY in English or Singlish");
    expect(prompt).toContain("if the client writes in Sinhala, reply in Singlish");
    expect(prompt).not.toContain("Mirror the client");
  });

  it("does not send an instant answer in a language that is off", () => {
    const cache = buildFaqCache("Q: Do you provide hosting?\nA: Hosting is not included.");
    expect(matchFaqCache("do you provide hosting?", cache)?.entry.answer).toBe("Hosting is not included.");
    expect(matchFaqCache("do you provide hosting?", cache, { replyLanguages: { english: false, singlish: true, sinhala: true } })).toBeNull();
  });
});

describe("assistant voice", () => {
  it("signs in with the owner's chosen name and copies the owner's style lines", () => {
    const prompt = buildSystemPrompt(approvedRestaurantProject, {}, undefined, { assistantName: "Kasun", styleExamples: "Hi! Package eka LKR 25,000.\n\nDetails ewannada?\n" });
    expect(prompt).toContain("You are Kasun, chatting on WhatsApp");
    expect(prompt).toContain("Say your name (Kasun) once");
    expect(prompt).toContain("Never claim to be human");
    expect(prompt).toContain("- Hi! Package eka LKR 25,000.\n- Details ewannada?");
    expect(buildSystemPrompt(approvedRestaurantProject, {})).not.toContain("HOW THIS TEAM WRITES");
  });
});
