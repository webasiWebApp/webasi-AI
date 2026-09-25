import { describe, expect, it } from "vitest";

describe("Gemini project secret", () => {
  it("authenticates against the Gemini models endpoint without exposing the key", async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey ?? "")}`);
    expect(response.ok).toBe(true);
    const body = await response.json() as { models?: unknown[] };
    expect(Array.isArray(body.models)).toBe(true);
  }, 15000);
});
