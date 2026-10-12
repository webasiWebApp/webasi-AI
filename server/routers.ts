import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { ENV } from "./_core/env";
import { appendTranscriptMessage, getUsageCounts, incrementUsage, logMessage } from "./db";
import { analyzeInsights, setInsightStatus, approveProject, activateProject, createProject, confirmOrder, ensureDefaults, getActiveProject, getConversationByClientId, getProjectByKey, getSettings, listConversations, listEvents, listInsights, listOrders, listProjects, updateSettings, getTraining, saveTraining, approveTraining, getInstantAnswers, refreshInstantAnswers, removeInstantAnswer, pauseConversation, recordOwnerMessageByWaId, captureLearnedAnswer, setAiProvider, resumeConversation, recordEvent, compileProjectSnapshot, listKnowledgeGaps, answerKnowledgeGap, listConversationSummaries, getShadowDraft, listShadowDrafts, settleShadowDraft, restoreShadowDraft } from "./module-db";
import { baileysTransport } from "./whatsapp/baileys";
import { outboundCapAllows } from "./conversations/sender";
import { sendWhatsAppText } from "./whatsapp/outbound";
import { sendWeeklySummary, weeklySummaryText } from "./automation";
import { createConversationEngine, type StructuredReply } from "./conversations/engine";
import { matchFaqCache } from "./conversations/faq-cache";
import { instantAnswersFor, instantReplyText } from "./conversations/faq-generator";
import { parseProjectSnapshot } from "../shared/webasi";

// Keys come from the dashboard's own lists; the bounds only keep junk out of the database and the caches.
const key = z.string().min(1).max(200);
const jsonObject = z.string().min(2).max(50_000).refine((value) => { try { const parsed = JSON.parse(value); return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed); } catch { return false; } }, "The project snapshot must be a JSON object.");
// A refused change must reach the dashboard as an error; a plain `false` was shown there as success.
const refuse = (code: "NOT_FOUND" | "PRECONDITION_FAILED", message: string): never => { throw new TRPCError({ code, message }); };

