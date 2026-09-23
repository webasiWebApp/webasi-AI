import { describe, expect, it } from "vitest";
import { canSendBaileysMessage, normalizeBaileysPhone, shouldIgnoreBaileysMessage, startupFailureStatus } from "./baileys";

describe("Baileys transport safety helpers", () => {
  it("normalizes pairing numbers to digits with country code", () => {
    expect(normalizeBaileysPhone("+94 77-123-4567")).toBe("94771234567");
  });
  it("ignores owner echoes, groups, and status broadcasts", () => {
    expect(shouldIgnoreBaileysMessage("94771234567@s.whatsapp.net", true)).toBe(true);
    expect(shouldIgnoreBaileysMessage("123@g.us", false)).toBe(true);
    expect(shouldIgnoreBaileysMessage("status@broadcast", false)).toBe(true);
    expect(shouldIgnoreBaileysMessage("94771234567@s.whatsapp.net", false)).toBe(false);
  });
  it("enforces the per-minute cap and minimum inter-send interval", () => {
    const now = 100_000;
    expect(canSendBaileysMessage([], now, 2, 2500)).toBe(true);
    expect(canSendBaileysMessage([now - 1000], now, 2, 2500)).toBe(false);
    expect(canSendBaileysMessage([now - 3000, now - 4000], now, 2, 2500)).toBe(false);
    expect(canSendBaileysMessage([now - 3000], now, 2, 2500)).toBe(true);
  });
  it("surfaces startup authentication failures as reconnect-required without deleting state", () => {
    expect(startupFailureStatus(new Error("Unsupported state or unable to authenticate data"))).toEqual({ status: "reconnect_required", lastError: "Unsupported state or unable to authenticate data" });
  });
});
