import { and, desc, eq, ne } from "drizzle-orm";
import { getDb, incrementUsage } from "./db";
import { getSupabaseServer } from "./_core/supabase";
import { ENV } from "./_core/env";
import { conversations, eventLogs, insights, orders, projects, settings, trainingSessions } from "../drizzle/schema";
import { approvedRestaurantProject, type ApprovedProjectSnapshot } from "./conversations/project";
import { canActivateProject, formatAutomationAudit, parsePriceLkr, trainingReadiness } from "../shared/webasi";
import { buildFaqCache, type FaqEntry, type GeneratedFaqs } from "./conversations/faq-cache";
import { generateClientFaqs, knowledgeFingerprint } from "./conversations/faq-generator";

const useSupabase = () => Boolean(ENV.supabaseUrl && ENV.supabaseServiceRoleKey);

let _defaultsEnsured = false;

function createTtlCache<T>(ttlMs: number) {
  let value: T | undefined;
  let expiresAt = 0;
  return {
    get(): T | undefined { return Date.now() < expiresAt ? value : undefined; },
    set(v: T) { value = v; expiresAt = Date.now() + ttlMs; },
    invalidate() { expiresAt = 0; },
  };
}

// Settings, the active project and its compiled facts are read on every incoming message but change rarely.
// Writes in this process invalidate them at once; the short TTL bounds how long a change made from another
// server instance (for example the automation switch flipped from a separately hosted dashboard) takes to apply.
const settingsCache = createTtlCache<Awaited<ReturnType<typeof loadSettings>>>(15_000);
const activeProjectCache = createTtlCache<Awaited<ReturnType<typeof loadActiveProject>>>(30_000);
const compiledSnapshotCache = new Map<string, { value: Awaited<ReturnType<typeof buildProjectSnapshot>>; expiresAt: number }>();
function invalidateProjectCaches() { activeProjectCache.invalidate(); compiledSnapshotCache.clear(); }

const mapProject = (row: any) => row ? { ...row, projectKey: row.project_key, readiness: row.readiness ?? 0, snapshot: typeof row.snapshot === "string" ? row.snapshot : JSON.stringify(row.snapshot ?? {}), createdAt: row.created_at, updatedAt: row.updated_at } : null;
const mapConversation = (row: any) => ({ ...row, clientId: row.client_id, waId: row.wa_id, profileName: row.profile_name, isPaused: Boolean(row.is_paused), missingFields: row.missing_fields ?? [], extractedFields: row.extracted_fields ?? {}, recentMessages: JSON.stringify(row.recent_messages ?? []), lastClientMessageAt: row.last_client_message_at, intentScore: row.intent_score as "high" | "medium" | "low" | null, handedOver: Boolean(row.handed_over), needsOwner: Boolean(row.handed_over) || row.state === "needs_owner", sentiment: row.sentiment as string | null, objection: row.objection as string | null, language: row.language as string | null, clientNotes: (row.client_notes ?? "") as string, followupSentAt: row.followup_sent_at ? new Date(row.followup_sent_at) : null, createdAt: row.created_at, updatedAt: row.updated_at });
const mapEvent = (row: any) => ({ ...row, eventType: row.event_type, clientId: row.client_id, createdAt: row.created_at });

export async function ensureDefaults() {
  if (_defaultsEnsured) return;
  if (useSupabase()) {
    const supabase = getSupabaseServer();
    const { data: existingSettings, error: settingsError } = await supabase.from("settings").select("id").eq("singleton_key", "owner").maybeSingle();
    if (settingsError) throw settingsError;
    if (!existingSettings) {
      const { error } = await supabase.from("settings").insert({ singleton_key: "owner", business_name: approvedRestaurantProject.businessName, bank_details: "Configure bank details in Settings before activating deposits.", webasi_enabled: true });
      if (error) throw error;
    }
    const { data: existingProject, error: projectError } = await supabase.from("projects").select("id").eq("project_key", approvedRestaurantProject.id).maybeSingle();
    if (projectError) throw projectError;
    if (!existingProject) {
      const { error } = await supabase.from("projects").insert({ project_key: approvedRestaurantProject.id, name: approvedRestaurantProject.packageName, status: "active", readiness: 100, version: approvedRestaurantProject.version, snapshot: approvedRestaurantProject });
      if (error) throw error;
    }
    _defaultsEnsured = true;
    return;
  }
  const db = await getDb(); if (!db) return;
  const existingSettings = await db.select().from(settings).where(eq(settings.singletonKey, "owner")).limit(1);
  if (!existingSettings[0]) await db.insert(settings).values({ singletonKey: "owner", businessName: approvedRestaurantProject.businessName, bankDetails: "Configure bank details in Settings before activating deposits.", notificationEmail: null, webasiEnabled: 1, shadowMode: 0 });
  const existingProject = await db.select().from(projects).where(eq(projects.projectKey, approvedRestaurantProject.id)).limit(1);
  if (!existingProject[0]) await db.insert(projects).values({ projectKey: approvedRestaurantProject.id, name: approvedRestaurantProject.packageName, status: "active", readiness: 100, version: approvedRestaurantProject.version, snapshot: JSON.stringify(approvedRestaurantProject) });
  _defaultsEnsured = true;
}

