import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { ENV } from "./_core/env";
import { getUsageCounts, incrementUsage, logMessage } from "./db";
import { analyzeInsights, setInsightStatus, approveProject, activateProject, createProject, confirmOrder, ensureDefaults, getActiveProject, getSettings, listConversations, listEvents, listInsights, listOrders, listProjects, updateSettings, getTraining, saveTraining, approveTraining, pauseConversation, recordOwnerMessageByWaId, captureLearnedAnswer, setAiProvider, resumeConversation, recordEvent, compileProjectSnapshot, listKnowledgeGaps, answerKnowledgeGap } from "./module-db";
import { baileysTransport } from "./whatsapp/baileys";
import { outboundCapAllows } from "./conversations/sender";
import { sendWeeklySummary, weeklySummaryText } from "./automation";
import { createConversationEngine } from "./conversations/engine";
import { parseProjectSnapshot } from "../shared/webasi";

export const appRouter = router({
  dashboard: router({
    overview: protectedProcedure.query(async () => { await ensureDefaults(); const [settings, activeProject, usage, conversations, orders, events] = await Promise.all([getSettings(), getActiveProject(), getUsageCounts(), listConversations(), listOrders(), listEvents()]); return { settings, activeProject, usage, conversations, orders, events }; }),
    conversations: protectedProcedure.query(() => listConversations()),
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
    create: protectedProcedure.input(z.object({ projectKey: z.string().min(2), name: z.string().min(2), snapshot: z.string().min(2) })).mutation(({ input }) => createProject(input)),
    approve: protectedProcedure.input(z.object({ projectKey: z.string() })).mutation(({ input }) => approveProject(input.projectKey)),
    activate: protectedProcedure.input(z.object({ projectKey: z.string() })).mutation(({ input }) => activateProject(input.projectKey)),
    training: protectedProcedure.input(z.object({ projectKey: z.string() })).query(({ input }) => getTraining(input.projectKey)),
    saveTraining: protectedProcedure.input(z.object({ projectKey: z.string(), answers: z.record(z.string(), z.string()), summary: z.string() })).mutation(({ input }) => saveTraining(input.projectKey, input.answers, input.summary)),
    approveTraining: protectedProcedure.input(z.object({ projectKey: z.string() })).mutation(({ input }) => approveTraining(input.projectKey)),
  }),
  knowledgeGaps: router({
    list: protectedProcedure.query(() => listKnowledgeGaps()),
    answer: protectedProcedure.input(z.object({ id: z.union([z.string(), z.number().int()]), answer: z.string().trim().min(3).max(4000) })).mutation(({ input }) => answerKnowledgeGap(input.id, input.answer)),
  }),
  conversations: router({
    pause: protectedProcedure.input(z.object({ clientId: z.string() })).mutation(({ input }) => pauseConversation(input.clientId)),
    resume: protectedProcedure.input(z.object({ clientId: z.string() })).mutation(({ input }) => resumeConversation(input.clientId)),
    ownerMessage: protectedProcedure.input(z.object({ clientId: z.string(), text: z.string().trim().min(1).max(2000) })).mutation(async ({ input }) => {
      const conversation = (await listConversations()).find((row) => row.clientId === input.clientId);
      if (!conversation) return { accepted: false, reason: "conversation_not_found" };
      const settings = await getSettings();
      const counts = await getUsageCounts();
      if (!outboundCapAllows(counts.outboundWhatsApp, settings.whatsappMonthlyCap)) return { accepted: false, reason: "whatsapp_usage_hard_stop" };
      await pauseConversation(input.clientId);
      const result = await baileysTransport.sendText({ to: conversation.waId, body: input.text });
      if (!result.accepted) return { accepted: false, reason: result.reason ?? "whatsapp_send_failed" };
      await incrementUsage("outboundWhatsApp");
      await captureLearnedAnswer(conversation.waId, input.text);
      await recordOwnerMessageByWaId(conversation.waId, input.text);
      await logMessage({ messageId: result.messageId ?? `owner-${Date.now()}`, clientId: input.clientId, waId: conversation.waId, role: "owner", body: input.text }).catch((error) => console.error("[Dashboard] message log failed", error));
      await recordEvent({ eventType: "dashboard_owner_message", severity: "info", title: "Owner message sent", detail: `Owner sent a dashboard message to ${conversation.profileName ?? conversation.waId}.`, clientId: input.clientId });
      return { accepted: true, messageId: result.messageId };
    }),
  }),
  testChat: router({
    turn: protectedProcedure.input(z.object({ projectKey: z.string(), incomingText: z.string().min(1).max(2000), recentMessages: z.array(z.object({ role: z.enum(["client", "assistant"]), text: z.string().max(4000) })).max(40), clientNotes: z.string().max(1000).optional(), state: z.enum(["new", "collecting", "brief_complete", "awaiting_deposit", "slip_received", "confirmed_by_owner", "needs_owner", "paused", "abandoned", "cancelled"]).default("collecting") })).mutation(async ({ input }) => {
      const projects = await listProjects();
      const selected = projects.find((project) => project.projectKey === input.projectKey);
      if (!selected) throw new TRPCError({ code: "NOT_FOUND", message: "The selected project no longer exists." });
      const parsedSnapshot = parseProjectSnapshot(selected.snapshot);
      const training = parsedSnapshot ? null : await getTraining(selected.projectKey);
      const projectIsApproved = selected.status === "approved" || selected.status === "active" || selected.readiness >= 100;
      if (!parsedSnapshot && (!training || (!training.approved && !projectIsApproved))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Complete and approve this project's training before using Test Chat." });
      const snapshot = await compileProjectSnapshot(selected.projectKey);
      if (!snapshot) throw new TRPCError({ code: "NOT_FOUND", message: "Failed to compile project snapshot." });
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
  orders: router({ confirm: protectedProcedure.input(z.object({ orderKey: z.string() })).mutation(({ input }) => confirmOrder(input.orderKey)), }),
  insights: router({ analyze: protectedProcedure.mutation(() => analyzeInsights()), approve: protectedProcedure.input(z.object({ id: z.union([z.string(), z.number().int()]), detail: z.string().trim().min(3).max(4000).optional() })).mutation(({ input }) => setInsightStatus(input.id, "approved", input.detail)), dismiss: protectedProcedure.input(z.object({ id: z.union([z.string(), z.number().int()]) })).mutation(({ input }) => setInsightStatus(input.id, "dismissed")), }),
});

export type AppRouter = typeof appRouter;
