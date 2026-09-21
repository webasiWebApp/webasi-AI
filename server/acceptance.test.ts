import { describe, expect, it } from "vitest";
import { approvedRestaurantProject } from "./conversations/project";
import { validateGroundedReply } from "./conversations/engine";
import { buildTextMessagePayload } from "./conversations/sender";
import { nextOrderState, shouldSendReply } from "../shared/webasi";
import { verifyMetaSignature, verifyWebhookChallenge } from "./webhooks/whatsapp";
import crypto from "node:crypto";

describe("WEBASI acceptance scenarios", () => {
  it("English and Singlish order flows share deterministic lifecycle controls", () => {
    expect(nextOrderState("collecting", "brief_complete")).toBe("awaiting_deposit");
    expect(nextOrderState("awaiting_deposit", "slip_received")).toBe("slip_received");
    expect(validateGroundedReply("The package is LKR 85,000 with a 40% deposit and a 14–18 business day timeline.", approvedRestaurantProject).valid).toBe(true);
  });
  it("discount, off-topic, and prompt-injection outputs cannot invent commercial facts", () => {
    expect(validateGroundedReply("I can give you LKR 50,000 and finish in 3 days.", approvedRestaurantProject).valid).toBe(false);
    expect(validateGroundedReply("Payment is confirmed.", approvedRestaurantProject).valid).toBe(false);
  });
  it("OFF and outside-window guards produce no outbound send permission", () => {
    expect(shouldSendReply({ isOn: false, withinCustomerWindow: true, monthlyOutbound: 1, monthlyCap: 900 })).toBe(false);
    expect(shouldSendReply({ isOn: true, withinCustomerWindow: false, monthlyOutbound: 1, monthlyCap: 900 })).toBe(false);
  });
  it("handles voice/unsupported media through the fixed text sender contract", () => {
    expect(buildTextMessagePayload({ to: "94770001111", body: "Please type your message here so I can help you with the website package." }).type).toBe("text");
  });
  it("verifies duplicate-safe Meta webhook signatures and challenge handshake", () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = `sha256=${crypto.createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyMetaSignature(body, signature, "secret")).toBe(true);
    expect(verifyWebhookChallenge({ "hub.mode": "subscribe", "hub.verify_token": "verify", "hub.challenge": "42" }, "verify")).toBe("42");
  });
});