export async function listProjects() { if (useSupabase()) { const { data, error } = await getSupabaseServer().from("projects").select("*").order("updated_at", { ascending: false }); if (error) throw error; return (data ?? []).map(mapProject); } const db = await getDb(); if (!db) return []; return db.select().from(projects).orderBy(desc(projects.updatedAt)); }
export async function getProjectByKey(projectKey: string) {
  if (useSupabase()) {
    const { data, error } = await getSupabaseServer().from("projects").select("*").eq("project_key", projectKey).maybeSingle();
    if (error) throw error;
    return mapProject(data);
  }
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(projects).where(eq(projects.projectKey, projectKey)).limit(1);
  return rows[0] ?? null;
}
async function loadActiveProject() { if (useSupabase()) { const supabase = getSupabaseServer(); const { data, error } = await supabase.from("projects").select("*").eq("status", "active").limit(1).maybeSingle(); if (error) throw error; if (data) return mapProject(data); const fallback = await supabase.from("projects").select("*").eq("status", "approved").limit(1).maybeSingle(); if (fallback.error) throw fallback.error; return mapProject(fallback.data); } const db = await getDb(); if (!db) return null; const rows = await db.select().from(projects).where(eq(projects.status, "active")).limit(1); return rows[0] ?? (await db.select().from(projects).where(eq(projects.status, "approved")).limit(1))[0] ?? null; }
export async function getActiveProject() { const cached = activeProjectCache.get(); if (cached !== undefined) return cached; const result = await loadActiveProject(); activeProjectCache.set(result); return result; }
export async function createProject(input: { projectKey: string; name: string; snapshot: string }) { invalidateProjectCaches(); if (useSupabase()) { const { data, error } = await getSupabaseServer().from("projects").insert({ project_key: input.projectKey, name: input.name, status: "training", readiness: 0, version: 1, snapshot: JSON.parse(input.snapshot) }).select("*").single(); if (error) throw error; return mapProject(data); } const db = await getDb(); if (!db) return null; await db.insert(projects).values({ ...input, status: "training", readiness: 0, version: 1 }); return db.select().from(projects).where(eq(projects.projectKey, input.projectKey)).limit(1).then((rows) => rows[0] ?? null); }
export async function approveProject(projectKey: string) { invalidateProjectCaches(); if (useSupabase()) { const { error } = await getSupabaseServer().from("projects").update({ status: "approved", readiness: 100, updated_at: new Date().toISOString() }).eq("project_key", projectKey); if (error) throw error; return true; } const db = await getDb(); if (!db) return false; await db.update(projects).set({ status: "approved", readiness: 100, updatedAt: new Date() }).where(eq(projects.projectKey, projectKey)); return true; }
export async function activateProject(projectKey: string) { invalidateProjectCaches(); settingsCache.invalidate(); if (useSupabase()) { const supabase = getSupabaseServer(); const { data: project, error } = await supabase.from("projects").select("status, readiness").eq("project_key", projectKey).maybeSingle(); if (error) throw error; if (!project || !canActivateProject(project.status === "ready" || project.status === "approved" || project.readiness >= 100)) return false; const deactivate = await supabase.from("projects").update({ status: "approved" }).eq("status", "active"); if (deactivate.error) throw deactivate.error; const activate = await supabase.from("projects").update({ status: "active", updated_at: new Date().toISOString() }).eq("project_key", projectKey); if (activate.error) throw activate.error; return true; } const db = await getDb(); if (!db) return false; const rows = await db.select().from(projects).where(eq(projects.projectKey, projectKey)).limit(1); const project = rows[0]; if (!project || !canActivateProject(project.status === "ready" || project.status === "approved" || project.readiness >= 100)) return false; await db.update(projects).set({ status: "approved" }).where(eq(projects.status, "active")); await db.update(projects).set({ status: "active", updatedAt: new Date() }).where(eq(projects.projectKey, projectKey)); return true; }

