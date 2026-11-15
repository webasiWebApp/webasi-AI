import { describe, expect, it } from "vitest";
import { classifySmallTalk, smallTalkReply } from "./small-talk";

describe("small talk", () => {
  it("spots thanks, ok and goodbye in English, Singlish and Sinhala", () => {
    expect(classifySmallTalk("Thanks a lot!")).toBe("thanks");
    expect(classifySmallTalk("bohoma istuti 🙏")).toBe("thanks");
    expect(classifySmallTalk("ස්තුතියි")).toBe("thanks");
    expect(classifySmallTalk("ok")).toBe("ok");
    expect(classifySmallTalk("Hari hari")).toBe("ok");
    expect(classifySmallTalk("👍")).toBe("ok");
    expect(classifySmallTalk("ok thanks bye")).toBe("bye");
    expect(classifySmallTalk("Good night!")).toBe("bye");
  });

  it("leaves anything with content to the FAQ cache or the AI", () => {
    expect(classifySmallTalk("ok what is the price?")).toBeNull();
    expect(classifySmallTalk("ok send 2 samples")).toBeNull();
    expect(classifySmallTalk("thanks, can I send the logo later")).toBeNull();
    expect(classifySmallTalk("hi")).toBeNull();
    expect(classifySmallTalk("")).toBeNull();
  });

  it("says goodbye in the client's language unless that language is switched off", () => {
    const all = { english: true, singlish: true, sinhala: true };
    expect(smallTalkReply("singlish", all, () => 0)).toBe("Hari, passe katha karamu!");
    expect(smallTalkReply("singlish", { english: true, singlish: false, sinhala: false }, () => 0)).toBe("Sure, talk soon!");
    expect(smallTalkReply(null, all, () => 0.99)).toBe("Okay, take care!");
  });
});
