import crypto from "node:crypto";
import { ENV } from "../_core/env";
import { claimWhatsAppMessage, getConversation, getUsageCounts, incrementUsage, logMessage, saveConversation, TRANSCRIPT_LIMIT, type ConversationSnapshot, type TranscriptMessage } from "../db";
import { nextOrderState, requiredOrderFields } from "../../shared/webasi";
import { createConversationEngine, type StructuredReply } from "./engine";
import type { ApprovedProjectSnapshot } from "./project";
import { createWhatsAppSender, outboundCapAllows, type SendTextResult } from "./sender";
import type { ParsedWhatsAppMessage } from "../webhooks/whatsapp";
import { createOrder, getSettings, recordEvent, getActiveProject, markOrderSlipReceived, compileProjectSnapshot, trackKnowledgeGap } from "../module-db";
import { notifyOwner } from "../_core/notification";
import { baileysTransport } from "../whatsapp/baileys";
import { matchFaqCache } from "./faq-cache";
import { instantAnswersFor, instantReplyText } from "./faq-generator";

// compileProjectSnapshot returns the same object until the project, its training or the settings change,
// so object identity is what says the engine (and the facts it has prepared) is still current.
let _cachedEngine: { project: ApprovedProjectSnapshot | null; provider: string; engine: ReturnType<typeof createConversationEngine> } | null = null;
let _lastUsageAlertAt = 0;

function engineFor(project: ApprovedProjectSnapshot | null, provider: string) {
  if (!_cachedEngine || _cachedEngine.project !== project || _cachedEngine.provider !== provider) {
    _cachedEngine = { project, provider, engine: createConversationEngine({ project: project ?? undefined, provider }) };
  }
  return _cachedEngine.engine.runTurn;
}

