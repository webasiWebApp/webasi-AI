import { describe, expect, it } from "vitest";
import { ENV } from "../_core/env";

describe("Baileys session secret", () => {
  it("uses sufficient entropy when an environment secret is configured", () => {
    if (!ENV.baileysSessionEncryptionKey) return;
    expect(ENV.baileysSessionEncryptionKey.length).toBeGreaterThanOrEqual(32);
  });
});
