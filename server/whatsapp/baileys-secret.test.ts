import { describe, expect, it } from "vitest";
import { ENV } from "../_core/env";

describe("Baileys session secret", () => {
  it("is configured with sufficient entropy material for encrypted session storage", () => {
    expect(ENV.baileysSessionEncryptionKey).toBeTruthy();
    expect(ENV.baileysSessionEncryptionKey.length).toBeGreaterThanOrEqual(32);
  });
});
