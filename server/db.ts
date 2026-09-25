import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, conversations, usageCounters, whatsappMessages, users, projects, settings, orders, eventLogs, insights } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getSupabaseServer } from "./_core/supabase";
import type { OrderState } from "../shared/webasi";

let _db: ReturnType<typeof drizzle> | null = null;
const useSupabase = () => Boolean(ENV.supabaseUrl && ENV.supabaseServiceRoleKey);

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try { _db = drizzle(process.env.DATABASE_URL); } catch (error) { console.warn("[Database] Failed to connect:", error); _db = null; }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  for (const field of textFields) {
    if (user[field] !== undefined) { values[field] = user[field] ?? null; updateSet[field] = user[field] ?? null; }
  }
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function claimWhatsAppMessage(input: { messageId: string; waId: string; messageType: string }): Promise<boolean> {
  if (useSupabase()) {
    const { error } = await getSupabaseServer().from("messages").insert({ message_id: input.messageId, wa_id: input.waId, message_type: input.messageType, direction: "inbound", role: "client" });
    if (!error) return true;
    if (error.code === "23505") return false;
    throw error;
  }
  const db = await getDb();
  if (!db) return true;
  try { await db.insert(whatsappMessages).values(input); return true; }
  catch (error: any) { if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) return false; throw error; }
}

export type ConversationSnapshot = {
  clientId: string;
  waId: string;
  profileName?: string;
  state: OrderState;
  isPaused: boolean;
  missingFields: string[];
  extractedFields: Record<string, string | null>;
  recentMessages: Array<{ role: "client" | "assistant" | "owner"; text: string }>;
  lastClientMessageAt?: Date;
};

const emptyConversation = (clientId: string, waId: string, profileName?: string): ConversationSnapshot => ({
  clientId, waId, profileName, state: "new", isPaused: false,
  missingFields: ["clientName", "contactDetails", "businessName", "businessDescription", "chosenPackage", "budget", "deadline", "existingAssets"],
  extractedFields: {}, recentMessages: [],
});

export async function getConversation(clientId: string, waId: string, profileName?: string): Promise<ConversationSnapshot> {
  if (useSupabase()) {
    const { data, error } = await getSupabaseServer().from("conversations").select("*").eq("client_id", clientId).maybeSingle();
    if (error) throw error;
    if (!data) {
      const initial = emptyConversation(clientId, waId, profileName);
      const { error: insertError } = await getSupabaseServer().from("conversations").insert({ client_id: clientId, wa_id: waId, profile_name: profileName ?? null, state: initial.state, is_paused: false, missing_fields: initial.missingFields, extracted_fields: initial.extractedFields, recent_messages: initial.recentMessages });
      if (insertError) throw insertError;
      return initial;
    }
    return { clientId: data.client_id, waId: data.wa_id, profileName: data.profile_name ?? undefined, state: data.state as OrderState, isPaused: Boolean(data.is_paused), missingFields: data.missing_fields ?? [], extractedFields: data.extracted_fields ?? {}, recentMessages: data.recent_messages ?? [], lastClientMessageAt: data.last_client_message_at ? new Date(data.last_client_message_at) : undefined };
  }
  const db = await getDb();
  if (!db) return emptyConversation(clientId, waId, profileName);
  const result = await db.select().from(conversations).where(eq(conversations.clientId, clientId)).limit(1);
  const row = result[0];
  if (!row) {
    const initial = emptyConversation(clientId, waId, profileName);
    await db.insert(conversations).values({ clientId, waId, profileName: profileName ?? null, state: initial.state, isPaused: 0, missingFields: JSON.stringify(initial.missingFields), extractedFields: JSON.stringify(initial.extractedFields), recentMessages: JSON.stringify(initial.recentMessages) });
    return initial;
  }
  return {
    clientId: row.clientId, waId: row.waId, profileName: row.profileName ?? undefined, state: row.state as OrderState,
    isPaused: row.isPaused === 1, missingFields: JSON.parse(row.missingFields), extractedFields: JSON.parse(row.extractedFields), recentMessages: JSON.parse(row.recentMessages),
    lastClientMessageAt: row.lastClientMessageAt ?? undefined,
  };
}