export const appRouter = router({
  dashboard: router({
    overview: protectedProcedure.query(async () => { await ensureDefaults(); const [settings, activeProject, usage, conversations, orders, events] = await Promise.all([getSettings(), getActiveProject(), getUsageCounts(), listConversationSummaries(), listOrders(), listEvents()]); return { settings, activeProject, usage, conversations, orders, events }; }),
    // The lists carry each chat's last message, not its transcript; the open chat is read with conversations.get.
    conversations: protectedProcedure.query(() => listConversationSummaries()),
    orders: protectedProcedure.query(() => listOrders()),
    events: protectedProcedure.query(() => listEvents()),
    insights: protectedProcedure.query(() => listInsights()),
    projects: protectedProcedure.query(() => listProjects()),
    settings: protectedProcedure.query(() => getSettings()),
  }),
  settings: router({
    update: protectedProcedure.input(z.object({ businessName: z.string().min(1).optional(), bankDetails: z.string().optional(), notificationEmail: z.string().email().nullable().optional(), whatsappMonthlyCap: z.number().int().min(1).max(10000).optional(), geminiDailyCap: z.number().int().min(1).max(10000).optional(), webasiEnabled: z.boolean().optional(), shadowMode: z.boolean().optional(), followupsEnabled: z.boolean().optional(), weeklySummaryEnabled: z.boolean().optional() })).mutation(({ input }) => updateSettings(input)),
    updateProvider: protectedProcedure.input(z.object({ provider: z.enum(["gemini", "groq"]) })).mutation(({ input }) => setAiProvider(input.provider)),
  }),
  projects: router({
    create: protectedProcedure.input(z.object({ projectKey: z.string().regex(/^[a-z0-9_-]{2,100}$/i, "Use 2 to 100 letters, digits, hyphens or underscores."), name: z.string().trim().min(2).max(180), snapshot: jsonObject })).mutation(({ input }) => createProject(input)),
    approve: protectedProcedure.input(z.object({ projectKey: key })).mutation(async ({ input }) => (await approveProject(input.projectKey)) || refuse("PRECONDITION_FAILED", "Complete this project's training before approving it.")),
    activate: protectedProcedure.input(z.object({ projectKey: key })).mutation(({ input }) => activateProject(input.projectKey)),
    training: protectedProcedure.input(z.object({ projectKey: key })).query(({ input }) => getTraining(input.projectKey)),
    saveTraining: protectedProcedure.input(z.object({ projectKey: key, answers: z.record(z.string().max(60), z.string().max(20_000)), summary: z.string().max(20_000) })).mutation(async ({ input }) => (await saveTraining(input.projectKey, input.answers, input.summary)) || refuse("NOT_FOUND", "This project no longer exists.")),
    approveTraining: protectedProcedure.input(z.object({ projectKey: key })).mutation(({ input }) => approveTraining(input.projectKey)),
    instantAnswers: protectedProcedure.input(z.object({ projectKey: key })).query(({ input }) => getInstantAnswers(input.projectKey)),
    regenerateInstantAnswers: protectedProcedure.input(z.object({ projectKey: key })).mutation(async ({ input }) => ({ count: (await refreshInstantAnswers(input.projectKey, { regenerate: true }))?.length ?? 0 })),
    removeInstantAnswer: protectedProcedure.input(z.object({ projectKey: key, question: z.string().min(1).max(500) })).mutation(({ input }) => removeInstantAnswer(input.projectKey, input.question)),
  }),
  knowledgeGaps: router({
    list: protectedProcedure.query(() => listKnowledgeGaps()),
    answer: protectedProcedure.input(z.object({ id: z.union([z.string(), z.number().int()]), answer: z.string().trim().min(3).max(4000) })).mutation(({ input }) => answerKnowledgeGap(input.id, input.answer)),
  }),
  conversations: router({
    get: protectedProcedure.input(z.object({ clientId: key })).query(({ input }) => getConversationByClientId(input.clientId)),
    pause: protectedProcedure.input(z.object({ clientId: key })).mutation(({ input }) => pauseConversation(input.clientId)),
    resume: protectedProcedure.input(z.object({ clientId: key })).mutation(({ input }) => resumeConversation(input.clientId)),
    ownerMessage: protectedProcedure.input(z.object({ clientId: key, text: z.string().trim().min(1).max(2000) })).mutation(async ({ input }) => {
      const conversation = await getConversationByClientId(input.clientId);
      if (!conversation) return { accepted: false, reason: "conversation_not_found" };
      const [settings, counts] = await Promise.all([getSettings(), getUsageCounts()]);
      if (!outboundCapAllows(counts.outboundWhatsApp, settings.whatsappMonthlyCap)) return { accepted: false, reason: "whatsapp_usage_hard_stop" };
      await pauseConversation(input.clientId);
      const result = await sendWhatsAppText({ to: conversation.waId, body: input.text });
      if (!result.accepted) return { accepted: false, reason: result.reason ?? "whatsapp_send_failed" };
      await incrementUsage("outboundWhatsApp");
      await captureLearnedAnswer(conversation.waId, input.text);
      await recordOwnerMessageByWaId(conversation.waId, input.text);
      await logMessage({ messageId: result.messageId ?? `owner-${Date.now()}`, clientId: input.clientId, waId: conversation.waId, role: "owner", body: input.text }).catch((error) => console.error("[Dashboard] message log failed", error));
      await recordEvent({ eventType: "dashboard_owner_message", severity: "info", title: "Owner message sent", detail: `Owner sent a dashboard message to ${conversation.profileName ?? conversation.waId}.`, clientId: input.clientId });
      return { accepted: true, messageId: result.messageId };
    }),
  }),
  // Replies written in shadow mode: the owner sends them as they are, edits them first, or discards them.
  shadowDrafts: router({
    list: protectedProcedure.query(() => listShadowDrafts()),
    send: protectedProcedure.input(z.object({ id: z.union([z.string(), z.number().int()]), text: z.string().trim().min(1).max(4000).optional() })).mutation(async ({ input }) => {
      const draft = await getShadowDraft(input.id);
      if (!draft?.clientId) return { accepted: false, reason: "draft_not_found" };
      const conversation = await getConversationByClientId(draft.clientId);
      if (!conversation) return { accepted: false, reason: "conversation_not_found" };
      const [settings, counts] = await Promise.all([getSettings(), getUsageCounts()]);
      if (!outboundCapAllows(counts.outboundWhatsApp, settings.whatsappMonthlyCap)) return { accepted: false, reason: "whatsapp_usage_hard_stop" };
      const text = input.text ?? draft.draft;
      // Taken out of the queue before it is sent, so a second click cannot send it twice; put back if the send fails.
      if (!(await settleShadowDraft(input.id, "approved", text))) return { accepted: false, reason: "draft_already_handled" };
      const result = await sendWhatsAppText({ to: conversation.waId, body: text });
      if (!result.accepted) {
        await restoreShadowDraft(input.id, draft.draft);
        return { accepted: false, reason: result.reason ?? "whatsapp_send_failed" };
      }
      await incrementUsage("outboundWhatsApp");
      await appendTranscriptMessage(draft.clientId, { role: "assistant", text, at: new Date().toISOString() });
      await logMessage({ messageId: result.messageId ?? `draft-${input.id}`, clientId: draft.clientId, waId: conversation.waId, role: "assistant", body: text, topic: "shadow_draft" }).catch((error) => console.error("[Dashboard] message log failed", error));
      await recordEvent({ eventType: "shadow_draft_sent", severity: "info", title: text === draft.draft ? "Draft sent as written" : "Draft sent after editing", detail: `Sent to ${conversation.profileName ?? conversation.waId}: ${text.slice(0, 300)}`, clientId: draft.clientId });
      return { accepted: true, messageId: result.messageId };
    }),
    discard: protectedProcedure.input(z.object({ id: z.union([z.string(), z.number().int()]) })).mutation(({ input }) => settleShadowDraft(input.id, "dismissed")),
  }),
  testChat: router({
    turn: protectedProcedure.input(z.object({ projectKey: key, incomingText: z.string().min(1).max(2000), recentMessages: z.array(z.object({ role: z.enum(["client", "assistant"]), text: z.string().max(4000) })).max(40), clientNotes: z.string().max(1000).optional(), state: z.enum(["new", "collecting", "brief_complete", "awaiting_deposit", "slip_received", "confirmed_by_owner", "needs_owner", "paused", "abandoned", "cancelled"]).default("collecting") })).mutation(async ({ input }): Promise<StructuredReply & { answeredFromFaqs?: boolean }> => {
      const selected = await getProjectByKey(input.projectKey);
      if (!selected) throw new TRPCError({ code: "NOT_FOUND", message: "The selected project no longer exists." });
      const parsedSnapshot = parseProjectSnapshot(selected.snapshot);
      const training = parsedSnapshot ? null : await getTraining(selected.projectKey);
      const projectIsApproved = selected.status === "approved" || selected.status === "active" || selected.readiness >= 100;
      if (!parsedSnapshot && (!training || (!training.approved && !projectIsApproved))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Complete and approve this project's training before using Test Chat." });
      const snapshot = await compileProjectSnapshot(selected.projectKey);
      if (!snapshot) throw new TRPCError({ code: "NOT_FOUND", message: "Failed to compile project snapshot." });
      // Same lookup as a real chat, so the owner can see which questions are answered without the AI.
      const instant = ["new", "collecting"].includes(input.state) ? matchFaqCache(input.incomingText, instantAnswersFor(snapshot), { englishForSinglish: ENV.faqEnglishForSinglish }) : null;
      if (instant) return { reply: instantReplyText(instant, snapshot), extractedFields: {}, intent: "question", needsOwner: false, needsOwnerReason: null, reliedOnFacts: [], answeredFromFaqs: true };
      const settings = await getSettings();
      return createConversationEngine({ project: snapshot, provider: settings.aiProvider }).runTurn({ clientId: "test-chat-sandbox", state: input.state, missingFields: [], recentMessages: input.recentMessages, incomingText: input.incomingText, isOn: true, withinCustomerWindow: true, monthlyOutbound: 0, monthlyCap: 900, clientNotes: input.clientNotes });
    }),
  }),
  whatsapp: router({
    status: protectedProcedure.query(() => baileysTransport.getStatus()),
    pair: protectedProcedure.mutation(() => baileysTransport.startPairing()),
    reconnect: protectedProcedure.mutation(async () => { await baileysTransport.start(); return baileysTransport.getStatus(); }),
    reset: protectedProcedure.mutation(() => baileysTransport.resetSession()),
  }),
  summary: router({
    weekly: protectedProcedure.query(async () => ({ text: await weeklySummaryText() })),
    sendWeekly: protectedProcedure.mutation(async () => ({ delivered: await sendWeeklySummary() })),
  }),
  orders: router({ confirm: protectedProcedure.input(z.object({ orderKey: key })).mutation(async ({ input }) => (await confirmOrder(input.orderKey)) || refuse("PRECONDITION_FAILED", "Only an order with a received slip can be confirmed.")), }),
  insights: router({ analyze: protectedProcedure.mutation(() => analyzeInsights()), approve: protectedProcedure.input(z.object({ id: z.union([z.string(), z.number().int()]), detail: z.string().trim().min(3).max(4000).optional() })).mutation(({ input }) => setInsightStatus(input.id, "approved", input.detail)), dismiss: protectedProcedure.input(z.object({ id: z.union([z.string(), z.number().int()]) })).mutation(({ input }) => setInsightStatus(input.id, "dismissed")), }),
});

export type AppRouter = typeof appRouter;
