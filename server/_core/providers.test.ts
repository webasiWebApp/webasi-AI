import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "./env";
import { invokeGemini } from "./gemini";
import { invokeGroq } from "./groq";
import { RateLimitExceededError } from "./rate-limit";

// The provider clients against a stubbed fetch: no request leaves this machine and no real key is used.
const fetchMock = vi.fn();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const request = { messages: [{ role: "system" as const, content: "Be brief." }, { role: "user" as const, content: "hi" }], max_tokens: 100 };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  ENV.geminiApiKey = "test-gemini-key";
  ENV.groqApiKey = "test-groq-key";
});
afterEach(() => vi.unstubAllGlobals());

describe("Gemini client", () => {
  const answer = { candidates: [{ content: { parts: [{ text: '{"reply":"Hello"}' }] } }] };

  it("sends the API key in a header, never in the URL", async () => {
    fetchMock.mockResolvedValue(json(answer));
    const result = await invokeGemini({ ...request, model: "gemini-3-flash-preview" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("test-gemini-key");
    expect(String(url)).not.toContain("key=");
    expect(init.headers["x-goog-api-key"]).toBe("test-gemini-key");
    expect(result.choices[0]?.message.content).toBe('{"reply":"Hello"}');
  });

  it("asks again without the thinking level when the model does not take one", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: "Unknown field thinkingConfig" } }, 400)).mockResolvedValueOnce(json(answer));
    await invokeGemini({ ...request, model: "gemini-3-flash-preview" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).generationConfig.thinkingConfig).toBeUndefined();
  });

  it("reports a rate limit at once when asked to fail fast, so the backup provider can answer", async () => {
    fetchMock.mockResolvedValue(json({ error: { message: "Quota exceeded. Please retry in 30s" } }, 429));
    await expect(invokeGemini(request, { failFast: true })).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses to run without a key", async () => {
    ENV.geminiApiKey = "";
    await expect(invokeGemini(request)).rejects.toThrow("GEMINI_API_KEY is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Groq client", () => {
  it("asks gpt-oss for JSON with low reasoning effort", async () => {
    fetchMock.mockResolvedValue(json({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: '{"reply":"Hi"}' }, finish_reason: "stop" }] }));
    const result = await invokeGroq({ ...request, model: "gemini-3-flash-preview", response_format: { type: "json_schema", json_schema: { name: "turn", schema: { type: "object" } } } });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(init.headers.authorization).toBe("Bearer test-groq-key");
    expect(body).toMatchObject({ model: "openai/gpt-oss-120b", reasoning_effort: "low", response_format: { type: "json_object" }, max_tokens: 100 });
    expect(result.choices[0]?.message.content).toBe('{"reply":"Hi"}');
  });

  it("reports a rate limit at once when asked to fail fast", async () => {
    fetchMock.mockResolvedValue(json({ error: { message: "Rate limit reached for model" } }, 429, { "retry-after": "7" }));
    await expect(invokeGroq(request, { failFast: true })).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