async function loadSettings() { if (useSupabase()) { await ensureDefaults(); const { data, error } = await getSupabaseServer().from("settings").select("*").eq("singleton_key", "owner").single(); if (error) throw error; return { ...data, businessName: data.business_name, bankDetails: data.bank_details, notificationEmail: data.notification_email, whatsappMonthlyCap: data.whatsapp_monthly_cap, geminiDailyCap: data.gemini_daily_cap, webasiEnabled: Boolean(data.webasi_enabled), shadowMode: Boolean(data.shadow_mode), aiProvider: (data.ai_provider ?? ENV.aiProvider) as string, followupsEnabled: data.followups_enabled !== false, weeklySummaryEnabled: data.weekly_summary_enabled !== false }; } const db = await getDb(); if (!db) return { businessName: approvedRestaurantProject.businessName, bankDetails: "", notificationEmail: null, whatsappMonthlyCap: 900, geminiDailyCap: 500, webasiEnabled: false, shadowMode: false, aiProvider: ENV.aiProvider, followupsEnabled: false, weeklySummaryEnabled: false }; await ensureDefaults(); const rows = await db.select().from(settings).where(eq(settings.singletonKey, "owner")).limit(1); const row = rows[0]; return { ...row, webasiEnabled: row?.webasiEnabled === 1, shadowMode: row?.shadowMode === 1, aiProvider: ENV.aiProvider, followupsEnabled: false, weeklySummaryEnabled: false }; }
export async function getSettings() { const cached = settingsCache.get(); if (cached) return cached; const result = await loadSettings(); settingsCache.set(result); return result; }
export async function updateSettings(input: { businessName?: string; bankDetails?: string; notificationEmail?: string | null; whatsappMonthlyCap?: number; geminiDailyCap?: number; webasiEnabled?: boolean; shadowMode?: boolean; followupsEnabled?: boolean; weeklySummaryEnabled?: boolean }) {
  settingsCache.invalidate();
  invalidateProjectCaches(); // the compiled facts fall back to the business name from settings
  await ensureDefaults();
  if (useSupabase()) {
    const supabase = getSupabaseServer();
    const { data: current } = await supabase.from("settings").select("*").eq("singleton_key", "owner").single();
    if (input.webasiEnabled === true) {
      const { data: active } = await supabase.from("projects").select("id").eq("status", "active").limit(1).maybeSingle();
      if (!active) return false;
    }
    const { data: activeProject } = await supabase.from("projects").select("name").eq("status", "active").limit(1).maybeSingle();
    const set: Record<string, unknown> = {};
    if (input.businessName !== undefined) set.business_name = input.businessName;
    if (input.bankDetails !== undefined) set.bank_details = input.bankDetails;
    if (input.notificationEmail !== undefined) set.notification_email = input.notificationEmail;
    if (input.whatsappMonthlyCap !== undefined) set.whatsapp_monthly_cap = input.whatsappMonthlyCap;
    if (input.geminiDailyCap !== undefined) set.gemini_daily_cap = input.geminiDailyCap;
    if (input.webasiEnabled !== undefined) set.webasi_enabled = input.webasiEnabled;
    if (input.shadowMode !== undefined) set.shadow_mode = input.shadowMode;
    if (input.followupsEnabled !== undefined) set.followups_enabled = input.followupsEnabled;
    if (input.weeklySummaryEnabled !== undefined) set.weekly_summary_enabled = input.weeklySummaryEnabled;
    const { error } = await supabase.from("settings").update(set).eq("singleton_key", "owner");
    if (error) throw error;
    if (input.webasiEnabled !== undefined && Boolean(current?.webasi_enabled) !== input.webasiEnabled) await recordEvent({ eventType: "automation_state_changed", severity: input.webasiEnabled ? "warning" : "info", title: input.webasiEnabled ? "Automation enabled" : "Automation disabled", detail: formatAutomationAudit({ actor: "owner", project: activeProject?.name ?? "none", previous: Boolean(current?.webasi_enabled) ? "ON" : "OFF", next: input.webasiEnabled ? "ON" : "OFF", detail: input.webasiEnabled ? (input.shadowMode ? "Replies remain drafts because shadow mode is enabled." : "Live replies are permitted while WhatsApp is connected.") : "Incoming messages remain logged without replies." }) });
    if (input.shadowMode !== undefined && Boolean(current?.shadow_mode) !== input.shadowMode) await recordEvent({ eventType: "shadow_mode_changed", severity: "info", title: input.shadowMode ? "Shadow mode enabled" : "Shadow mode disabled", detail: formatAutomationAudit({ actor: "owner", project: activeProject?.name ?? "none", previous: Boolean(current?.shadow_mode) ? "SHADOW" : "NORMAL", next: input.shadowMode ? "SHADOW" : "NORMAL", detail: input.shadowMode ? "WEBASI will draft replies for review without sending them to clients." : "WEBASI returned to its normal sending policy when enabled." }) });
    return true;
  }
  const db = await getDb(); if (!db) return false;
  const current = (await db.select().from(settings).where(eq(settings.singletonKey, "owner")).limit(1))[0];
  if (input.webasiEnabled === true) { const active = await db.select().from(projects).where(eq(projects.status, "active")).limit(1); if (!active[0]) return false; }
  const activeProject = (await db.select().from(projects).where(eq(projects.status, "active")).limit(1))[0];
  const set: Record<string, unknown> = {};
  const { followupsEnabled: _followups, weeklySummaryEnabled: _weekly, ...mysqlInput } = input;
  for (const [key, value] of Object.entries(mysqlInput)) if (value !== undefined) set[key] = typeof value === "boolean" ? (value ? 1 : 0) : value;
  await db.update(settings).set(set).where(eq(settings.singletonKey, "owner"));
  if (input.webasiEnabled !== undefined && Number(current?.webasiEnabled ?? 0) !== (input.webasiEnabled ? 1 : 0)) await recordEvent({ eventType: "automation_state_changed", severity: input.webasiEnabled ? "warning" : "info", title: input.webasiEnabled ? "Automation enabled" : "Automation disabled", detail: formatAutomationAudit({ actor: "owner", project: activeProject?.name ?? "none", previous: Number(current?.webasiEnabled ?? 0) === 1 ? "ON" : "OFF", next: input.webasiEnabled ? "ON" : "OFF", detail: input.webasiEnabled ? (input.shadowMode ? "Replies remain drafts because shadow mode is enabled." : "Live replies are permitted while WhatsApp is connected.") : "Incoming messages remain logged without replies." }) });
  if (input.shadowMode !== undefined && Number(current?.shadowMode ?? 0) !== (input.shadowMode ? 1 : 0)) await recordEvent({ eventType: "shadow_mode_changed", severity: "info", title: input.shadowMode ? "Shadow mode enabled" : "Shadow mode disabled", detail: formatAutomationAudit({ actor: "owner", project: activeProject?.name ?? "none", previous: Number(current?.shadowMode ?? 0) === 1 ? "SHADOW" : "NORMAL", next: input.shadowMode ? "SHADOW" : "NORMAL", detail: input.shadowMode ? "WEBASI will draft replies for review without sending them to clients." : "WEBASI returned to its normal sending policy when enabled." }) });
  return true;
}

const mapOrder = (row: any) => ({ ...row, orderKey: row.order_key, clientId: row.client_id, waId: row.wa_id, packageName: row.package_name, depositAmount: row.deposit_amount, slipMediaId: row.slip_media_id, createdAt: row.created_at, updatedAt: row.updated_at });
export async function createOrder(input: { orderKey: string; clientId: string; waId: string; packageName: string; depositAmount: number; slipMediaId?: string; state?: "awaiting_deposit" | "slip_received" | "confirmed_by_owner"; notes?: string }) { if (useSupabase()) { const { error } = await getSupabaseServer().from("orders").upsert({ order_key: input.orderKey, client_id: input.clientId, wa_id: input.waId, package_name: input.packageName, deposit_amount: input.depositAmount, slip_media_id: input.slipMediaId ?? null, state: input.state ?? "awaiting_deposit", notes: input.notes ?? "", updated_at: new Date().toISOString() }, { onConflict: "order_key" }); if (error) throw error; return true; } const db = await getDb(); if (!db) return null; await db.insert(orders).values({ ...input, slipMediaId: input.slipMediaId ?? null, state: input.state ?? "awaiting_deposit", notes: input.notes ?? "" }); return true; }
export async function markOrderSlipReceived(waId: string, slipMediaId?: string) { if (useSupabase()) { const { data, error } = await getSupabaseServer().from("orders").update({ state: "slip_received", slip_media_id: slipMediaId ?? null, notes: "Payment slip received; owner verification required.", updated_at: new Date().toISOString() }).eq("wa_id", waId).eq("state", "awaiting_deposit").select("id"); if (error) throw error; return (data ?? []).length > 0; } const db = await getDb(); if (!db) return false; const rows = await db.select().from(orders).where(and(eq(orders.waId, waId), eq(orders.state, "awaiting_deposit"))).limit(1); if (!rows[0]) return false; await db.update(orders).set({ state: "slip_received", slipMediaId: slipMediaId ?? null, notes: "Payment slip received; owner verification required.", updatedAt: new Date() }).where(eq(orders.id, rows[0].id)); return true; }
export async function listOrders() { if (useSupabase()) { const { data, error } = await getSupabaseServer().from("orders").select("*").order("updated_at", { ascending: false }); if (error) throw error; return (data ?? []).map(mapOrder); } const db = await getDb(); if (!db) return []; return db.select().from(orders).orderBy(desc(orders.updatedAt)); }
export async function confirmOrder(orderKey: string) { if (useSupabase()) { const { error } = await getSupabaseServer().from("orders").update({ state: "confirmed_by_owner", updated_at: new Date().toISOString() }).eq("order_key", orderKey); if (error) throw error; return true; } const db = await getDb(); if (!db) return false; await db.update(orders).set({ state: "confirmed_by_owner", updatedAt: new Date() }).where(eq(orders.orderKey, orderKey)); return true; }

