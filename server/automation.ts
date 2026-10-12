import { ENV } from "./_core/env";
import { notifyOwner } from "./_core/notification";
import { getUsageCounts, incrementUsage, logMessage } from "./db";
import { compileProjectSnapshot, deleteOlderThan, eventsSince, getActiveProject, getSettings, getWeeklyStats, lastEventAt, listConversations, recordEvent, recordFollowUp, type WeeklyStats } from "./module-db";
import { draftFollowUp, modelForProvider } from "./conversations/engine";
import { outboundCapAllows } from "./conversations/sender";
import { canSendWhatsApp, sendWhatsAppText } from "./whatsapp/outbound";
import type { OrderState } from "../shared/webasi";

export const FOLLOW_UP_AFTER_HOURS = 6;
// WhatsApp only allows replies within 24h of the client's last message; stay well inside it.
export const FOLLOW_UP_BEFORE_HOURS = 23;
export const CHECK_INTERVAL_MS = 15 * 60 * 1000;

const colomboParts = (now: Date) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(now).map((part) => [part.type, part.value]));
  return { weekday: parts.weekday as string, hour: Number(parts.hour) % 24 };
};

// Messages to clients only go out at civil hours, Sri Lanka time.
export function isSendingHours(now: Date) { const { hour } = colomboParts(now); return hour >= 9 && hour < 20; }

export type FollowUpCandidate = {
  isPaused: boolean; handedOver?: boolean; state: string; intentScore?: string | null;
  lastClientMessageAt?: Date | string | null; followupSentAt?: Date | null; recentMessages: Array<{ role: string; text: string }>;
};

// One nudge per silence, only when WEBASI spoke last and the client has gone quiet.
export function dueForFollowUp(chat: FollowUpCandidate, now: Date) {
  if (chat.isPaused || chat.handedOver) return false;
  if (!["collecting", "awaiting_deposit"].includes(chat.state)) return false;
  if (chat.intentScore === "low") return false;
  if (!chat.lastClientMessageAt) return false;
  const lastClient = new Date(chat.lastClientMessageAt);
  const hoursQuiet = (now.getTime() - lastClient.getTime()) / 3_600_000;
  if (hoursQuiet < FOLLOW_UP_AFTER_HOURS || hoursQuiet > FOLLOW_UP_BEFORE_HOURS) return false;
  if (chat.followupSentAt && chat.followupSentAt >= lastClient) return false;
  return chat.recentMessages.at(-1)?.role === "assistant";
}

export function fallbackFollowUp(state: string, name?: string | null) {
  const hi = name ? `Hi ${name.split(" ")[0]}` : "Hi";
  return state === "awaiting_deposit"
    ? `${hi}, just checking in. Let me know if you have any questions about the deposit or the next steps 🙂`
    : `${hi}, just following up on our chat. Happy to help whenever you're ready. Any questions I can answer?`;
}

const parseTranscript = (raw: unknown) => { try { return (typeof raw === "string" ? JSON.parse(raw) : raw ?? []) as Array<{ role: string; text: string }>; } catch { return []; } };

export async function runFollowUps(now = new Date()) {
  const settings = await getSettings();
  if (!settings.webasiEnabled || !settings.followupsEnabled || !isSendingHours(now)) return 0;
  // Nothing can be sent while WhatsApp is disconnected. Without this check every tick spent an AI request on a draft
  // for each quiet chat and logged a failed send, again and again until the connection came back.
  if (!settings.shadowMode && !canSendWhatsApp()) return 0;
  const active = await getActiveProject();
  const project = active ? await compileProjectSnapshot(active.projectKey) : null;
  if (!project) return 0;
  let sent = 0;
  for (const chat of await listConversations()) {
    const recentMessages = parseTranscript(chat.recentMessages);
    if (!dueForFollowUp({ ...chat, recentMessages }, now)) continue;
    const counts = await getUsageCounts();
    if (!outboundCapAllows(counts.outboundWhatsApp, settings.whatsappMonthlyCap)) break;
    const name = chat.extractedFields?.clientName ?? chat.profileName;
    const aiAllowed = counts.geminiRequests < settings.geminiDailyCap;
    const drafted = aiAllowed ? await draftFollowUp({ project, recentMessages, clientName: name, clientNotes: chat.clientNotes, orderState: chat.state as OrderState, now, callModel: modelForProvider(settings.aiProvider) }) : null;
    if (aiAllowed) await incrementUsage("geminiRequests");
    const text = drafted ?? fallbackFollowUp(chat.state, name);
    if (settings.shadowMode) {
      await recordEvent({ eventType: "shadow_draft", title: "Shadow-mode follow-up draft", detail: text, clientId: chat.clientId });
      await recordFollowUp(chat.clientId, null, now);
      continue;
    }
    const result = await sendWhatsAppText({ to: chat.waId, body: text, humanize: true });
    if (!result.accepted) { await recordEvent({ eventType: "send_failed", severity: "error", title: "Follow-up not delivered", detail: result.reason ?? "unknown error", clientId: chat.clientId }); continue; }
    for (let part = 0; part < (result.parts ?? 1); part++) await incrementUsage("outboundWhatsApp");
    await recordFollowUp(chat.clientId, text, now);
    await logMessage({ messageId: result.messageId ?? `followup-${chat.clientId}-${now.getTime()}`, clientId: chat.clientId, waId: chat.waId, role: "assistant", body: text, topic: "follow_up" }).catch(() => undefined);
    await recordEvent({ eventType: "follow_up_sent", title: "Follow-up sent", detail: `Nudged ${chat.profileName ?? "a client"} after they went quiet: ${text}`, clientId: chat.clientId });
    sent++;
  }
  return sent;
}

