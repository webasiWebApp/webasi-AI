import { ENV } from "../_core/env";
import { getSupabaseServer } from "../_core/supabase";
import { approvedRestaurantProject } from "../conversations/project";
import { formatAutomationAudit } from "../../shared/webasi";
import { hasDatabase, invalidateProjectCaches, settingsCache } from "./core";
import { recordEvent } from "./events";

export type Settings = Awaited<ReturnType<typeof loadSettings>>;

let defaultsEnsured = false;

export async function ensureDefaults() {
  if (defaultsEnsured || !hasDatabase()) return;
  const supabase = getSupabaseServer();
  const { data: existingSettings, error: settingsError } = await supabase.from("settings").select("id").eq("singleton_key", "owner").maybeSingle();
  if (settingsError) throw settingsError;
  if (!existingSettings) {
    // Automation starts off, as in the schema: the owner switches it on once their own project is ready.
    const { error } = await supabase.from("settings").insert({ singleton_key: "owner", business_name: approvedRestaurantProject.businessName, bank_details: "Configure bank details in Settings before activating deposits.", webasi_enabled: false });
    if (error) throw error;
  }
  // The demo project is a starting point for an empty database only. Adding it next to the owner's active project
  // would break the one-active-project rule, and that error would then fail every incoming message.
  const { data: existingProjects, error: projectError } = await supabase.from("projects").select("id").limit(1);
  if (projectError) throw projectError;
  if (!existingProjects?.length) {
    const { error } = await supabase.from("projects").insert({ project_key: approvedRestaurantProject.id, name: approvedRestaurantProject.packageName, status: "active", readiness: 100, version: approvedRestaurantProject.version, snapshot: approvedRestaurantProject });
    if (error) throw error;
  }
  defaultsEnsured = true;
}

async function loadSettings() {
  if (!hasDatabase()) return { businessName: approvedRestaurantProject.businessName, bankDetails: "", notificationEmail: null, whatsappMonthlyCap: 900, geminiDailyCap: 500, webasiEnabled: false, shadowMode: false, aiProvider: ENV.aiProvider, followupsEnabled: false, weeklySummaryEnabled: false };
  await ensureDefaults();
  const { data, error } = await getSupabaseServer().from("settings").select("*").eq("singleton_key", "owner").single();
  if (error) throw error;
  return { ...data, businessName: data.business_name, bankDetails: data.bank_details, notificationEmail: data.notification_email, whatsappMonthlyCap: data.whatsapp_monthly_cap, geminiDailyCap: data.gemini_daily_cap, webasiEnabled: Boolean(data.webasi_enabled), shadowMode: Boolean(data.shadow_mode), aiProvider: (data.ai_provider ?? ENV.aiProvider) as string, followupsEnabled: data.followups_enabled !== false, weeklySummaryEnabled: data.weekly_summary_enabled !== false };
}

export async function getSettings() {
  const cached = settingsCache.get();
  if (cached) return cached;
  const result = await loadSettings();
  settingsCache.set(result);
  return result;
}

export async function updateSettings(input: { businessName?: string; bankDetails?: string; notificationEmail?: string | null; whatsappMonthlyCap?: number; geminiDailyCap?: number; webasiEnabled?: boolean; shadowMode?: boolean; followupsEnabled?: boolean; weeklySummaryEnabled?: boolean }) {
  settingsCache.invalidate();
  invalidateProjectCaches(); // the compiled facts fall back to the business name from settings
  await ensureDefaults();
  if (!hasDatabase()) return false;
  const supabase = getSupabaseServer();
  const { data: current, error: currentError } = await supabase.from("settings").select("*").eq("singleton_key", "owner").single();
  if (currentError) throw currentError;
  // Whether replies stay drafts depends on the shadow mode in force after this change, not only on what this request sets.
  const shadowAfter = input.shadowMode ?? Boolean(current?.shadow_mode);
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
  if (input.webasiEnabled !== undefined && Boolean(current?.webasi_enabled) !== input.webasiEnabled) await recordEvent({ eventType: "automation_state_changed", severity: input.webasiEnabled ? "warning" : "info", title: input.webasiEnabled ? "Automation enabled" : "Automation disabled", detail: formatAutomationAudit({ actor: "owner", project: activeProject?.name ?? "none", previous: Boolean(current?.webasi_enabled) ? "ON" : "OFF", next: input.webasiEnabled ? "ON" : "OFF", detail: input.webasiEnabled ? (shadowAfter ? "Replies remain drafts because shadow mode is enabled." : "Live replies are permitted while WhatsApp is connected.") : "Incoming messages remain logged without replies." }) });
  if (input.shadowMode !== undefined && Boolean(current?.shadow_mode) !== input.shadowMode) await recordEvent({ eventType: "shadow_mode_changed", severity: "info", title: input.shadowMode ? "Shadow mode enabled" : "Shadow mode disabled", detail: formatAutomationAudit({ actor: "owner", project: activeProject?.name ?? "none", previous: Boolean(current?.shadow_mode) ? "SHADOW" : "NORMAL", next: input.shadowMode ? "SHADOW" : "NORMAL", detail: input.shadowMode ? "WEBASI will draft replies for review without sending them to clients." : "WEBASI returned to its normal sending policy when enabled." }) });
  return true;
}

export async function setAiProvider(provider: "gemini" | "groq") {
  settingsCache.invalidate();
  if (hasDatabase()) {
    const { error } = await getSupabaseServer().from("settings").update({ ai_provider: provider }).eq("singleton_key", "owner");
    if (error) throw error;
  } else ENV.aiProvider = provider; // no database to remember it: holds until the process restarts
  await recordEvent({ eventType: "ai_provider_changed", severity: "info", title: "AI provider changed", detail: `Replies now use ${provider}.` });
  return { success: true, provider };
}