const VOICE_NOTE_REPLY = "Sorry, I can't listen to voice notes here. Could you type it out for me? If that's not easy, someone from our team will listen and get back to you.";
// Handovers that are not a missing answer: listing them as knowledge gaps would invite the owner to "answer" a complaint or an injection attempt into the FAQs.
const NOT_A_KNOWLEDGE_GAP = new Set(["client_frustrated_or_competitor", "discount_or_instruction_override_attempt", "Model returned empty reply"]);

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
  // Called once WEBASI is about to write an AI reply, so the transport can show "typing…" while the client waits.
  onReplying?: () => unknown;
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
  const record = deps.recordEvent ?? recordEvent;
  const notify = deps.notifyOwner ?? notifyOwner;
  const getState = deps.getConversation ?? getConversation;
  const saveState = deps.saveConversation ?? saveConversation;
  const usage = deps.getUsageCounts ?? getUsageCounts;
  const increment = deps.incrementUsage ?? incrementUsage;
  const sendText = deps.sendText ?? (ENV.whatsappTransport === "baileys" ? (input) => baileysTransport.sendText(input) : createWhatsAppSender());
  const now = deps.now ?? new Date();
  const who = message.profileName ?? "a client";

  // Owner-side bookkeeping (event log, alerts, usage counters) starts straight away but is only awaited when the
  // turn ends: it must neither hold up the client's reply nor, if it fails, turn a good answer into an apology.
  const background: Promise<unknown>[] = [];
  const later = (label: string, work: unknown) => { background.push(Promise.resolve(work).catch((error) => console.error(`[Processor] ${label} failed`, error instanceof Error ? error.message : error))); };
  const event = (input: Parameters<typeof recordEvent>[0]) => later("event log", record(input));
  const alert = (title: string, content: string) => later("owner alert", notify({ title, content }));

  // The duplicate check and the three reads every turn needs are independent, so they share one round trip.
  const [claimed, settings, counts, activeProject] = await Promise.all([
    claim({ messageId: message.id, waId, messageType: message.type, clientId, body: textFor(message) || null }),
    getSettings(),
    usage(),
    getActiveProject(),
  ]);
  if (!claimed) return { accepted: true, duplicate: true, replied: false, reason: "duplicate_message" };
  const isOn = deps.isOn ?? settings.webasiEnabled;

  const snapshot = await getState(clientId, waId, message.profileName);
  const daysSinceLastMessage = snapshot.lastClientMessageAt ? (now.getTime() - snapshot.lastClientMessageAt.getTime()) / 86_400_000 : null;
  snapshot.lastClientMessageAt = now;
  if (message.profileName) snapshot.profileName = message.profileName;
  if (snapshot.state === "new") snapshot.state = "collecting";
  // Every client message lands in the transcript, including while paused, off or in shadow mode.
  appendTranscript(snapshot, { role: "client", text: transcriptText(message) || "[message]", at: now.toISOString() });

  const done = async (reason: string, replied = false): Promise<ProcessResult> => {
    try { await saveState(snapshot); } finally { await Promise.all(background); }
    return { accepted: true, replied, reason, state: snapshot.state };
  };
  if (snapshot.isPaused) return done("conversation_paused");
  if (!isOn) return done("automation_off");
  if (snapshot.handedOver) return done("already_handed_over");

  // The client is left without an answer here, so the owner hears about it (at most once an hour) instead of finding out later.
  const usageStop = (limit: string) => {
    event({ eventType: "usage_guard", severity: "warning", title: "Usage limit reached", detail: `WEBASI did not reply to ${who} because the ${limit} limit was reached.`, clientId });
    if (Date.now() - _lastUsageAlertAt > 3_600_000) {
      _lastUsageAlertAt = Date.now();
      alert("WEBASI: usage limit reached", `WEBASI has stopped replying because the ${limit} limit was reached. ${who} is waiting for an answer. Raise the limit in Settings or reply yourself.`);
    }
    return done("usage_guard_hard_stop");
  };

  let replyText: string | null = null;
  let structured: StructuredReply | null = null;
  let answeredFromFaqs = false;
  const incomingText = textFor(message);

  if (message.type === "image" && snapshot.state === "awaiting_deposit") {
    snapshot.state = nextOrderState(snapshot.state, "slip_received");
    replyText = "Thank you! Got the slip 👍 Our team will check the transfer and confirm your order shortly.";
    await markSlip(waId, message.image?.id);
    event({ eventType: "slip_received", severity: "warning", title: "Deposit slip received", detail: `A payment slip was received from ${who}. Manual verification is required.`, clientId });
    alert("WEBASI: deposit slip received", `${who} sent a payment slip. Open Orders to verify it. WEBASI has NOT confirmed payment.`);
  } else if (message.type === "audio") {
    event({ eventType: "voice_note", severity: "info", title: "Voice note received", detail: `${who} sent a voice note. Listen to it on the phone.`, clientId });
    alert("WEBASI: voice note", `${who} sent a voice note that WEBASI can't play. Please listen on your phone.`);
    // Ask once to type it out, and keep answering if they do. A second voice note straight after that request
    // means the client would rather talk, so the chat goes to a person instead of repeating the same line.
    if (snapshot.recentMessages.filter((entry) => entry.role !== "client").at(-1)?.text === VOICE_NOTE_REPLY) {
      snapshot.handedOver = true;
      return done("voice_note_handed_over");
    }
    replyText = VOICE_NOTE_REPLY;
  } else if (!incomingText) {
    // Stickers, reactions, photos without a caption outside the deposit step: logged for the owner, no reply.
    return done("non_text_logged");
  } else {
    if (!outboundCapAllows(counts.outboundWhatsApp, settings.whatsappMonthlyCap)) return usageStop("monthly WhatsApp");
    const project = activeProject ? await compileProjectSnapshot(activeProject.projectKey) : null;
    if (!project && !deps.runEngine) {
      // Never answer from demo facts: without an active project the owner must reply.
      snapshot.handedOver = true;
      event({ eventType: "no_active_project", severity: "error", title: "No active project", detail: `WEBASI could not answer ${who} because no project is active.`, clientId });
      alert("WEBASI: no active project", `${who} messaged but no project is active, so WEBASI did not reply. Activate a project or reply yourself.`);
      return done("no_active_project");
    }
    // ── FAQ cache fast-path ──────────────────────────────────────────────────
    // Look the question up in the owner's FAQs and the generated client FAQs before touching the LLM.
    // Only while the conversation is still gathering information; from the deposit step on, every
    // message goes through the engine.
    const instant = project && ["new", "collecting"].includes(snapshot.state) ? matchFaqCache(incomingText, instantAnswersFor(project), { englishForSinglish: ENV.faqEnglishForSinglish }) : null;
    if (instant && project) {
      replyText = instantReplyText(instant, project, snapshot.extractedFields);
      answeredFromFaqs = true;
      event({ eventType: "faq_cache_hit", severity: "info", title: "Answered without AI", detail: `Answered '${incomingText.slice(0, 120)}' from the ${instant.entry.source === "owner" ? "project FAQs" : "generated client FAQs"} (score ${instant.score.toFixed(2)}): ${instant.entry.question.slice(0, 120)}`, clientId });
    }
    // ── LLM engine (only reached on cache miss) ──────────────────────────────
    if (!replyText) {
      // Cached answers above cost no AI request, so the daily AI limit only stops the turns that need one.
      if (counts.geminiRequests >= settings.geminiDailyCap) return usageStop("daily AI");
      try {
        const runEngine = deps.runEngine ?? engineFor(project, settings.aiProvider);
        if (!settings.shadowMode && deps.onReplying) later("typing indicator", deps.onReplying());
        structured = await runEngine({
          clientId, state: snapshot.state, missingFields: snapshot.missingFields, recentMessages: snapshot.recentMessages.slice(0, -1).map(({ role, text }) => ({ role, text })),
          incomingText, isOn, withinCustomerWindow: true, monthlyOutbound: counts.outboundWhatsApp, monthlyCap: settings.whatsappMonthlyCap,
          clientName: snapshot.extractedFields.clientName ?? message.profileName, clientNotes: snapshot.clientNotes, knownFields: snapshot.extractedFields, daysSinceLastMessage, now,
        });
        later("usage counter", increment("geminiRequests"));
        replyText = structured.reply;

        const previousScore = snapshot.intentScore;
        snapshot.intentScore = structured.intentScore ?? snapshot.intentScore;
        snapshot.sentiment = structured.sentiment ?? snapshot.sentiment;
        snapshot.objection = structured.objection ?? snapshot.objection;
        snapshot.language = structured.language ?? snapshot.language;
        if (structured.clientNotes) snapshot.clientNotes = structured.clientNotes;
        const hadMeetingTime = Boolean(snapshot.extractedFields.meetingTime);
        const merged = mergeExtracted(snapshot, structured);
        snapshot.extractedFields = merged.extractedFields;
        snapshot.missingFields = merged.missingFields;

        if (structured.needsOwner) {
          snapshot.handedOver = true;
          event({ eventType: "escalation", severity: "warning", title: "Conversation needs owner", detail: structured.needsOwnerReason ?? "The assistant could not safely answer the client.", clientId });
          alert("WEBASI: a client needs you", `${who} asked: "${incomingText.slice(0, 200)}"\nReason: ${structured.needsOwnerReason ?? "outside the approved facts"}`);
          // Track this as a knowledge gap so you can answer it from the Training tab.
          if (!NOT_A_KNOWLEDGE_GAP.has(structured.needsOwnerReason ?? "")) later("knowledge gap", trackKnowledgeGap(incomingText, structured.needsOwnerReason ?? "outside_approved_facts", clientId));
        } else if (structured.sentiment === "frustrated" && !snapshot.handedOver) {
          snapshot.handedOver = true;
          event({ eventType: "frustrated_client", severity: "warning", title: "Client seems frustrated", detail: `${who} sounds frustrated. Consider taking over.`, clientId });
          alert("WEBASI: client seems frustrated", `${who}: "${incomingText.slice(0, 200)}"\nConsider replying personally.`);
        }
        if (structured.intentScore === "high" && previousScore !== "high") {
          event({ eventType: "hot_lead", severity: "info", title: "Hot lead", detail: `${who} looks ready to proceed.`, clientId });
          alert("WEBASI: hot lead 🔥", `${who} looks ready to proceed.${snapshot.clientNotes ? `\n${snapshot.clientNotes}` : ""}`);
        }

        // The client named a day and time for a meeting. Only the owner can confirm it, so the chat goes to them
        // with what they need to reply: when, how, and how the client took the price.
        const meetingRequested = !hadMeetingTime && Boolean(snapshot.extractedFields.meetingTime);
        if (meetingRequested) {
          const { meetingTime, meetingMode, priceOk } = snapshot.extractedFields;
          const meeting = `${meetingTime}${meetingMode ? ` (${meetingMode})` : ""}`;
          // The model does not always record a "no"; a price objection says the same thing.
          const price = priceOk === "yes" ? "happy with the price" : priceOk === "no" || snapshot.objection === "price" ? "not happy with the price" : "price not discussed yet";
          snapshot.handedOver = true;
          event({ eventType: "meeting_requested", severity: "warning", title: "Meeting requested", detail: `${who} asked for a meeting: ${meeting}. Client is ${price}. Confirm the time with them.`, clientId });
          alert("WEBASI: meeting requested 📅", `${who} would like a meeting: ${meeting}.\nClient is ${price}.${snapshot.clientNotes ? `\n${snapshot.clientNotes}` : ""}\nWEBASI said you will confirm the time and has left this chat to you.`);
        }

        if (snapshot.state === "collecting" && snapshot.missingFields.length === 0 && !structured.needsOwner && !meetingRequested && project) {
          if (project.priceLkr > 0 && project.depositPercent > 0) {
            const depositAmount = Math.round(project.priceLkr * project.depositPercent / 100);
            const bankDetails = String(settings.bankDetails ?? "").trim();
            // Settings start out with a "Configure bank details…" placeholder, which must never reach a client.
            const hasBankDetails = Boolean(bankDetails) && !/^configure bank details/i.test(bankDetails);
            const quote = `So that's the ${project.packageName}: LKR ${project.priceLkr.toLocaleString("en-LK")} in total, and a ${project.depositPercent}% deposit (LKR ${depositAmount.toLocaleString("en-LK")}) gets us started.`;
            replyText = hasBankDetails
              ? `${structured.reply}\n\n${quote}\n\n${bankDetails}\n\nOnce you've transferred, just send a photo of the slip here and our team will confirm.`
              : `${structured.reply}\n\n${quote}\n\nOur team will send you the payment details shortly.`;
            snapshot.state = nextOrderState(snapshot.state, "brief_complete");
            await create({ orderKey: `WA-${message.id.slice(-8)}`, clientId, waId, packageName: project.packageName, depositAmount, state: "awaiting_deposit", notes: "Brief complete; waiting for deposit slip." });
            if (!hasBankDetails) {
              snapshot.handedOver = true;
              event({ eventType: "escalation", severity: "warning", title: "Bank details missing", detail: `${who} is ready to pay the deposit but no bank details are saved in Settings, so they were handed to you.`, clientId });
              alert("WEBASI: send payment details", `${who} is ready to pay the LKR ${depositAmount.toLocaleString("en-LK")} deposit, but no bank details are saved in Settings. Send them the details, then add them in Settings so WEBASI can do it next time.`);
            }
          } else {
            snapshot.handedOver = true;
            replyText = "Thanks, I have everything I need! Our team will confirm the price and next steps with you shortly.";
            event({ eventType: "escalation", severity: "warning", title: "Brief complete but project has no price", detail: `The active project has no approved price or deposit, so ${who} was handed to the owner instead of being quoted.`, clientId });
          }
        }
      } catch (error) {
        console.error("[Processor] conversation engine failed", error instanceof Error ? error.message : error);
        snapshot.handedOver = true;
        event({ eventType: "llm_failure", severity: "error", title: "Conversation engine unavailable", detail: `A holding reply was sent because the AI call failed or was rate limited: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`, clientId });
        alert("WEBASI: AI engine needs attention", `The AI failed while replying to ${who}. A holding reply was sent; please follow up.`);
        replyText = "Sorry, give me a few minutes. I'll get back to you shortly.";
      }
    } // end !replyText / LLM engine block
  }

  if (!replyText) return done("no_reply");

  if (settings.shadowMode) {
    event({ eventType: "shadow_draft", severity: "info", title: "Shadow-mode draft created", detail: replyText, clientId });
    return done("shadow_mode");
  }

  if (!outboundCapAllows(counts.outboundWhatsApp, settings.whatsappMonthlyCap)) return done("whatsapp_usage_hard_stop");

  const result = await sendText({ to: waId, body: replyText, humanize: true });
  if (result.accepted) {
    appendTranscript(snapshot, { role: "assistant", text: replyText, at: new Date().toISOString() });
    later("usage counter", (async () => { for (let part = 0; part < (result.parts ?? 1); part++) await increment("outboundWhatsApp"); })());
    later("message log", log({ messageId: result.messageId ?? `out-${message.id}`, clientId, waId, role: "assistant", body: replyText, topic: structured?.intent ?? (answeredFromFaqs ? "question" : null), intentScore: snapshot.intentScore ?? null, handedOver: Boolean(structured?.needsOwner) }));
  } else {
    event({ eventType: "send_failed", severity: "error", title: "Reply not delivered", detail: `WEBASI could not send a reply to ${who}: ${result.reason ?? "unknown error"}.`, clientId });
  }
  return done(result.accepted ? "replied" : result.reason ?? "send_failed", result.accepted);
}