export async function recordEvent(input: { eventType: string; severity?: "info" | "warning" | "error"; title: string; detail: string; clientId?: string }) { if (useSupabase()) { const { error } = await getSupabaseServer().from("event_log").insert({ event_type: input.eventType, severity: input.severity ?? "info", title: input.title, detail: input.detail, client_id: input.clientId ?? null }); if (error) throw error; return; } const db = await getDb(); if (!db) return; await db.insert(eventLogs).values({ ...input, severity: input.severity ?? "info", clientId: input.clientId ?? null }); }
export async function listEvents() { if (useSupabase()) { const { data, error } = await getSupabaseServer().from("event_log").select("*").order("created_at", { ascending: false }).limit(50); if (error) throw error; return (data ?? []).map(mapEvent); } const db = await getDb(); if (!db) return []; return db.select().from(eventLogs).orderBy(desc(eventLogs.createdAt)).limit(50); }
const mapInsight = (row: any) => ({ ...row, createdAt: row.created_at });
export async function listInsights() { if (useSupabase()) { const { data, error } = await getSupabaseServer().from("insights").select("*").neq("status", "dismissed").order("created_at", { ascending: false }); if (error) throw error; return (data ?? []).map(mapInsight); } const db = await getDb(); if (!db) return []; return db.select().from(insights).where(ne(insights.status, "dismissed")).orderBy(desc(insights.createdAt)); }
export async function setInsightStatus(id: string | number, status: "approved" | "dismissed", detail?: string) {
  if (useSupabase()) {
    const supabase = getSupabaseServer();
    const { data: insight, error } = await supabase.from("insights").update({ status, ...(detail ? { detail } : {}) }).eq("id", id).select("category, detail").maybeSingle();
    if (error) throw error;
    if (status === "approved" && insight?.category === "Learned answer") await appendProjectFaq(insight.detail);
    return true;
  }
  const db = await getDb(); if (!db) return false; await db.update(insights).set({ status }).where(eq(insights.id, Number(id))); return true;
}
export async function appendProjectFaq(entry: string) {
  const active = await getActiveProject();
  if (!active) throw new Error("Activate a project before adding answers to its knowledge base.");
  const supabase = getSupabaseServer();
  const training = await getTraining(active.projectKey);
  const answers = { ...training.answers, faqs: [training.answers.faqs?.trim(), entry.trim()].filter(Boolean).join("\n\n") };
  const { error } = await supabase.from("training_sessions").upsert({ project_key: active.projectKey, checklist: training.checklist, answers, summary: training.summary, approved: training.approved, updated_at: new Date().toISOString() }, { onConflict: "project_key" });
  if (error) throw error;
  invalidateProjectCaches();
  // The generated client FAQs are still right after an added answer; re-stamp them so they are not treated as out of date.
  await refreshInstantAnswers(active.projectKey).catch((err) => console.warn("[Training] Instant answers refresh failed (non-fatal)", err));
  await recordEvent({ eventType: "knowledge_added", severity: "info", title: "Answer added to knowledge base", detail: `Added to ${active.name} FAQs: ${entry.slice(0, 300)}` });
}
export async function analyzeInsights() {
  const rows = await listConversations();
  const messages = rows.flatMap((row) => { try { return JSON.parse(row.recentMessages) as Array<{ role?: string; text?: string }>; } catch { return []; } });
  const clientText = messages.filter((message) => message.role === "client").map((message) => message.text ?? "").join(" ").toLowerCase();
  const priceMentions = (clientText.match(/price|cost|budget|expensive|discount|cheap/g) ?? []).length;
  const singlishMentions = (clientText.match(/mata|one|puluwan|kiyada|hari|eka|ganna/g) ?? []).length;
  const dropoffStates = rows.filter((row) => ["collecting", "awaiting_deposit", "needs_owner"].includes(row.state));
  const handovers = rows.filter((row) => row.state === "needs_owner" || ("handedOver" in row && row.handedOver));
  const generated = [
    priceMentions > 0 ? { title: "Price and budget questions recur in client chats", detail: `${priceMentions} price-related mentions were found across the latest ${rows.length} conversations. Review the package FAQ and objection handling before adding anything to project knowledge.`, category: "Objection", status: "suggested" as const } : null,
    singlishMentions > 0 ? { title: "Clients frequently use English and Singlish together", detail: `${singlishMentions} Singlish markers were found in recent client messages. Keep mirroring the client’s language style and review the tone guidance.`, category: "Language", status: "suggested" as const } : null,
    dropoffStates.length > 0 ? { title: "Conversations are dropping off before confirmation", detail: `${dropoffStates.length} conversations remain in collecting, awaiting deposit, or needs owner states. Review the next-step prompts and escalation rules.`, category: "Drop-off", status: "suggested" as const } : null,
    handovers.length > 0 ? { title: "Questions are being handed over to you", detail: `${handovers.length} conversations were escalated because WEBASI could not answer from the project facts. Open them in Conversations and add the missing answers to the project's training.`, category: "Handover", status: "suggested" as const } : null,
  ].filter((item): item is { title: string; detail: string; category: string; status: "suggested" } => Boolean(item));
  if (useSupabase()) {
    const supabase = getSupabaseServer();
    const { error } = await supabase.from("insights").delete().eq("status", "suggested"); if (error) throw error;
    if (generated.length > 0) { const { error: insertError } = await supabase.from("insights").insert(generated); if (insertError) throw insertError; }
    return listInsights();
  }
  const db = await getDb(); if (!db) return [];
  await db.delete(insights).where(eq(insights.status, "suggested"));
  if (generated.length > 0) await db.insert(insights).values(generated);
  return listInsights();
}
export async function listConversations() { if (useSupabase()) { const { data, error } = await getSupabaseServer().from("conversations").select("*").order("updated_at", { ascending: false }).limit(50); if (error) throw error; return (data ?? []).map(mapConversation); } const db = await getDb(); if (!db) return []; return db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(50); }
export async function getConversationByClientId(clientId: string) {
  if (useSupabase()) {
    const { data, error } = await getSupabaseServer().from("conversations").select("*").eq("client_id", clientId).maybeSingle();
    if (error) throw error;
    return data ? mapConversation(data) : null;
  }
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(conversations).where(eq(conversations.clientId, clientId)).limit(1);
  return rows[0] ?? null;
}
export async function pauseConversationByWaId(waId: string) { if (useSupabase()) { const { data, error } = await getSupabaseServer().from("conversations").update({ is_paused: true, updated_at: new Date().toISOString() }).eq("wa_id", waId).eq("is_paused", false).select("client_id"); if (error) throw error; if (data?.[0]) await recordEvent({ eventType: "owner_echo", severity: "info", title: "Owner takeover detected", detail: "You replied from the phone; WEBASI is paused for this chat.", clientId: data[0].client_id }); return true; } const db = await getDb(); if (!db) return false; await db.update(conversations).set({ isPaused: 1, updatedAt: new Date() }).where(eq(conversations.waId, waId)); await recordEvent({ eventType: "owner_echo", severity: "info", title: "Owner takeover detected", detail: "You replied from the phone; WEBASI is paused for this chat." }); return true; }
export async function recordOwnerMessageByWaId(waId: string, text: string) { if (useSupabase()) { if (!text.trim()) return false; const { data, error } = await getSupabaseServer().from("conversations").select("recent_messages").eq("wa_id", waId).maybeSingle(); if (error) throw error; if (!data) return false; const recentMessages = (data.recent_messages ?? []) as Array<{ role: "client" | "assistant" | "owner"; text: string }>; const normalized = text.trim(); const last = recentMessages.at(-1); if (last?.role === "owner" && last.text === normalized) return true; const { error: updateError } = await getSupabaseServer().from("conversations").update({ recent_messages: [...recentMessages, { role: "owner", text: normalized }].slice(-12), updated_at: new Date().toISOString() }).eq("wa_id", waId); if (updateError) throw updateError; return true; } const db = await getDb(); if (!db || !text.trim()) return false; const row = (await db.select().from(conversations).where(eq(conversations.waId, waId)).limit(1))[0]; if (!row) return false; let recentMessages: Array<{ role: "client" | "assistant" | "owner"; text: string }> = []; try { recentMessages = JSON.parse(row.recentMessages) as typeof recentMessages; } catch { recentMessages = []; } const normalized = text.trim(); const last = recentMessages.at(-1); if (last?.role === "owner" && last.text === normalized) return true; recentMessages.push({ role: "owner", text: normalized }); recentMessages = recentMessages.slice(-12); await db.update(conversations).set({ recentMessages: JSON.stringify(recentMessages), updatedAt: new Date() }).where(eq(conversations.waId, waId)); return true; }
export async function captureLearnedAnswer(waId: string, ownerText: string) {
  if (!useSupabase() || ownerText.trim().length < 3) return false;
  const supabase = getSupabaseServer();
  const { data, error } = await supabase.from("conversations").select("client_id, handed_over, recent_messages").eq("wa_id", waId).maybeSingle();
  if (error) throw error;
  const messages = (data?.recent_messages ?? []) as Array<{ role: string; text: string }>;
  const last = messages.at(-1);
  // Only the first owner reply right after a client question in a handed-over chat is a new answer.
  if (!data?.handed_over || last?.role !== "client") return false;
  const question = last.text.trim();
  const { error: insertError } = await supabase.from("insights").insert({ title: question.slice(0, 200), detail: `Q: ${question}\nA: ${ownerText.trim()}`, category: "Learned answer", status: "suggested", client_id: data.client_id });
  if (insertError) throw insertError;
  return true;
}
export async function resumeConversation(clientId: string) { if (useSupabase()) { const { error } = await getSupabaseServer().from("conversations").update({ is_paused: false, handed_over: false, updated_at: new Date().toISOString() }).eq("client_id", clientId); if (error) throw error; return true; } const db = await getDb(); if (!db) return false; await db.update(conversations).set({ isPaused: 0, updatedAt: new Date() }).where(eq(conversations.clientId, clientId)); return true; }

