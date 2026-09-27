import crypto from "node:crypto";
import { ENV } from "../_core/env";
import { claimWhatsAppMessage, getConversation, getUsageCounts, incrementUsage, logMessage, saveConversation, TRANSCRIPT_LIMIT, type ConversationSnapshot, type TranscriptMessage } from "../db";
import { nextOrderState, requiredOrderFields } from "../../shared/webasi";
import { createConversationEngine, type StructuredReply } from "./engine";
import { createWhatsAppSender, outboundCapAllows, type SendTextResult } from "./sender";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp";
import { createOrder, getSettings, recordEvent, getActiveProject, markOrderSlipReceived, compileProjectSnapshot, trackKnowledgeGap } from "../module-db";
import { notifyOwner } from "../_core/notification";
import { baileysTransport } from "../whatsapp/baileys";
import { matchFaqCache, type FaqCache } from "./faq-cache";

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
  sendText?: (input: { to: string; body: string; humanize?: boolean }) => Promise<SendTextResult>;
  now?: Date;
};

export type ProcessResult = {
  accepted: boolean;
  duplicate?: boolean;
  replied: boolean;
  reason?: string;
  state?: ConversationSnapshot["state"];
};

export function internalClientId(waId: string) {
  return `client_${crypto.createHash("sha256").update(waId).digest("hex").slice(0, 24)}`;
}

function textFor(message: ParsedWhatsAppMessage) { return message.text?.body?.trim() ?? message.image?.caption?.trim() ?? ""; }

// What the owner sees in the transcript for messages that are not plain text.
function transcriptText(message: ParsedWhatsAppMessage) {
  const text = textFor(message);
  const label = message.type === "image" ? "[Photo]" : message.type === "audio" ? "[Voice note]" : message.type === "text" ? "" : `[${message.type}]`;
  return [label, text].filter(Boolean).join(" ");
}

function mergeExtracted(snapshot: ConversationSnapshot, reply: StructuredReply) {
  const extractedFields = { ...snapshot.extractedFields };
  for (const [key, value] of Object.entries(reply.extractedFields)) if (value) extractedFields[key] = value;
  const missingFields = requiredOrderFields.filter((field) => !extractedFields[field]);
  return { extractedFields, missingFields };
}

