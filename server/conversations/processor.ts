import crypto from "node:crypto";
import { ENV } from "../_core/env";
import { claimWhatsAppMessage, customerWindowOpen, getConversation, getUsageCounts, incrementUsage, saveConversation, type ConversationSnapshot } from "../db";
import { nextOrderState, requiredOrderFields } from "../../shared/webasi";
import { createConversationEngine, type StructuredReply } from "./engine";
import { createWhatsAppSender, outboundCapAllows, type SendTextResult } from "./sender";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp";
import { createOrder, getSettings, recordEvent, getActiveProject } from "../module-db";
import { notifyOwner } from "../_core/notification";
import { baileysTransport } from "../whatsapp/baileys";

export type MessageProcessorDeps = {
  claimMessage?: typeof claimWhatsAppMessage;
  createOrder?: typeof createOrder;
  recordEvent?: typeof recordEvent;
  notifyOwner?: typeof notifyOwner;
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
  const claim = deps.claimMessage ?? claimWhatsAppMessage;
  const create = deps.createOrder ?? createOrder;
  const event = deps.recordEvent ?? recordEvent;
  const notify = deps.notifyOwner ?? notifyOwner;
  const getState = deps.getConversation ?? getConversation;
  const saveState = deps.saveConversation ?? saveConversation;
  const usage = deps.getUsageCounts ?? getUsageCounts;
  const increment = deps.incrementUsage ?? incrementUsage;
  const sendText = deps.sendText ?? (ENV.whatsappTransport === "baileys" ? (input) => baileysTransport.sendText(input) : createWhatsAppSender());
  const settings = await getSettings();
  const isOn = deps.isOn ?? settings.webasiEnabled;

  const claimed = await claim({ messageId: message.id, waId, messageType: message.type });
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
      await create({ orderKey: `WA-${message.id.slice(-8)}`, clientId, waId, packageName: "Restaurant Website Package", depositAmount: 34000, slipMediaId: message.image?.id, state: "slip_received", notes: "Payment slip received; owner verification required." });
      await event({ eventType: "slip_received", severity: "warning", title: "Deposit slip received", detail: `A payment slip was received from ${message.profileName ?? waId}. Manual verification is required.`, clientId });
      await notify({ title: "WEBASI: deposit slip received", content: `A payment slip was received from ${message.profileName ?? waId}. Open Orders to verify it manually. WEBASI has not confirmed payment.` }).catch(() => false);
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
      const activeProject = await getActiveProject();
      const runEngine = deps.runEngine ?? createConversationEngine({ project: activeProject ?? undefined }).runTurn;
      structured = await runEngine({ clientId, state: snapshot.state, missingFields: snapshot.missingFields, recentMessages: snapshot.recentMessages, incomingText: textFor(message), isOn, withinCustomerWindow: withinWindow, monthlyOutbound: counts.outboundWhatsApp, monthlyCap: ENV.whatsappMonthlyCap });
      await increment("geminiRequests");
      replyText = structured.reply;
      const merged = mergeExtracted(snapshot, structured);
      snapshot.extractedFields = merged.extractedFields;
      snapshot.missingFields = merged.missingFields;
      if (structured.needsOwner) {
        snapshot.state = "needs_owner";
        await event({ eventType: "escalation", severity: "warning", title: "Conversation needs owner", detail: structured.needsOwnerReason ?? "The assistant could not safely answer the client.", clientId });
        await notify({ title: "WEBASI: conversation needs you", content: `${message.profileName ?? waId}: ${structured.needsOwnerReason ?? "The assistant could not safely answer the client."}` }).catch(() => false);
      }
      if (snapshot.state === "collecting" && snapshot.missingFields.length === 0 && !structured.needsOwner) {
        snapshot.state = nextOrderState(snapshot.state, "brief_complete");
        const projectPrice = 85000;
        const depositAmount = Math.round(projectPrice * 0.4);
        replyText = `Great — I have everything for the Restaurant Website Package. The total is LKR ${projectPrice.toLocaleString("en-LK")} and the 40% deposit is LKR ${depositAmount.toLocaleString("en-LK")}.\n\n${settings.bankDetails}\n\nOnce you make the transfer, please send the slip here. The owner will verify it manually.`;
        snapshot.state = "awaiting_deposit";
        await create({ orderKey: `WA-${message.id.slice(-8)}`, clientId, waId, packageName: "Restaurant Website Package", depositAmount, state: "awaiting_deposit", notes: "Brief complete; waiting for deposit slip." });
      }
    } catch (error) {
      console.error("[WhatsApp] conversation engine failed", error);
      await event({ eventType: "llm_failure", severity: "error", title: "Conversation engine unavailable", detail: "A neutral holding reply was prepared because the model call failed or was rate limited.", clientId });
      await notify({ title: "WEBASI: AI engine needs attention", content: `The conversation engine failed for ${message.profileName ?? waId}. A neutral holding reply was used.` }).catch(() => false);
      replyText = "I’m having trouble checking that right now. I’ll ask the owner to follow up.";
    }
  }

  if (settings.shadowMode && replyText) {
    await event({ eventType: "shadow_draft", severity: "info", title: "Shadow-mode draft created", detail: replyText, clientId });
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: "shadow_mode", state: snapshot.state };
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