// A client waits on the owner when WEBASI will not answer the chat (handed over, or paused by the owner) and the
// client spoke last. After three days a reminder is no longer news, so the wait is left to the weekly summary.
export const WAITING_REMINDER_MAX_HOURS = 72;
export type WaitingCandidate = { isPaused: boolean; handedOver?: boolean; needsOwner?: boolean; lastClientMessageAt?: Date | string | null; recentMessages: Array<{ role: string; text?: string }> };
export function waitingOnOwner(chat: WaitingCandidate, now: Date, afterHours: number) {
  if (!(chat.isPaused || chat.handedOver || chat.needsOwner)) return false;
  if (!chat.lastClientMessageAt || chat.recentMessages.at(-1)?.role !== "client") return false;
  const hours = (now.getTime() - new Date(chat.lastClientMessageAt).getTime()) / 3_600_000;
  return hours >= afterHours && hours <= WAITING_REMINDER_MAX_HOURS;
}

// One reminder per wait: the owner is told once that a client has been waiting, and again only if the client writes
// again and waits again. Sent to the owner's own WhatsApp chat like every other alert, at civil hours.
export async function runHandoverReminders(now = new Date()) {
  const afterHours = ENV.handoverReminderHours;
  if (afterHours <= 0 || !isSendingHours(now)) return 0;
  const waiting = (await listConversations())
    .map((chat) => ({ chat, messages: parseTranscript(chat.recentMessages) }))
    .filter(({ chat, messages }) => waitingOnOwner({ ...chat, recentMessages: messages }, now, afterHours));
  if (waiting.length === 0) return 0;

  const reminded = new Map<string, number>();
  for (const event of await eventsSince("handover_reminder", new Date(now.getTime() - (WAITING_REMINDER_MAX_HOURS + 24) * 3_600_000))) {
    if (event.clientId && !reminded.has(event.clientId)) reminded.set(event.clientId, new Date(event.createdAt).getTime());
  }
  const due = waiting.filter(({ chat }) => (reminded.get(chat.clientId) ?? 0) < new Date(chat.lastClientMessageAt).getTime());
  if (due.length === 0) return 0;

  const waitedHours = (chat: { lastClientMessageAt: string }) => Math.max(1, Math.round((now.getTime() - new Date(chat.lastClientMessageAt).getTime()) / 3_600_000));
  const lines = due.map(({ chat, messages }) => `• ${chat.profileName ?? chat.waId}, waiting about ${waitedHours(chat)} h: "${(messages.at(-1)?.text ?? "").slice(0, 120)}"`);
  const delivered = await notifyOwner({
    title: due.length === 1 ? "WEBASI: a client is still waiting for you" : `WEBASI: ${due.length} clients are still waiting for you`,
    content: `${lines.join("\n")}\nWEBASI is not replying in ${due.length === 1 ? "this chat" : "these chats"}. Reply yourself, or hand ${due.length === 1 ? "it" : "them"} back from Conversations.`,
  });
  // Not delivered (WhatsApp is down): nothing is marked as reminded, so the next run tries again.
  if (!delivered) return 0;
  for (const { chat } of due) await recordEvent({ eventType: "handover_reminder", severity: "warning", title: "Reminder sent: a client is waiting", detail: `${chat.profileName ?? "A client"} has been waiting about ${waitedHours(chat)} h for a reply from you.`, clientId: chat.clientId });
  return due.length;
}

// The shortest history the server itself relies on: duplicate detection and the weekly summary read recent messages,
// and reminders and the summary schedule read recent events. A configured period below these is raised to them.
const RETENTION_FLOOR_DAYS = { event_log: 14, messages: 30 } as const;