export async function saveConversation(snapshot: ConversationSnapshot): Promise<void> {
  if (useSupabase()) {
    const { error } = await getSupabaseServer().from("conversations").update({ wa_id: snapshot.waId, profile_name: snapshot.profileName ?? null, state: snapshot.state, is_paused: snapshot.isPaused, missing_fields: snapshot.missingFields, extracted_fields: snapshot.extractedFields, recent_messages: snapshot.recentMessages, last_client_message_at: snapshot.lastClientMessageAt?.toISOString() ?? null, updated_at: new Date().toISOString() }).eq("client_id", snapshot.clientId);
    if (error) throw error;
    return;
  }
  const db = await getDb();
  if (!db) return;
  await db.update(conversations).set({ waId: snapshot.waId, profileName: snapshot.profileName ?? null, state: snapshot.state, isPaused: snapshot.isPaused ? 1 : 0, missingFields: JSON.stringify(snapshot.missingFields), extractedFields: JSON.stringify(snapshot.extractedFields), recentMessages: JSON.stringify(snapshot.recentMessages), lastClientMessageAt: snapshot.lastClientMessageAt ?? null }).where(eq(conversations.clientId, snapshot.clientId));
}

function currentPeriodKey(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function currentDayKey(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`; }

export async function getUsageCounts(date = new Date()): Promise<{ outboundWhatsApp: number; geminiRequests: number }> {
  if (useSupabase()) {
    const period = currentPeriodKey(date);
    const { data, error } = await getSupabaseServer().from("usage_counters").select("outbound_whatsapp, gemini_requests").eq("period_key", period).maybeSingle();
    if (error) throw error;
    return { outboundWhatsApp: data?.outbound_whatsapp ?? 0, geminiRequests: data?.gemini_requests ?? 0 };
  }
  const db = await getDb();
  if (!db) return { outboundWhatsApp: 0, geminiRequests: 0 };
  const period = currentPeriodKey(date);
  const result = await db.select().from(usageCounters).where(eq(usageCounters.periodKey, period)).limit(1);
  const row = result[0];
  return { outboundWhatsApp: row?.outboundWhatsApp ?? 0, geminiRequests: row?.geminiRequests ?? 0 };
}

export async function incrementUsage(field: "outboundWhatsApp" | "geminiRequests", date = new Date()): Promise<void> {
  if (useSupabase()) {
    const period = currentPeriodKey(date);
    const column = field === "outboundWhatsApp" ? "outbound_whatsapp" : "gemini_requests";
    const { data, error } = await getSupabaseServer().from("usage_counters").select("outbound_whatsapp, gemini_requests").eq("period_key", period).maybeSingle();
    if (error) throw error;
    const next = (data?.[column] ?? 0) + 1;
    const { error: upsertError } = await getSupabaseServer().from("usage_counters").upsert({ period_key: period, [column]: next, updated_at: new Date().toISOString() }, { onConflict: "period_key" });
    if (upsertError) throw upsertError;
    return;
  }
  const db = await getDb();
  if (!db) return;
  const period = currentPeriodKey(date);
  const result = await db.select().from(usageCounters).where(eq(usageCounters.periodKey, period)).limit(1);
  const row = result[0];
  if (!row) {
    await db.insert(usageCounters).values({ periodKey: period, outboundWhatsApp: field === "outboundWhatsApp" ? 1 : 0, geminiRequests: field === "geminiRequests" ? 1 : 0 });
    return;
  }
  await db.update(usageCounters).set({ [field]: (field === "outboundWhatsApp" ? row.outboundWhatsApp : row.geminiRequests) + 1 }).where(eq(usageCounters.periodKey, period));
}

export function customerWindowOpen(lastClientMessageAt: Date | undefined, now = new Date()): boolean {
  if (!lastClientMessageAt) return false;
  return now.getTime() - lastClientMessageAt.getTime() <= 24 * 60 * 60 * 1000;
}

export { currentDayKey };
