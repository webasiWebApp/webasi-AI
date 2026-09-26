import crypto from "node:crypto";
import { ENV } from "../_core/env";
import { claimWhatsAppMessage, customerWindowOpen, getConversation, getUsageCounts, incrementUsage, logMessage, saveConversation, type ConversationSnapshot } from "../db";
import { nextOrderState, requiredOrderFields } from "../../shared/webasi";
import { createConversationEngine, type StructuredReply } from "./engine";
import { createWhatsAppSender, outboundCapAllows, type SendTextResult } from "./sender";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp";
import { createOrder, getSettings, recordEvent, getActiveProject, markOrderSlipReceived } from "../module-db";
import { approvedRestaurantProject } from "./project";
import { notifyOwner } from "../_core/notification";
import { baileysTransport } from "../whatsapp/baileys";

export type MessageProcessorDeps = {
  claimMessage?: typeof claimWhatsAppMessage;
  createOrder?: typeof createOrder;
  markSlipReceived?: typeof markOrderSlipReceived;
  logMessage?: typeof logMessage;
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
  const markSlip = deps.markSlipReceived ?? markOrderSlipReceived;
  const log = deps.logMessage ?? logMessage;
  const event = deps.recordEvent ?? recordEvent;
  const notify = deps.notifyOwner ?? notifyOwner;
  const getState = deps.getConversation ?? getConversation;
  const saveState = deps.saveConversation ?? saveConversation;
  const usage = deps.getUsageCounts ?? getUsageCounts;
  const increment = deps.incrementUsage ?? incrementUsage;
  const sendText = deps.sendText ?? (ENV.whatsappTransport === "baileys" ? (input) => baileysTransport.sendText(input) : createWhatsAppSender());
  const settings = await getSettings();
  const isOn = deps.isOn ?? settings.webasiEnabled;

  console.log(`[Processor] Incoming ${message.type} from ${message.profileName ?? waId} | isOn=${isOn} shadowMode=${settings.shadowMode}`);

  const claimed = await claim({ messageId: message.id, waId, messageType: message.type, clientId, body: textFor(message) || null });
  if (!claimed) { console.log("[Processor] Skipped: duplicate message"); return { accepted: true, duplicate: true, replied: false, reason: "duplicate_message" }; }

  const snapshot = await getState(clientId, waId, message.profileName);
  const now = new Date();
  const withinWindow = message.type === "text" || message.type === "image" || message.type === "audio" || message.type === "video" ? true : customerWindowOpen(snapshot.lastClientMessageAt, now);
  snapshot.lastClientMessageAt = now;
  if (snapshot.state === "new") snapshot.state = "collecting";

  if (snapshot.isPaused) {
    console.log("[Processor] Skipped: conversation is paused");
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: "conversation_paused", state: snapshot.state };
  }

  let replyText: string | null = null;
  let structured: StructuredReply | null = null;

  if (message.type === "image") {
    if (snapshot.state === "awaiting_deposit") {
      snapshot.state = nextOrderState(snapshot.state, "slip_received");
      replyText = "Thanks — I've received the payment slip. The owner will verify the transfer and confirm your order.";
      await markSlip(waId, message.image?.id);
      await event({ eventType: "slip_received", severity: "warning", title: "Deposit slip received", detail: `A payment slip was received from ${message.profileName ?? waId}. Manual verification is required.`, clientId });
      await notify({ title: "WEBASI: deposit slip received", content: `A payment slip was received from ${message.profileName ?? waId}. Open Orders to verify it manually. WEBASI has not confirmed payment.` }).catch(() => false);
    } else {
      console.log("[Processor] Skipped: image received outside deposit state");
      await saveState(snapshot);
      return { accepted: true, replied: false, reason: "image_logged_outside_deposit_state", state: snapshot.state };
    }
  } else if (message.type !== "text") {
    replyText = "Please type your message here so I can help you with the website package.";
  } else if (!withinWindow || !isOn) {
    console.log(`[Processor] Skipped: isOn=${isOn} withinWindow=${withinWindow}`);
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: !isOn ? "automation_off" : "customer_window_closed", state: snapshot.state };
  } else {
    const counts = await usage();
    if (!outboundCapAllows(counts.outboundWhatsApp, settings.whatsappMonthlyCap) || counts.geminiRequests >= settings.geminiDailyCap) {
      console.log(`[Processor] Skipped: usage guard (outbound=${counts.outboundWhatsApp} cap=${settings.whatsappMonthlyCap} gemini=${counts.geminiRequests} geminiCap=${settings.geminiDailyCap})`);
      await saveState(snapshot);
      return { accepted: true, replied: false, reason: "usage_guard_hard_stop", state: snapshot.state };
    }
    try {
      const activeProject = await getActiveProject();
      const { compileProjectSnapshot } = await import("../module-db");
      const compiledSnapshot = activeProject ? await compileProjectSnapshot(activeProject.projectKey) : undefined;
      console.log(`[Processor] Running engine | activeProject=${activeProject?.name ?? "NONE"} provider=${ENV.aiProvider}`);
      const runEngine = deps.runEngine ?? createConversationEngine({ project: compiledSnapshot ?? undefined }).runTurn;
      structured = await runEngine({ clientId, state: snapshot.state, missingFields: snapshot.missingFields, recentMessages: snapshot.recentMessages, incomingText: textFor(message), isOn, withinCustomerWindow: withinWindow, monthlyOutbound: counts.outboundWhatsApp, monthlyCap: settings.whatsappMonthlyCap });
      await increment("geminiRequests");
      replyText = structured.reply;
      console.log(`[Processor] Engine replied: "${(replyText ?? "").slice(0, 80)}..." needsOwner=${structured.needsOwner}`);
      snapshot.intentScore = structured.intentScore ?? snapshot.intentScore;
      snapshot.handedOver = Boolean(snapshot.handedOver || structured.needsOwner);
      const merged = mergeExtracted(snapshot, structured);
      snapshot.extractedFields = merged.extractedFields;
      snapshot.missingFields = merged.missingFields;
      if (structured.needsOwner) {
        snapshot.state = "needs_owner";
        await event({ eventType: "escalation", severity: "warning", title: "Conversation needs owner", detail: structured.needsOwnerReason ?? "The assistant could not safely answer the client.", clientId });
        await notify({ title: "WEBASI: conversation needs you", content: `${message.profileName ?? waId}: ${structured.needsOwnerReason ?? "The assistant could not safely answer the client."}` }).catch(() => false);
      }
      const project = compiledSnapshot ?? approvedRestaurantProject;
      if (snapshot.state === "collecting" && snapshot.missingFields.length === 0 && !structured.needsOwner) {
        if (project.priceLkr > 0 && project.depositPercent > 0) {
          const depositAmount = Math.round(project.priceLkr * project.depositPercent / 100);
          replyText = `Great — I have everything for the ${project.packageName}. The total is LKR ${project.priceLkr.toLocaleString("en-LK")} and the ${project.depositPercent}% deposit is LKR ${depositAmount.toLocaleString("en-LK")}.\n\n${settings.bankDetails}\n\nOnce you make the transfer, please send the slip here. The owner will verify it manually.`;
          snapshot.state = nextOrderState(snapshot.state, "brief_complete");
          await create({ orderKey: `WA-${message.id.slice(-8)}`, clientId, waId, packageName: project.packageName, depositAmount, state: "awaiting_deposit", notes: "Brief complete; waiting for deposit slip." });
        } else {
          snapshot.state = "needs_owner";
          snapshot.handedOver = true;
          replyText = "Thanks — I have all your details. The owner will confirm the price and deposit with you shortly.";
          await event({ eventType: "escalation", severity: "warning", title: "Brief complete but project has no price", detail: `The active project has no approved price or deposit, so ${message.profileName ?? waId} was handed to the owner instead of being quoted.`, clientId });
        }
      }
    } catch (error) {
      console.error("[WhatsApp] conversation engine failed", error);
      await event({ eventType: "llm_failure", severity: "error", title: "Conversation engine unavailable", detail: "A neutral holding reply was prepared because the model call failed or was rate limited.", clientId });
      await notify({ title: "WEBASI: AI engine needs attention", content: `The conversation engine failed for ${message.profileName ?? waId}. A neutral holding reply was used.` }).catch(() => false);
      replyText = "Sorry, I'm having trouble responding right now — please try again shortly.";
    }
  }

  if (settings.shadowMode && replyText) {
    console.log("[Processor] Skipped send: SHADOW MODE is ON — reply drafted but not sent");
    await event({ eventType: "shadow_draft", severity: "info", title: "Shadow-mode draft created", detail: replyText, clientId });
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: "shadow_mode", state: snapshot.state };
  }

  if (!replyText || !isOn || !withinWindow) {
    console.log(`[Processor] Skipped send: replyText=${!!replyText} isOn=${isOn} withinWindow=${withinWindow}`);
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: !isOn ? "automation_off" : "no_reply", state: snapshot.state };
  }

  const current = await usage();
  if (!outboundCapAllows(current.outboundWhatsApp, settings.whatsappMonthlyCap)) {
    console.log(`[Processor] Skipped send: outbound cap exceeded (${current.outboundWhatsApp} / ${settings.whatsappMonthlyCap})`);
    await saveState(snapshot);
    return { accepted: true, replied: false, reason: "whatsapp_usage_hard_stop", state: snapshot.state };
  }

  console.log(`[Processor] Sending reply to ${waId}: "${replyText.slice(0, 80)}..."`);
  const result = await sendText({ to: waId, body: replyText });
  console.log(`[Processor] sendText result: accepted=${result.accepted} reason=${result.reason ?? "none"}`);
  if (result.accepted) {
    await increment("outboundWhatsApp");
    await log({ messageId: result.messageId ?? `out-${message.id}`, clientId, waId, role: "assistant", body: replyText, topic: structured?.intent ?? null, intentScore: snapshot.intentScore ?? null, handedOver: Boolean(structured?.needsOwner) }).catch((error) => console.error("[Processor] message log failed", error));
    const additions: Array<{ role: "client" | "assistant"; text: string }> = [];
    if (textFor(message)) additions.push({ role: "client", text: textFor(message) });
    additions.push({ role: "assistant", text: replyText });
    snapshot.recentMessages = [...snapshot.recentMessages, ...additions].slice(-12);
  }
  await saveState(snapshot);
  return { accepted: true, replied: result.accepted, reason: result.accepted ? undefined : result.reason, state: snapshot.state };
}