// Deletes old event-log entries and logged messages, once a day, and only when a retention period is configured.
export async function runRetention(now = new Date()) {
  const periods = { event_log: ENV.eventLogRetentionDays, messages: ENV.messageRetentionDays };
  if (periods.event_log <= 0 && periods.messages <= 0) return null;
  const last = await lastEventAt("retention_cleanup");
  if (last && now.getTime() - last.getTime() < 24 * 3_600_000) return null;
  const removed = { event_log: 0, messages: 0 };
  const kept: string[] = [];
  for (const table of ["event_log", "messages"] as const) {
    if (periods[table] <= 0) continue;
    const days = Math.max(periods[table], RETENTION_FLOOR_DAYS[table]);
    removed[table] = await deleteOlderThan(table, new Date(now.getTime() - days * 86_400_000));
    kept.push(`${removed[table]} ${table === "event_log" ? "event-log entries" : "logged messages"} older than ${days} days`);
  }
  await recordEvent({ eventType: "retention_cleanup", title: "Old records removed", detail: `Removed ${kept.join(" and ")}.` });
  return removed;
}

const lkr = (value: number) => `LKR ${value.toLocaleString("en-LK")}`;

export function buildWeeklySummary(stats: WeeklyStats, usage: { outboundWhatsApp: number }, caps: { whatsappMonthlyCap: number }) {
  const lines = [
    `💬 ${stats.activeChats} active chats (${stats.newChats} new) · ${stats.messagesIn} messages in, ${stats.messagesOut} out`,
    `🔥 ${stats.hotLeads} hot lead${stats.hotLeads === 1 ? "" : "s"}${stats.frustrated ? ` · 😟 ${stats.frustrated} frustrated` : ""} · 🙋 ${stats.handovers} handed to you`,
    `📅 ${stats.meetingsRequested} meeting${stats.meetingsRequested === 1 ? "" : "s"} requested`,
    `🧾 ${stats.ordersCreated} new order${stats.ordersCreated === 1 ? "" : "s"} · ✅ ${stats.confirmedOrders} confirmed (${lkr(stats.confirmedDeposits)} deposits)${stats.slipsWaiting ? ` · ⏳ ${stats.slipsWaiting} slip${stats.slipsWaiting === 1 ? "" : "s"} to verify` : ""}`,
    `🔁 ${stats.followUpsSent} follow-up${stats.followUpsSent === 1 ? "" : "s"} sent`,
    stats.topObjections.length ? `🤔 Top objections: ${stats.topObjections.map(([name, total]) => `${name.replaceAll("_", " ")} (${total})`).join(", ")}` : "",
    `📚 ${stats.knowledgeAdded} answer${stats.knowledgeAdded === 1 ? "" : "s"} added to the knowledge base${stats.learnedAnswersPending ? ` · ${stats.learnedAnswersPending} learned answer${stats.learnedAnswersPending === 1 ? "" : "s"} waiting on Insights` : ""}`,
    `📈 WhatsApp this month: ${usage.outboundWhatsApp}/${caps.whatsappMonthlyCap}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function weeklySummaryText(now = new Date()) {
  const stats = await getWeeklyStats(now);
  if (!stats) return null;
  const [usage, settings] = await Promise.all([getUsageCounts(now), getSettings()]);
  return buildWeeklySummary(stats, usage, settings);
}

export async function sendWeeklySummary(now = new Date()) {
  const text = await weeklySummaryText(now);
  if (!text) return false;
  const delivered = await notifyOwner({ title: "WEBASI weekly summary", content: text });
  await recordEvent({ eventType: "weekly_summary", severity: delivered ? "info" : "warning", title: delivered ? "Weekly summary sent" : "Weekly summary not delivered", detail: text });
  return delivered;
}

// Monday from 09:00 Sri Lanka time, once a week.
export function weeklySummaryDue(now: Date, lastSentAt: Date | null) {
  const { weekday, hour } = colomboParts(now);
  return weekday === "Mon" && hour >= 9 && (!lastSentAt || now.getTime() - lastSentAt.getTime() > 6 * 86_400_000);
}

async function tick() {
  try { await runFollowUps(); } catch (error) { console.error("[Automation] follow-ups failed", error instanceof Error ? error.message : error); }
  try { await runHandoverReminders(); } catch (error) { console.error("[Automation] waiting-client reminders failed", error instanceof Error ? error.message : error); }
  try { await runRetention(); } catch (error) { console.error("[Automation] retention failed", error instanceof Error ? error.message : error); }
  try {
    const settings = await getSettings();
    if (settings.weeklySummaryEnabled && weeklySummaryDue(new Date(), await lastEventAt("weekly_summary"))) await sendWeeklySummary();
  } catch (error) { console.error("[Automation] weekly summary failed", error instanceof Error ? error.message : error); }
}

// ponytail: in-process timer; relies on the keep-alive ping so Render doesn't sleep. Move to a cron job if you scale out.
export function startAutomation() {
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}
