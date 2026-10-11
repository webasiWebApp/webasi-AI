import { describe, expect, it } from "vitest";

// A live check of the real key. It is opt-in (RUN_LIVE_PROVIDER_CHECKS=1 with GEMINI_API_KEY set) so the ordinary
// test run never calls Google with a production credential, and shows as skipped instead of passing without running.
const live = Boolean(process.env.RUN_LIVE_PROVIDER_CHECKS && process.env.GEMINI_API_KEY);

describe("Gemini project secret", () => {
  it.skipIf(!live)("authenticates against the Gemini models endpoint without exposing the key", async () => {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" } });
    expect(response.ok).toBe(true);
    const body = await response.json() as { models?: unknown[] };
    expect(Array.isArray(body.models)).toBe(true);
  }, 15000);
});
