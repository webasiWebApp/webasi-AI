import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { getUsageCounts } from "./db";
import { analyzeInsights, approveInsight, approveProject, activateProject, createProject, confirmOrder, ensureDefaults, getActiveProject, getSettings, listConversations, listEvents, listInsights, listOrders, listProjects, updateSettings, getTraining, saveTraining, approveTraining, pauseConversation, resumeConversation } from "./module-db";
import { baileysTransport } from "./whatsapp/baileys";
import { approvedRestaurantProject } from "./conversations/project";
import { createConversationEngine } from "./conversations/engine";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => { const cookieOptions = getSessionCookieOptions(ctx.req); ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 }); return { success: true } as const; }),
  }),
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
    update: protectedProcedure.input(z.object({ businessName: z.string().min(1).optional(), bankDetails: z.string().optional(), notificationEmail: z.string().email().nullable().optional(), whatsappMonthlyCap: z.number().int().min(1).max(10000).optional(), geminiDailyCap: z.number().int().min(1).max(10000).optional(), webasiEnabled: z.boolean().optional(), shadowMode: z.boolean().optional() })).mutation(({ input }) => updateSettings(input)),
  }),
  projects: router({
    create: protectedProcedure.input(z.object({ projectKey: z.string().min(2), name: z.string().min(2), snapshot: z.string().min(2) })).mutation(({ input }) => createProject(input)),
    approve: protectedProcedure.input(z.object({ projectKey: z.string() })).mutation(({ input }) => approveProject(input.projectKey)),
    activate: protectedProcedure.input(z.object({ projectKey: z.string() })).mutation(({ input }) => activateProject(input.projectKey)),
    training: protectedProcedure.input(z.object({ projectKey: z.string() })).query(({ input }) => getTraining(input.projectKey)),
    saveTraining: protectedProcedure.input(z.object({ projectKey: z.string(), answers: z.record(z.string(), z.string()), summary: z.string() })).mutation(({ input }) => saveTraining(input.projectKey, input.answers, input.summary)),
    approveTraining: protectedProcedure.input(z.object({ projectKey: z.string() })).mutation(({ input }) => approveTraining(input.projectKey)),
  }),
  conversations: router({
    pause: protectedProcedure.input(z.object({ clientId: z.string() })).mutation(({ input }) => pauseConversation(input.clientId)),
    resume: protectedProcedure.input(z.object({ clientId: z.string() })).mutation(({ input }) => resumeConversation(input.clientId)),
  }),
  testChat: router({
    turn: protectedProcedure.input(z.object({ projectKey: z.string(), incomingText: z.string().min(1), recentMessages: z.array(z.object({ role: z.enum(["client", "assistant"]), text: z.string() })), state: z.enum(["new", "collecting", "brief_complete", "awaiting_deposit", "slip_received", "confirmed_by_owner", "needs_owner", "paused", "abandoned", "cancelled"]).default("collecting") })).mutation(async ({ input }) => {
      const projects = await listProjects();
      const selected = projects.find((project) => project.projectKey === input.projectKey);
      let snapshot = approvedRestaurantProject;
      if (selected) {
        try {
          const candidate = JSON.parse(selected.snapshot) as Partial<typeof approvedRestaurantProject>;
          if (typeof candidate.packageName === "string" && typeof candidate.businessName === "string" && typeof candidate.priceLkr === "number" && Array.isArray(candidate.included) && Array.isArray(candidate.excluded) && Array.isArray(candidate.requiredClientInputs)) snapshot = candidate as typeof approvedRestaurantProject;
        } catch { snapshot = approvedRestaurantProject; }
      }
      return createConversationEngine({ project: snapshot }).runTurn({ clientId: "test-chat-sandbox", state: input.state, missingFields: [], recentMessages: input.recentMessages, incomingText: input.incomingText, isOn: true, withinCustomerWindow: true, monthlyOutbound: 0, monthlyCap: 900 });
    }),
  }),
  whatsapp: router({
    status: protectedProcedure.query(() => baileysTransport.getStatus()),
    pair: protectedProcedure.input(z.object({ phoneNumber: z.string().min(8) })).mutation(({ input }) => baileysTransport.requestPairingCode(input.phoneNumber)),
    reconnect: protectedProcedure.mutation(async () => { await baileysTransport.start(); return baileysTransport.getStatus(); }),
    reset: protectedProcedure.mutation(() => baileysTransport.resetSession()),
  }),
  orders: router({ confirm: protectedProcedure.input(z.object({ orderKey: z.string() })).mutation(({ input }) => confirmOrder(input.orderKey)), }),
  insights: router({ analyze: protectedProcedure.mutation(() => analyzeInsights()), approve: protectedProcedure.input(z.object({ id: z.number().int() })).mutation(({ input }) => approveInsight(input.id)), }),
});

export type AppRouter = typeof appRouter;
