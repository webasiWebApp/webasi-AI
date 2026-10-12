import crypto from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWhatsAppWebhook, verifyWebhookChallenge, type ParsedWhatsAppMessage } from "./whatsapp";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

async function serve(options: Parameters<typeof registerWhatsAppWebhook>[1]) {
  const app = express();
  registerWhatsAppWebhook(app, options);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/whatsapp`;
}
const sign = (body: string, secret: string) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
const delivery = (messages: unknown[]) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { contacts: [{ wa_id: "94770001111", profile: { name: "Nimal" } }], messages } }] }] });

describe("Meta webhook endpoint", () => {
  it("never verifies a subscription when no verify token is configured", () => {
    expect(verifyWebhookChallenge({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "42" }, "")).toBeNull();
    expect(verifyWebhookChallenge({ "hub.mode": "subscribe", "hub.challenge": "42" }, "")).toBeNull();
  });

  it("returns the challenge as plain text, so markup in it cannot run in a browser", async () => {
    const url = await serve({ verifyToken: "verify-me", appSecret: "secret" });
    const response = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=${encodeURIComponent("<script>alert(1)</script>")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect((await fetch(`${url}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status).toBe(403);
  });

  it("processes a signed delivery once it has acknowledged it, and drops unsigned or tampered ones", async () => {
    const received: ParsedWhatsAppMessage[] = [];
    const enqueue = vi.fn((message: ParsedWhatsAppMessage) => { received.push(message); });
    const url = await serve({ verifyToken: "verify-me", appSecret: "secret", ownerWaId: "94770009999", enqueue });
    const body = delivery([{ id: "wamid.1", from: "94770001111", type: "text", text: { body: "price?" } }, { id: "wamid.owner", from: "94770009999", type: "text", text: { body: "owner echo" } }]);
    const post = (payload: string, signature?: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) }, body: payload });

    expect((await post(body)).status).toBe(401);
    expect((await post(body, sign(body, "another-secret"))).status).toBe(401);
    expect((await post(body.replace("price?", "free?"), sign(body, "secret"))).status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();

    const accepted = await post(body, sign(body, "secret"));
    expect(accepted.status).toBe(200);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(received[0]).toMatchObject({ id: "wamid.1", waId: "94770001111", profileName: "Nimal" });
  });

  it("handles one client's messages in the order they came, and different clients side by side", async () => {
    const log: string[] = [];
    const finish = new Map<string, () => void>();
    const enqueue = vi.fn((message: ParsedWhatsAppMessage) => new Promise<void>((resolve) => { log.push(`start ${message.id}`); finish.set(message.id, () => { log.push(`end ${message.id}`); resolve(); }); }));
    const url = await serve({ verifyToken: "v", appSecret: "secret", enqueue });
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { messages: [{ id: "a1", from: "94770001111", type: "text", text: { body: "one" } }, { id: "a2", from: "94770001111", type: "text", text: { body: "two" } }, { id: "b1", from: "94770002222", type: "text", text: { body: "hi" } }] } }] }] });
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, "secret") }, body })).status).toBe(200);
    await vi.waitFor(() => expect(log).toEqual(["start a1", "start b1"]));
    finish.get("a1")!();
    await vi.waitFor(() => expect(log).toEqual(["start a1", "start b1", "end a1", "start a2"]));
  });

  it("rejects a signed body that is not a WhatsApp delivery", async () => {
    const url = await serve({ verifyToken: "v", appSecret: "secret", enqueue: vi.fn() });
    const body = JSON.stringify({ object: "page" });
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, "secret") }, body })).status).toBe(400);
  });
});
