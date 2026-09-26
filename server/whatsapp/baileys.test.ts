import { describe, expect, it, vi } from "vitest";
import { baileysStatusCode, createDebouncer, splitIntoBubbles, typingDelayMs, canSendBaileysMessage, normalizeBaileysPhone, resetBaileysStatus, shouldIgnoreBaileysMessage, startupFailureStatus } from "./baileys";

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
  it("returns to a clean disconnected state before pairing again", () => {
    expect(resetBaileysStatus()).toEqual({ status: "disconnected", lastError: undefined });
  });
  it("extracts status codes from Baileys error shapes", () => {
    expect(baileysStatusCode({ output: { statusCode: 401 } })).toBe(401);
    expect(baileysStatusCode({ statusCode: 403 })).toBe(403);
  });
});

describe("Inbound text debouncer", () => {
  it("flushes a burst of messages once, after the key goes quiet", () => {
    vi.useFakeTimers();
    const flushed: Array<[string, string[]]> = [];
    const debouncer = createDebouncer<string>((key, items) => flushed.push([key, items]), 1000);
    debouncer.push("a", "hi");
    vi.advanceTimersByTime(600);
    debouncer.push("a", "price?");
    debouncer.push("b", "hello");
    vi.advanceTimersByTime(999);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([["a", ["hi", "price?"]], ["b", ["hello"]]]);
    vi.useRealTimers();
  });
  it("take() returns pending items immediately and cancels the timer", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = createDebouncer<string>(onFlush, 1000);
    debouncer.push("a", "hi");
    expect(debouncer.take("a")).toEqual(["hi"]);
    vi.advanceTimersByTime(2000);
    expect(onFlush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("human-like sending", () => {
  it("splits replies into at most three bubbles at blank lines", () => {
    expect(splitIntoBubbles("Hi!")).toEqual(["Hi!"]);
    expect(splitIntoBubbles("One\n\nTwo\n\nThree\n\nFour")).toEqual(["One", "Two", "Three\n\nFour"]);
  });
  it("types for longer on longer messages, within limits", () => {
    expect(typingDelayMs("ok")).toBe(1500);
    expect(typingDelayMs("x".repeat(100))).toBe(4500);
    expect(typingDelayMs("x".repeat(1000))).toBe(7000);
  });
});
