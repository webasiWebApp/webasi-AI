import crypto from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { ENV } from "../_core/env";
import { processWhatsAppMessage } from "../conversations/processor";
import { pauseConversationByWaId } from "../module-db";

export type WhatsAppMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; sha256?: string; mime_type?: string; caption?: string };
};

export type WhatsAppWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: WhatsAppMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
};

export type ParsedWhatsAppMessage = WhatsAppMessage & {
  businessAccountId?: string;
  phoneNumberId?: string;
  profileName?: string;
  waId?: string;
};

export function verifyWebhookChallenge(query: Record<string, unknown>, verifyToken: string): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || token !== verifyToken || typeof challenge !== "string") return null;
  return challenge;
}

export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !appSecret) return false;
  const [algorithm, received] = signatureHeader.split("=", 2);
  if (algorithm !== "sha256" || !received || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function extractWhatsAppMessages(payload: WhatsAppWebhookPayload, ownerWaId?: string): ParsedWhatsAppMessage[] {
  const messages: ParsedWhatsAppMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      for (const message of value?.messages ?? []) {
        // Coexistence echoes can arrive as messages from the business number. Never automate those.
        if (ownerWaId && message.from === ownerWaId) continue;
        const contact = value?.contacts?.find((item) => item.wa_id === message.from);
        messages.push({
          ...message,
          businessAccountId: entry.id,
          phoneNumberId: value?.metadata?.phone_number_id,
          profileName: contact?.profile?.name,
          waId: contact?.wa_id ?? message.from,
        });
      }
    }
  }
  return messages;
}

export function registerWhatsAppWebhook(
  app: Express,
  options: {
    verifyToken?: string;
    appSecret?: string;
    ownerWaId?: string;
    enqueue?: (message: ParsedWhatsAppMessage) => Promise<void> | void;
  } = {},
) {
  const verifyToken = options.verifyToken ?? ENV.whatsappVerifyToken;
  const appSecret = options.appSecret ?? ENV.whatsappAppSecret;
  const ownerWaId = options.ownerWaId ?? ENV.whatsappOwnerWaId;
  const enqueue = options.enqueue ?? ((message: ParsedWhatsAppMessage) => processWhatsAppMessage(message));

  // Raw-body parsing is scoped to this route so HMAC validation uses the exact bytes Meta signed.
  app.get("/api/webhooks/whatsapp", (req: Request, res: Response) => {
    const challenge = verifyWebhookChallenge(req.query as Record<string, unknown>, verifyToken);
    if (challenge === null) {
      res.status(403).send("Forbidden");
      return;
    }
    res.status(200).send(challenge);
  });

  app.post(
    "/api/webhooks/whatsapp",
    express.raw({ type: "application/json", limit: "2mb" }),
    (req: Request, res: Response, next) => {
      // express.raw is attached below through the route-local middleware declaration.
      if (!Buffer.isBuffer(req.body)) {
        next(new Error("WhatsApp webhook requires raw request bytes"));
        return;
      }
      if (!verifyMetaSignature(req.body, req.header("X-Hub-Signature-256"), appSecret)) {
        res.status(401).send("Invalid signature");
        return;
      }
      let payload: WhatsAppWebhookPayload;
      try {
        payload = JSON.parse(req.body.toString("utf8")) as WhatsAppWebhookPayload;
      } catch {
        res.status(400).send("Invalid JSON");
        return;
      }
      if (payload.object !== "whatsapp_business_account") {
        res.status(400).send("Unsupported webhook object");
        return;
      }

      const allMessages = extractWhatsAppMessages(payload);
      const ownerEchoes = ownerWaId ? allMessages.filter((message) => message.from === ownerWaId) : [];
      const messages = ownerWaId ? allMessages.filter((message) => message.from !== ownerWaId) : allMessages;
      // Acknowledge first. Meta retries unacknowledged deliveries, so processing must not block the response.
      res.status(200).send("EVENT_RECEIVED");
      queueMicrotask(() => {
        for (const echo of ownerEchoes) {
          Promise.resolve(pauseConversationByWaId(echo.waId ?? echo.from)).catch((error) => console.error("[WhatsApp] owner echo handling failed", error));
        }
        for (const message of messages) {
          Promise.resolve(enqueue(message)).catch((error) => console.error("[WhatsApp] enqueue failed", error));
        }
      });
    },
  );
}
