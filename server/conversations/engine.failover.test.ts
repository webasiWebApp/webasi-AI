import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../_core/env";
import { createMinuteLimiter } from "../_core/rate-limit";

const providers = vi.hoisted(() => ({ gemini: vi.fn(), groq: vi.fn() }));
vi.mock("../_core/gemini", () => ({ invokeGemini: providers.gemini }));
vi.mock("../_core/groq", () => ({ invokeGroq: providers.groq }));

const { modelForProvider } = await import("./engine");

const answer = (text: string) => ({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
const request = { messages: [{ role: "user" as const, content: "hi" }] };

beforeEach(() => { providers.gemini.mockReset(); providers.groq.mockReset(); ENV.geminiApiKey = "gemini-key"; ENV.groqApiKey = "groq-key"; });

describe("provider failover", () => {
  it("uses only the chosen provider while it is healthy, and tells it to fail fast", async () => {
    providers.groq.mockResolvedValue(answer("from groq"));
    const result = await modelForProvider("groq")(request);
    expect(result.choices[0]?.message.content).toBe("from groq");
    expect(providers.groq).toHaveBeenCalledWith(request, { failFast: true });
    expect(providers.gemini).not.toHaveBeenCalled();
  });

  it("answers from the other provider when the chosen one is rate limited", async () => {
    providers.groq.mockRejectedValue(new Error("Rate limit reached"));
    providers.gemini.mockResolvedValue(answer("from gemini"));
    const result = await modelForProvider("groq")(request);
    expect(result.choices[0]?.message.content).toBe("from gemini");
  });

  it("fails over in the other direction too", async () => {
    providers.gemini.mockRejectedValue(new Error("quota"));
    providers.groq.mockResolvedValue(answer("from groq"));
    expect((await modelForProvider("gemini")(request)).choices[0]?.message.content).toBe("from groq");
  });

  it("has no backup when the other provider has no key, so the provider's own patient retries apply", async () => {
    ENV.geminiApiKey = "";
    providers.groq.mockRejectedValue(new Error("Rate limit reached"));
    await expect(modelForProvider("groq")(request)).rejects.toThrow("Rate limit reached");
    expect(providers.groq).toHaveBeenCalledWith(request);
    expect(providers.gemini).not.toHaveBeenCalled();
  });
});

describe("per-minute limiter", () => {
  it("lets a caller that will not wait know the window is full", async () => {
    const acquire = createMinuteLimiter(2);
    expect(await acquire({ wait: false })).toBe(true);
    expect(await acquire({ wait: false })).toBe(true);
    expect(await acquire({ wait: false })).toBe(false);
  });

  it("makes a patient caller wait for the oldest request to leave the window", async () => {
    vi.useFakeTimers();
    const acquire = createMinuteLimiter(1);
    await acquire();
    let granted = false;
    void acquire().then(() => { granted = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(granted).toBe(true);
    vi.useRealTimers();
  });
});
