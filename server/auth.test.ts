import { beforeEach, describe, expect, it } from "vitest";
import { ENV } from "./_core/env";
import { allowLoginAttempt, createSessionToken, isValidSessionToken, passwordMatches, SESSION_TTL_MS } from "./_core/auth";
import { appRouter } from "./routers";

describe("dashboard auth", () => {
  beforeEach(() => { ENV.dashboardPassword = "correct horse battery staple"; });

  it("accepts only the configured password", () => {
    expect(passwordMatches("correct horse battery staple")).toBe(true);
    expect(passwordMatches("wrong")).toBe(false);
    ENV.dashboardPassword = "";
    expect(passwordMatches("")).toBe(false);
  });

  it("rejects tampered, expired and password-rotated session tokens", () => {
    const now = Date.now();
    const token = createSessionToken(now);
    expect(isValidSessionToken(token, now)).toBe(true);
    expect(isValidSessionToken(token.replace(/.$/, (c) => (c === "0" ? "1" : "0")), now)).toBe(false);
    expect(isValidSessionToken(`${now + SESSION_TTL_MS * 2}.${token.split(".")[1]}`, now)).toBe(false);
    expect(isValidSessionToken(token, now + SESSION_TTL_MS + 1)).toBe(false);
    ENV.dashboardPassword = "rotated";
    expect(isValidSessionToken(token, now)).toBe(false);
  });

  it("limits login attempts per IP", () => {
    const results = Array.from({ length: 11 }, () => allowLoginAttempt("203.0.113.9", 1_000));
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results[10]).toBe(false);
    expect(allowLoginAttempt("203.0.113.9", 1_000 + 16 * 60 * 1000)).toBe(true);
  });

  it("blocks dashboard procedures without an owner session", async () => {
    const caller = appRouter.createCaller({ req: {} as any, res: {} as any, isOwner: false });
    await expect(caller.whatsapp.reset()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.dashboard.conversations()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.auth.me()).resolves.toEqual({ authenticated: false, configured: true });
  });
});
