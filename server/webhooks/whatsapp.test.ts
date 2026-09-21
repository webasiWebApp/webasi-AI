import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractWhatsAppMessages, verifyMetaSignature, verifyWebhookChallenge } from "./whatsapp";

describe("WhatsApp webhook boundary", () => {
  const payload = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
  const secret = "test-app-secret";

  it("accepts Meta's subscribe challenge only for the configured token", () => {
    expect(verifyWebhookChallenge({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345" }, "verify-me")).toBe("12345");
    expect(verifyWebhookChallenge({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345" }, "verify-me")).toBeNull();
  });

  it("validates the sha256 HMAC signature against the raw request bytes", () => {
    const digest = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    expect(verifyMetaSignature(payload, `sha256=${digest}`, secret)).toBe(true);
    expect(verifyMetaSignature(payload, `sha256=${digest.slice(0, -1)}0`, secret)).toBe(false);
    expect(verifyMetaSignature(payload, undefined, secret)).toBe(false);
  });

  it("extracts message metadata and ignores owner echoes", () => {
    const messages = extractWhatsAppMessages({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone-1" }, contacts: [{ wa_id: "94770001111", profile: { name: "Nimal" } }], messages: [{ id: "wamid.client-1", from: "94770001111", type: "text", text: { body: "mata website ekak one" } }, { id: "wamid.owner-1", from: "94770009999", type: "text", text: { body: "owner reply" } }] } }] }],
    }, "94770009999");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "wamid.client-1", waId: "94770001111", phoneNumberId: "phone-1", profileName: "Nimal", type: "text" });
  });
});