export async function pauseConversation(clientId: string) { if (useSupabase()) { const { error } = await getSupabaseServer().from("conversations").update({ is_paused: true, updated_at: new Date().toISOString() }).eq("client_id", clientId); if (error) throw error; await recordEvent({ eventType: "dashboard_takeover", severity: "info", title: "Conversation taken over", detail: `Owner paused WEBASI from the dashboard for client ${clientId}.`, clientId }); return true; } const db = await getDb(); if (!db) return false; await db.update(conversations).set({ isPaused: 1, updatedAt: new Date() }).where(eq(conversations.clientId, clientId)); await recordEvent({ eventType: "dashboard_takeover", severity: "info", title: "Conversation taken over", detail: `Owner paused WEBASI from the dashboard for client ${clientId}.`, clientId }); return true; }

export const trainingChecklist = ["packageDescription", "includedExcluded", "pricing", "depositRule", "timeline", "revisionPolicy", "requiredClientInputs", "paymentTerms", "faqs", "tone", "forbiddenTopics", "escalationRules", "samples", "contactDetails"] as const;
export async function getTraining(projectKey: string) {
  if (useSupabase()) {
    const { data, error } = await getSupabaseServer().from("training_sessions").select("checklist, answers, summary, approved").eq("project_key", projectKey).maybeSingle();
    if (error) throw error;
    return data
      ? { projectKey, checklist: data.checklist as string[], answers: data.answers as Record<string, string>, summary: data.summary, approved: Boolean(data.approved) }
      : { projectKey, checklist: trainingChecklist, answers: {}, summary: "", approved: false };
  }
  const db = await getDb(); if (!db) return { projectKey, checklist: trainingChecklist, answers: {}, summary: "", approved: false };
  const rows = await db.select().from(trainingSessions).where(eq(trainingSessions.projectKey, projectKey)).limit(1);
  const row = rows[0];
  return row ? { projectKey, checklist: JSON.parse(row.checklist), answers: JSON.parse(row.answers), summary: row.summary, approved: row.approved === 1 } : { projectKey, checklist: trainingChecklist, answers: {}, summary: "", approved: false };
}

