import crypto from "node:crypto";
import { ENV } from "../_core/env";
import { claimWhatsAppMessage, customerWindowOpen, getConversation, getUsageCounts, incrementUsage, saveConversation, type ConversationSnapshot } from "../db";
import { nextOrderState, requiredOrderFields } from "../../shared/webasi";
import { createConversationEngine, type StructuredReply } from "./engine";
import { createWhatsAppSender, outboundCapAllows, type SendTextResult } from "./sender";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp";

export type MessageProcessorDeps = {
  isOn?: boolean;
  getConversation?: typeof getConversation;
  saveConversation?: typeof saveConversation;
  getUsageCounts?: typeof getUsageCounts;
  incrementUsage?: typeof incrementUsage;
  runEngine?: ReturnType<typeof createConversationEngine>["runTurn"];
  sendText?: (input: { to: string; body: string }) => Promise<SendTextResult>;
};

export type ProcessResult = {
  accepted: boolean;
  duplicate?: boolean;
  replied: boolean;
  reason?: string;
  state?: ConversationSnapshot["state"];
};

function internalClientId(waId: string) {
  return `client_${crypto.createHash("sha256").update(waId).digest("hex").slice(0, 24)}`;
}

function textFor(message: ParsedWhatsAppMessage) { return message.text?.body?.trim() ?? ""; }

function mergeExtracted(snapshot: ConversationSnapshot, reply: StructuredReply) {
  const extractedFields = { ...snapshot.extractedFields };
  for (const [key, value] of Object.entries(reply.extractedFields)) if (value) extractedFields[key] = value;
  const missingFields = requiredOrderFields.filter((field) => !extractedFields[field]);
  return { extractedFields, missingFields };
}

export async function processWhatsAppMessage(message: ParsedWhatsAppMessage, deps: MessageProcessorDeps = {}): Promise<ProcessResult> {
  const waId = message.waId ?? message.from;
  const clientId = internalClientId(waId);
  const getState = deps.getConversation ?? getConversation;
  const saveState = deps.saveConversation ?? saveConversation;
  const usage = deps.getUsageCounts ?? getUsageCounts;
  const increment = deps.incrementUsage ?? incrementUsage;
  const sendText = deps.sendText ?? createWhatsAppSender();
  const isOn = deps.isOn ?? ENV.webasiEnabled;

  const claimed = await claimWhatsAppMessage({ messageId: message.id, waId, messageType: message.type });
  if (!claimed) return { accepted: true, duplicate: true, replied: false, reason: "duplicate_message" };

  const snapshot = await getState(clientId, waId, message.profileName);
  const now = new Date();
  const withinWindow = message.type === "text" || message.type === "image" || message.type === "audio" || message.type === "video" ? true : customerWindowOpen(snapshot.lastClientMessageAt, now);
  snapshot.lastClientMessageAt = now;
  if (snapshot.state === "new") snapshot.state = "collecting";

  if (snapshot.isPaused) {
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: "conversation_paused", state: snapshot.state };
  }

  let replyText: string | null = null;
  let structured: StructuredReply | null = null;

  if (message.type === "image") {
    if (snapshot.state === "awaiting_deposit") {
      snapshot.state = nextOrderState(snapshot.state, "slip_received");
      replyText = "Thanks — I’ve received the payment slip. The owner will verify the transfer and confirm your order.";
    } else {
      await saveState(snapshot);
      return { accepted: true, replied: false, reason: "image_logged_outside_deposit_state", state: snapshot.state };
    }
  } else if (message.type !== "text") {
    replyText = "Please type your message here so I can help you with the website package.";
  } else if (!withinWindow || !isOn) {
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: !isOn ? "automation_off" : "customer_window_closed", state: snapshot.state };
  } else {
    const counts = await usage();
    if (!outboundCapAllows(counts.outboundWhatsApp, ENV.whatsappMonthlyCap) || counts.geminiRequests >= ENV.geminiDailyCap) {
      await saveState(snapshot);
      return { accepted: true, replied: false, reason: "usage_guard_hard_stop", state: snapshot.state };
    }
    try {
      const runEngine = deps.runEngine ?? createConversationEngine().runTurn;
      structured = await runEngine({ clientId, state: snapshot.state, missingFields: snapshot.missingFields, recentMessages: snapshot.recentMessages, incomingText: textFor(message), isOn, withinCustomerWindow: withinWindow, monthlyOutbound: counts.outboundWhatsApp, monthlyCap: ENV.whatsappMonthlyCap });
      await increment("geminiRequests");
      replyText = structured.reply;
      const merged = mergeExtracted(snapshot, structured);
      snapshot.extractedFields = merged.extractedFields;
      snapshot.missingFields = merged.missingFields;
      if (snapshot.state === "collecting" && snapshot.missingFields.length === 0) snapshot.state = nextOrderState(snapshot.state, "brief_complete");
    } catch (error) {
      console.error("[WhatsApp] conversation engine failed", error);
      replyText = "I’m having trouble checking that right now. I’ll ask the owner to follow up.";
    }
  }

  if (!replyText || !isOn || !withinWindow) {
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: !isOn ? "automation_off" : "no_reply", state: snapshot.state };
  }

  const current = await usage();
  if (!outboundCapAllows(current.outboundWhatsApp, ENV.whatsappMonthlyCap)) {
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: "whatsapp_usage_hard_stop", state: snapshot.state };
  }

  const result = await sendText({ to: waId, body: replyText });
  if (result.accepted) {
    await increment("outboundWhatsApp");
    const additions: Array<{ role: "client" | "assistant"; text: string }> = [];
    if (textFor(message)) additions.push({ role: "client", text: textFor(message) });
    additions.push({ role: "assistant", text: replyText });
    snapshot.recentMessages = [...snapshot.recentMessages, ...additions].slice(-12);
  }
  await saveState(snapshot);
  return { accepted: true, replied: result.accepted, reason: result.accepted ? undefined : result.reason, state: snapshot.state };
}