const appendTranscript = (snapshot: ConversationSnapshot, entry: TranscriptMessage) => {
  snapshot.recentMessages = [...snapshot.recentMessages, entry].slice(-TRANSCRIPT_LIMIT);
};

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
  const now = deps.now ?? new Date();
  const who = message.profileName ?? "a client";
  const alert = (title: string, content: string) => notify({ title, content }).catch(() => false);

  // Kick off settings + usage in parallel — both are independent reads and
  // collectively save ~1.5–3 s compared to awaiting them one-by-one later.
  const [settings, counts] = await Promise.all([getSettings(), (deps.getUsageCounts ?? getUsageCounts)()]);
  const isOn = deps.isOn ?? settings.webasiEnabled;

  const claimed = await claim({ messageId: message.id, waId, messageType: message.type, clientId, body: textFor(message) || null });
  if (!claimed) return { accepted: true, duplicate: true, replied: false, reason: "duplicate_message" };

  // Fetch conversation state and active project in parallel — both are safe to
  // read before we decide whether to act on this message.
  const [snapshot, activeProjectEarly] = await Promise.all([
    getState(clientId, waId, message.profileName),
    getActiveProject(),
  ]);
  const daysSinceLastMessage = snapshot.lastClientMessageAt ? (now.getTime() - snapshot.lastClientMessageAt.getTime()) / 86_400_000 : null;
  snapshot.lastClientMessageAt = now;
  if (message.profileName) snapshot.profileName = message.profileName;
  if (snapshot.state === "new") snapshot.state = "collecting";
  // Every client message lands in the transcript, including while paused, off or in shadow mode.
  appendTranscript(snapshot, { role: "client", text: transcriptText(message) || "[message]", at: now.toISOString() });

  const done = async (reason: string, replied = false): Promise<ProcessResult> => { await saveState(snapshot); return { accepted: true, replied, reason, state: snapshot.state }; };
  if (snapshot.isPaused) return done("conversation_paused");
  if (!isOn) return done("automation_off");
  if (snapshot.handedOver) return done("already_handed_over");

  let replyText: string | null = null;
  let structured: StructuredReply | null = null;
  const incomingText = textFor(message);

  if (message.type === "image" && snapshot.state === "awaiting_deposit") {
    snapshot.state = nextOrderState(snapshot.state, "slip_received");
    replyText = "Thank you! Got the slip 👍 The owner will check the transfer and confirm your order shortly.";
    await markSlip(waId, message.image?.id);
    await event({ eventType: "slip_received", severity: "warning", title: "Deposit slip received", detail: `A payment slip was received from ${who}. Manual verification is required.`, clientId });
    await alert("WEBASI: deposit slip received", `${who} sent a payment slip. Open Orders to verify it. WEBASI has NOT confirmed payment.`);
  } else if (message.type === "audio") {
    snapshot.handedOver = true;
    replyText = "Sorry, I can't listen to voice notes here — could you type it out? If it's easier, the owner will listen and reply to you.";
    await event({ eventType: "voice_note", severity: "info", title: "Voice note received", detail: `${who} sent a voice note. Listen to it on the phone.`, clientId });
    await alert("WEBASI: voice note", `${who} sent a voice note that WEBASI can't play. Please listen on your phone.`);
  } else if (!incomingText) {
    // Stickers, reactions, photos without a caption outside the deposit step: logged for the owner, no reply.
    return done("non_text_logged");
  } else {
    if (!outboundCapAllows(counts.outboundWhatsApp, settings.whatsappMonthlyCap) || counts.geminiRequests >= settings.geminiDailyCap) {
      await event({ eventType: "usage_guard", severity: "warning", title: "Usage limit reached", detail: `WEBASI did not reply to ${who} because a monthly WhatsApp or daily AI limit was reached.`, clientId });
      return done("usage_guard_hard_stop");
    }
    const activeProject = activeProjectEarly;
    const project = activeProject ? await compileProjectSnapshot(activeProject.projectKey) : null;
    if (!project && !deps.runEngine) {
      // Never answer from demo facts: without an active project the owner must reply.
      snapshot.handedOver = true;
      await event({ eventType: "no_active_project", severity: "error", title: "No active project", detail: `WEBASI could not answer ${who} because no project is active.`, clientId });
      await alert("WEBASI: no active project", `${who} messaged but no project is active, so WEBASI did not reply. Activate a project or reply yourself.`);
      return done("no_active_project");
    }
    // ── FAQ cache fast-path ──────────────────────────────────────────────────
    // Check the pre-compiled answer cache before touching the LLM.
    // Only applies to plain text questions while the conversation is still in
    // an information-gathering or greeting state (not mid-order or handed-over).
    if (project && !snapshot.handedOver && ["new", "collecting"].includes(snapshot.state)) {
      let faqCache: FaqCache | null = null;
      try {
        const raw = typeof activeProject?.snapshot === "string" ? JSON.parse(activeProject.snapshot) : (activeProject?.snapshot ?? {});
        faqCache = Array.isArray(raw?.faqCache) ? raw.faqCache as FaqCache : null;
      } catch { /* malformed snapshot — fall through to engine */ }

      if (faqCache && faqCache.length > 0) {
        const match = matchFaqCache(incomingText, faqCache);
        if (match) {
          replyText = match.entry.answer;
          await event({ eventType: "faq_cache_hit", severity: "info", title: "FAQ cache hit", detail: `Answered '${incomingText.slice(0, 120)}' from cache (score ${match.score.toFixed(2)}): ${match.entry.question.slice(0, 120)}`, clientId });
          // Skip the rest of the engine block — jump straight to send.
        }
      }
    }
    // ── LLM engine (only reached on cache miss) ──────────────────────────────
    if (!replyText) {
      try {
        const runEngine = deps.runEngine ?? createConversationEngine({ project: project ?? undefined, provider: settings.aiProvider }).runTurn;
        structured = await runEngine({
          clientId, state: snapshot.state, missingFields: snapshot.missingFields, recentMessages: snapshot.recentMessages.slice(0, -1).map(({ role, text }) => ({ role, text })),
          incomingText, isOn, withinCustomerWindow: true, monthlyOutbound: counts.outboundWhatsApp, monthlyCap: settings.whatsappMonthlyCap,
          clientName: snapshot.extractedFields.clientName ?? message.profileName, clientNotes: snapshot.clientNotes, knownFields: snapshot.extractedFields, daysSinceLastMessage, now,
        });
        await increment("geminiRequests");
        replyText = structured.reply;

        const previousScore = snapshot.intentScore;
        snapshot.intentScore = structured.intentScore ?? snapshot.intentScore;
        snapshot.sentiment = structured.sentiment ?? snapshot.sentiment;
        snapshot.objection = structured.objection ?? snapshot.objection;
        snapshot.language = structured.language ?? snapshot.language;
        if (structured.clientNotes) snapshot.clientNotes = structured.clientNotes;
        const merged = mergeExtracted(snapshot, structured);
        snapshot.extractedFields = merged.extractedFields;
        snapshot.missingFields = merged.missingFields;

        if (structured.needsOwner) {
          snapshot.handedOver = true;
          await event({ eventType: "escalation", severity: "warning", title: "Conversation needs owner", detail: structured.needsOwnerReason ?? "The assistant could not safely answer the client.", clientId });
          await alert("WEBASI: a client needs you", `${who} asked: "${incomingText.slice(0, 200)}"\nReason: ${structured.needsOwnerReason ?? "outside the approved facts"}`);
          // Track this as a knowledge gap so you can answer it from the Training tab.
          await trackKnowledgeGap(incomingText, structured.needsOwnerReason ?? "outside_approved_facts", clientId).catch(() => {});
        } else if (structured.sentiment === "frustrated" && !snapshot.handedOver) {
          snapshot.handedOver = true;
          await event({ eventType: "frustrated_client", severity: "warning", title: "Client seems frustrated", detail: `${who} sounds frustrated. Consider taking over.`, clientId });
          await alert("WEBASI: client seems frustrated", `${who}: "${incomingText.slice(0, 200)}"\nConsider replying personally.`);
        }
        if (structured.intentScore === "high" && previousScore !== "high") {
          await event({ eventType: "hot_lead", severity: "info", title: "Hot lead", detail: `${who} looks ready to proceed.`, clientId });
          await alert("WEBASI: hot lead 🔥", `${who} looks ready to proceed.${snapshot.clientNotes ? `\n${snapshot.clientNotes}` : ""}`);
        }

        if (snapshot.state === "collecting" && snapshot.missingFields.length === 0 && !structured.needsOwner && project) {
          if (project.priceLkr > 0 && project.depositPercent > 0) {
            const depositAmount = Math.round(project.priceLkr * project.depositPercent / 100);
            replyText = `${structured.reply}\n\nSo that's the ${project.packageName} — LKR ${project.priceLkr.toLocaleString("en-LK")} in total, and a ${project.depositPercent}% deposit (LKR ${depositAmount.toLocaleString("en-LK")}) gets us started.\n\n${settings.bankDetails}\n\nOnce you've transferred, just send a photo of the slip here and the owner will confirm.`;
            snapshot.state = nextOrderState(snapshot.state, "brief_complete");
            await create({ orderKey: `WA-${message.id.slice(-8)}`, clientId, waId, packageName: project.packageName, depositAmount, state: "awaiting_deposit", notes: "Brief complete; waiting for deposit slip." });
          } else {
            snapshot.handedOver = true;
            replyText = "Thanks, I have everything I need! The owner will confirm the price and next steps with you shortly.";
            await event({ eventType: "escalation", severity: "warning", title: "Brief complete but project has no price", detail: `The active project has no approved price or deposit, so ${who} was handed to the owner instead of being quoted.`, clientId });
          }
        }
      } catch (error) {
        console.error("[Processor] conversation engine failed", error instanceof Error ? error.message : error);
        snapshot.handedOver = true;
        await event({ eventType: "llm_failure", severity: "error", title: "Conversation engine unavailable", detail: "A holding reply was sent because the AI call failed or was rate limited.", clientId });
        await alert("WEBASI: AI engine needs attention", `The AI failed while replying to ${who}. A holding reply was sent; please follow up.`);
        replyText = "Sorry, give me a few minutes — I'll get back to you shortly.";
      }
    } // end !replyText / LLM engine block
  }

  if (!replyText) return done("no_reply");

  if (settings.shadowMode) {
    await event({ eventType: "shadow_draft", severity: "info", title: "Shadow-mode draft created", detail: replyText, clientId });
    return done("shadow_mode");
  }

  const current = await usage();
  if (!outboundCapAllows(current.outboundWhatsApp, settings.whatsappMonthlyCap)) return done("whatsapp_usage_hard_stop");

  const result = await sendText({ to: waId, body: replyText, humanize: true });
  if (result.accepted) {
    for (let part = 0; part < (result.parts ?? 1); part++) await increment("outboundWhatsApp");
    appendTranscript(snapshot, { role: "assistant", text: replyText, at: new Date().toISOString() });
    await log({ messageId: result.messageId ?? `out-${message.id}`, clientId, waId, role: "assistant", body: replyText, topic: structured?.intent ?? null, intentScore: snapshot.intentScore ?? null, handedOver: Boolean(structured?.needsOwner) }).catch((error) => console.error("[Processor] message log failed", error));
  } else {
    await event({ eventType: "send_failed", severity: "error", title: "Reply not delivered", detail: `WEBASI could not send a reply to ${who}: ${result.reason ?? "unknown error"}.`, clientId });
  }
  return done(result.accepted ? "replied" : result.reason ?? "send_failed", result.accepted);
}
