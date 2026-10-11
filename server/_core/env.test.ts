import { describe, expect, it } from "vitest";
import { numberFromEnv } from "./env";
import { createWindowCounter } from "./http-guards";

describe("numeric settings from the environment", () => {
  it("uses the value when it is a usable number", () => {
    expect(numberFromEnv("12", 8)).toBe(12);
    expect(numberFromEnv(" 900 ", 500)).toBe(900);
  });

  it("falls back when the variable is unset, empty, not a number or below the minimum", () => {
    // An empty BAILEYS_RATE_LIMIT_PER_MINUTE used to become 0, which refused every outgoing message.
    for (const value of [undefined, "", "   ", "abc", "0", "-5", "NaN", "Infinity"]) expect(numberFromEnv(value, 8), String(value)).toBe(8);
    expect(numberFromEnv("0", 5, 0)).toBe(0);
  });
});

describe("request counter", () => {
  it("counts per key inside a window and starts again when it ends", () => {
    const counter = createWindowCounter(1000);
    expect(counter.hit("a", 0).count).toBe(1);
    expect(counter.hit("a", 500).count).toBe(2);
    expect(counter.hit("b", 500).count).toBe(1);
    expect(counter.peek("a", 999)).toBe(2);
    expect(counter.hit("a", 1000).count).toBe(1);
  });

  it("forgets keys whose window has ended, so it cannot grow without limit", () => {
    const counter = createWindowCounter(1000);
    for (let index = 0; index < 500; index++) counter.hit(`address-${index}`, 0);
    expect(counter.size()).toBe(500);
    counter.hit("later", 5000);
    expect(counter.size()).toBe(1);
  });
});