export async function saveTraining(projectKey: string, answers: Record<string, string>, summary: string) {
  invalidateProjectCaches();
  const readiness = trainingReadiness(trainingChecklist, answers, summary);
  if (useSupabase()) {
    const supabase = getSupabaseServer();
    const { error: sessionError } = await supabase.from("training_sessions").upsert({ project_key: projectKey, checklist: trainingChecklist, answers, summary, updated_at: new Date().toISOString() }, { onConflict: "project_key" });
    if (sessionError) throw sessionError;
    const { data: current } = await supabase.from("projects").select("status").eq("project_key", projectKey).maybeSingle();
    const keepStatus = current?.status === "active" || current?.status === "approved";
    const { error: projectError } = await supabase.from("projects").update({ ...(keepStatus ? {} : { status: readiness.complete ? "ready" : "training" }), readiness: readiness.readiness, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
    if (projectError) throw projectError;
    return;
  }
  const db = await getDb(); if (!db) return;
  const rows = await db.select().from(trainingSessions).where(eq(trainingSessions.projectKey, projectKey)).limit(1);
  if (!rows[0]) await db.insert(trainingSessions).values({ projectKey, checklist: JSON.stringify(trainingChecklist), answers: JSON.stringify(answers), summary, approved: 0 });
  else await db.update(trainingSessions).set({ answers: JSON.stringify(answers), summary, approved: 0 }).where(eq(trainingSessions.projectKey, projectKey));
  await db.update(projects).set({ status: readiness.complete ? "ready" : "training", readiness: readiness.readiness, updatedAt: new Date() }).where(eq(projects.projectKey, projectKey));
}
// Compiling costs two database reads, and every incoming message needs the result. Returning the same object
// until something changes also lets the conversation engine keep its per-project work (facts text, allowed numbers).
export async function compileProjectSnapshot(projectKey: string) {
  const cached = compiledSnapshotCache.get(projectKey);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const value = await buildProjectSnapshot(projectKey);
  compiledSnapshotCache.set(projectKey, { value, expiresAt: Date.now() + 30_000 });
  return value;
}
async function buildProjectSnapshot(projectKey: string): Promise<ApprovedProjectSnapshot | null> {
  const selected = await getProjectByKey(projectKey);
  if (!selected) return null;
  let parsedSnapshot: any = null;
  try { parsedSnapshot = typeof selected.snapshot === "string" ? JSON.parse(selected.snapshot) : selected.snapshot; } catch {}
  
  const training = await getTraining(projectKey);
  const answers = training.answers;
  const answer = (key: string) => answers[key]?.trim() ?? "";
  
  const depositMatch = answer("depositRule").match(/(\d{1,3})\s*%/);
  
  const priceLkr = parsedSnapshot?.priceLkr || parsePriceLkr(answer("pricing")) || parsePriceLkr(answer("packageDescription"));
  const depositPercent = parsedSnapshot?.depositPercent ?? (depositMatch ? Number(depositMatch[1]) : 0);
  const timeline = parsedSnapshot?.timelineBusinessDays ?? (answer("timeline") || "Not specified");
  
  const listAnswer = (key: string) => answer(key).split(/[\n,;]+/).map((item: string) => item.trim()).filter(Boolean);
  
  const packageDescription = parsedSnapshot?.packageDescription ?? (answer("packageDescription") || `${selected.name} project package.`);
  const included = parsedSnapshot?.included ?? listAnswer("includedExcluded").filter((item: string) => !/^excluded?:/i.test(item));
  const excluded = parsedSnapshot?.excluded ?? [];
  const requiredClientInputs = parsedSnapshot?.requiredClientInputs ?? listAnswer("requiredClientInputs");
  
  const settings = await getSettings();
  
  return {
    id: selected.projectKey,
    version: selected.version,
    businessName: parsedSnapshot?.businessName ?? settings.businessName,
    packageName: parsedSnapshot?.packageName ?? selected.name,
    packageDescription,
    included,
    excluded,
    priceLkr,
    depositPercent,
    timelineBusinessDays: timeline,
    revisionPolicy: parsedSnapshot?.revisionPolicy ?? (answer("revisionPolicy") || "Revision policy is defined in the approved project training."),
    requiredClientInputs,
    paymentTerms: parsedSnapshot?.paymentTerms ?? (answer("paymentTerms") || "Payment terms are defined in the approved project training."),
    samples: parsedSnapshot?.samples ?? (answer("samples") || ""),
    contactDetails: parsedSnapshot?.contactDetails ?? (answer("contactDetails") || ""),
    tone: parsedSnapshot?.tone ?? (answer("tone") || "clear, concise, and helpful"),
    forbiddenTopics: parsedSnapshot?.forbiddenTopics ?? listAnswer("forbiddenTopics"),
    // Read live from training so approved learned answers reach the bot without re-approving the project.
    faqs: answer("faqs") || parsedSnapshot?.faqs || "",
    escalationRules: answer("escalationRules") || parsedSnapshot?.escalationRules || "",
    ...(Array.isArray(parsedSnapshot?.generatedFaqs?.entries) ? { generatedFaqs: parsedSnapshot.generatedFaqs as GeneratedFaqs } : {}),
  };
}

export async function approveTraining(projectKey: string) {
  const session = await getTraining(projectKey);
  if (!trainingReadiness(session.checklist, session.answers, session.summary).complete) return false;
  invalidateProjectCaches();
  const snapshotObj = await compileProjectSnapshot(projectKey);
  const snapshotStr = snapshotObj ? JSON.stringify(snapshotObj) : "{}";

  if (useSupabase()) {
    const supabase = getSupabaseServer();
    const { error: sessionError } = await supabase.from("training_sessions").update({ approved: true, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
    if (sessionError) throw sessionError;
    const { error: projectError } = await supabase.from("projects").update({ status: "approved", readiness: 100, snapshot: snapshotObj ?? {}, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
    if (projectError) throw projectError;
    // Write the client FAQs from the knowledge that was just approved.
    await refreshInstantAnswers(projectKey, { regenerate: true }).catch((err) => console.warn("[Training] Client FAQ generation failed (non-fatal)", err));
    return true;
  }
  const db = await getDb(); if (!db) return false;
  await db.update(trainingSessions).set({ approved: 1 }).where(eq(trainingSessions.projectKey, projectKey));
  await db.update(projects).set({ status: "approved", readiness: 100, snapshot: snapshotStr, updatedAt: new Date() }).where(eq(projects.projectKey, projectKey));
  // Write the client FAQs from the knowledge that was just approved.
  await refreshInstantAnswers(projectKey, { regenerate: true }).catch((err) => console.warn("[Training] Client FAQ generation failed (non-fatal)", err));
  return true;
}

// The stored project snapshot holds the generated client FAQs next to the approved facts.
async function writeGeneratedFaqs(projectKey: string, generatedFaqs: GeneratedFaqs) {
  // `faqCache` is where an earlier version kept the parsed owner FAQs; those are now read from the training itself.
  if (useSupabase()) {
    const supabase = getSupabaseServer();
    const { data: current, error: readError } = await supabase.from("projects").select("snapshot").eq("project_key", projectKey).maybeSingle();
    if (readError) throw readError;
    const { faqCache: _legacy, ...existing } = (current?.snapshot && typeof current.snapshot === "object" ? current.snapshot : {}) as Record<string, unknown>;
    const { error } = await supabase.from("projects").update({ snapshot: { ...existing, generatedFaqs }, updated_at: new Date().toISOString() }).eq("project_key", projectKey);
    if (error) throw error;
  } else {
    const db = await getDb();
    if (!db) return;
    const existing = (await db.select().from(projects).where(eq(projects.projectKey, projectKey)).limit(1))[0];
    if (!existing) return;
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(existing.snapshot) ?? {}; } catch {}
    const { faqCache: _legacy, ...rest } = parsed;
    await db.update(projects).set({ snapshot: JSON.stringify({ ...rest, generatedFaqs }), updatedAt: new Date() }).where(eq(projects.projectKey, projectKey));
  }
  invalidateProjectCaches(); // the stored project row just changed
}

/**
 * Keeps the generated client FAQs (the answers WEBASI gives without calling the AI) in step with the project knowledge.
 * `regenerate` asks the AI to write them again: once when training is approved, or when the owner asks for it.
 * Without it the stored answers are kept and marked as current, which is right after an answer was only added.
 */
export async function refreshInstantAnswers(projectKey: string, { regenerate = false }: { regenerate?: boolean } = {}): Promise<FaqEntry[] | null> {
  invalidateProjectCaches();
  const project = await compileProjectSnapshot(projectKey);
  if (!project) return null;
  if (!regenerate && !project.generatedFaqs) return [];

  let entries = project.generatedFaqs?.entries ?? [];
  let generatedAt = project.generatedFaqs?.generatedAt ?? new Date().toISOString();
  if (regenerate) {
    entries = await generateClientFaqs(project, { provider: (await getSettings()).aiProvider });
    generatedAt = new Date().toISOString();
    await incrementUsage("geminiRequests").catch((err) => console.warn("[Training] usage counter failed", err));
  }
  await writeGeneratedFaqs(projectKey, { factsHash: knowledgeFingerprint(project), generatedAt, entries });

  if (regenerate) await recordEvent({ eventType: "faq_cache_built", severity: "info", title: "Client FAQs generated", detail: `${entries.length} likely client question${entries.length === 1 ? "" : "s"} prepared for ${project.packageName}. WEBASI answers these without an AI request.` });
  return entries;
}

// What the Training page shows: the owner's FAQs, the generated ones, and whether those are still in use.
export async function getInstantAnswers(projectKey: string) {
  const project = await compileProjectSnapshot(projectKey);
  const generated = project?.generatedFaqs ?? null;
  return {
    owner: project ? buildFaqCache(project.faqs ?? "") : [],
    generated: generated?.entries ?? [],
    generatedAt: generated?.generatedAt ?? null,
    outOfDate: Boolean(project && generated && generated.factsHash !== knowledgeFingerprint(project)),
    englishForSinglish: ENV.faqEnglishForSinglish,
  };
}

// Removes one generated question that the owner does not want answered this way; the AI answers it again from then on.
export async function removeInstantAnswer(projectKey: string, question: string) {
  invalidateProjectCaches();
  const project = await compileProjectSnapshot(projectKey);
  if (!project?.generatedFaqs) return false;
  const entries = project.generatedFaqs.entries.filter((entry) => entry.question !== question);
  if (entries.length === project.generatedFaqs.entries.length) return false;
  await writeGeneratedFaqs(projectKey, { ...project.generatedFaqs, entries });
  return true;
}

export async function setAiProvider(provider: "gemini" | "groq") {
  settingsCache.invalidate();
  if (useSupabase()) { const { error } = await getSupabaseServer().from("settings").update({ ai_provider: provider }).eq("singleton_key", "owner"); if (error) throw error; }
  else ENV.aiProvider = provider; // ponytail: MySQL schema has no column for this; resets on restart there
  await recordEvent({ eventType: "ai_provider_changed", severity: "info", title: "AI provider changed", detail: `Replies now use ${provider}.` });
  return { success: true, provider };
}

// text = null marks the silence as handled without adding to the transcript (shadow-mode drafts).
export async function recordFollowUp(clientId: string, text: string | null, sentAt = new Date()) {
  if (!useSupabase()) return false; // ponytail: follow-ups need the Supabase columns from migration 004
  const supabase = getSupabaseServer();
  const set: Record<string, unknown> = { followup_sent_at: sentAt.toISOString() };
  if (text) {
    const { data, error } = await supabase.from("conversations").select("recent_messages").eq("client_id", clientId).maybeSingle();
    if (error) throw error;
    set.recent_messages = [...((data?.recent_messages ?? []) as unknown[]), { role: "assistant", text, at: sentAt.toISOString() }].slice(-20);
    set.updated_at = sentAt.toISOString();
  }
  const { error: updateError } = await supabase.from("conversations").update(set).eq("client_id", clientId);
  if (updateError) throw updateError;
  return true;
}

export type WeeklyStats = {
  activeChats: number; newChats: number; hotLeads: number; frustrated: number; handovers: number;
  messagesIn: number; messagesOut: number; ordersCreated: number; slipsWaiting: number; confirmedOrders: number; confirmedDeposits: number;
  followUpsSent: number; knowledgeAdded: number; learnedAnswersPending: number; topObjections: Array<[string, number]>;
  meetingsRequested: number;
};

export async function getWeeklyStats(now = new Date()): Promise<WeeklyStats | null> {
  if (!useSupabase()) return null;
  const supabase = getSupabaseServer();
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const count = async (table: string, apply: (query: any) => any) => { const { count: total, error } = await apply(supabase.from(table).select("*", { count: "exact", head: true })); if (error) throw error; return total ?? 0; };
  const [chats, orderRows, messagesIn, messagesOut, handovers, followUpsSent, knowledgeAdded, learnedAnswersPending, meetingsRequested] = await Promise.all([
    supabase.from("conversations").select("created_at, intent_score, sentiment, objection").gte("updated_at", since),
    supabase.from("orders").select("state, deposit_amount, created_at, updated_at").gte("updated_at", since),
    count("messages", (q) => q.eq("direction", "inbound").gte("created_at", since)),
    count("messages", (q) => q.eq("direction", "outbound").gte("created_at", since)),
    count("event_log", (q) => q.in("event_type", ["escalation", "frustrated_client", "voice_note"]).gte("created_at", since)),
    count("event_log", (q) => q.eq("event_type", "follow_up_sent").gte("created_at", since)),
    count("event_log", (q) => q.eq("event_type", "knowledge_added").gte("created_at", since)),
    count("insights", (q) => q.eq("category", "Learned answer").eq("status", "suggested")),
    count("event_log", (q) => q.eq("event_type", "meeting_requested").gte("created_at", since)),
  ]);
  if (chats.error) throw chats.error;
  if (orderRows.error) throw orderRows.error;
  const rows = chats.data ?? [];
  const orders = orderRows.data ?? [];
  const objections = new Map<string, number>();
  for (const row of rows) if (row.objection && row.objection !== "none") objections.set(row.objection, (objections.get(row.objection) ?? 0) + 1);
  const confirmed = orders.filter((order) => order.state === "confirmed_by_owner");
  return {
    activeChats: rows.length,
    newChats: rows.filter((row) => row.created_at >= since).length,
    hotLeads: rows.filter((row) => row.intent_score === "high").length,
    frustrated: rows.filter((row) => row.sentiment === "frustrated").length,
    handovers, messagesIn, messagesOut,
    ordersCreated: orders.filter((order) => order.created_at >= since).length,
    slipsWaiting: orders.filter((order) => order.state === "slip_received").length,
    confirmedOrders: confirmed.length,
    confirmedDeposits: confirmed.reduce((sum, order) => sum + (order.deposit_amount ?? 0), 0),
    followUpsSent, knowledgeAdded, learnedAnswersPending, meetingsRequested,
    topObjections: Array.from(objections.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

export async function lastEventAt(eventType: string): Promise<Date | null> {
  if (!useSupabase()) return null;
  const { data, error } = await getSupabaseServer().from("event_log").select("created_at").eq("event_type", eventType).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? new Date(data.created_at) : null;
}

// ─── Knowledge Gap Tracker ───────────────────────────────────────────────────
// When the engine cannot answer a client question from the knowledge base it
// calls trackKnowledgeGap(). The question is stored so the owner can supply
// the missing answer from the Training tab. Once answered the answer is
// appended to the active project's FAQs so future clients get an instant reply.

export type KnowledgeGap = {
  id: string | number;
  question: string;
  reason: string;
  clientId: string | null;
  status: "pending" | "answered";
  answer: string | null;
  createdAt: string;
};

export async function trackKnowledgeGap(question: string, reason: string, clientId?: string): Promise<boolean> {
  const q = question.trim().slice(0, 500);
  if (!q) return false;
  if (useSupabase()) {
    const supabase = getSupabaseServer();
    // Deduplicate: don't store the same question twice within 24 h.
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { data: existing } = await supabase.from("knowledge_gaps").select("id").eq("question", q).eq("status", "pending").gte("created_at", since).maybeSingle();
    if (existing) return false;
    const { error } = await supabase.from("knowledge_gaps").insert({ question: q, reason, client_id: clientId ?? null, status: "pending", answer: null });
    if (error) throw error;
    return true;
  }
  // MySQL/SQLite fallback: record as an insight so it still surfaces somewhere.
  const db = await getDb(); if (!db) return false;
  await db.insert(insights).values({ title: q.slice(0, 200), detail: `Knowledge gap: ${reason}\nQ: ${q}`, category: "Knowledge Gap", status: "suggested" });
  return true;
}

export async function listKnowledgeGaps(): Promise<KnowledgeGap[]> {
  if (!useSupabase()) return [];
  const { data, error } = await getSupabaseServer().from("knowledge_gaps").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    question: row.question,
    reason: row.reason,
    clientId: row.client_id ?? null,
    status: row.status,
    answer: row.answer ?? null,
    createdAt: row.created_at,
  }));
}

export async function answerKnowledgeGap(id: string | number, answer: string): Promise<boolean> {
  const text = answer.trim();
  if (!text) return false;
  if (!useSupabase()) return false;
  const supabase = getSupabaseServer();
  const { data: gap, error: fetchError } = await supabase.from("knowledge_gaps").select("question, status").eq("id", id).maybeSingle();
  if (fetchError) throw fetchError;
  if (!gap || gap.status === "answered") return false;
  const { error } = await supabase.from("knowledge_gaps").update({ status: "answered", answer: text }).eq("id", id);
  if (error) throw error;
  // Append as FAQ so the bot can answer this question immediately next time (this also rebuilds the FAQ cache).
  await appendProjectFaq(`Q: ${gap.question}\nA: ${text}`);
  await recordEvent({ eventType: "knowledge_gap_answered", severity: "info", title: "Knowledge gap answered", detail: `Q: ${gap.question.slice(0, 200)}\nA: ${text.slice(0, 200)}` });
  return true;
}

