import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { conversations, usageCounters, whatsappMessages } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getSupabaseServer } from "./_core/supabase";
import type { OrderState } from "../shared/webasi";

let _db: ReturnType<typeof drizzle> | null = null;
let usageRpcMissing = false;
const useSupabase = () => Boolean(ENV.supabaseUrl && ENV.supabaseServiceRoleKey);

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try { _db = drizzle(process.env.DATABASE_URL); } catch (error) { console.warn("[Database] Failed to connect:", error); _db = null; }
  }
  return _db;
}

export async function claimWhatsAppMessage(input: { messageId: string; waId: string; messageType: string; clientId?: string; body?: string | null }): Promise<boolean> {
  if (useSupabase()) {
    const { error } = await getSupabaseServer().from("messages").insert({ message_id: input.messageId, client_id: input.clientId ?? null, wa_id: input.waId, message_type: input.messageType, body: input.body ?? null, direction: "inbound", role: "client" });
    if (!error) return true;
    if (error.code === "23505") return false;
    throw error;
  }
  const db = await getDb();
  if (!db) return true;
  try { await db.insert(whatsappMessages).values({ messageId: input.messageId, waId: input.waId, messageType: input.messageType }); return true; }
  catch (error: any) { if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) return false; throw error; }
}

export async function logMessage(input: { messageId: string; clientId: string; waId: string; role: "assistant" | "owner"; body: string; topic?: string | null; intentScore?: IntentScore | null; handedOver?: boolean }): Promise<void> {
  if (!useSupabase()) return; // ponytail: the MySQL schema has no message log table; Supabase is the production store.
  const { error } = await getSupabaseServer().from("messages").upsert({ message_id: input.messageId, client_id: input.clientId, wa_id: input.waId, direction: "outbound", role: input.role, message_type: "text", body: input.body, topic: input.topic ?? null, intent_score: input.intentScore ?? null, handed_over: input.handedOver ?? false }, { onConflict: "message_id" });
  if (error) throw error;
}

export type IntentScore = "high" | "medium" | "low";
export type Sentiment = "positive" | "neutral" | "confused" | "frustrated";
export type Objection = "none" | "price" | "timeline" | "trust" | "scope" | "competitor" | "thinking_it_over";
export type TranscriptMessage = { role: "client" | "assistant" | "owner"; text: string; at?: string };
export const TRANSCRIPT_LIMIT = 20;

export type ConversationSnapshot = {
  clientId: string;
  waId: string;
  profileName?: string;
  state: OrderState;
  isPaused: boolean;
  missingFields: string[];
  extractedFields: Record<string, string | null>;
  recentMessages: TranscriptMessage[];
  lastClientMessageAt?: Date;
  intentScore?: IntentScore | null;
  handedOver?: boolean;
  sentiment?: Sentiment | null;
  objection?: Objection | null;
  language?: string | null;
  clientNotes?: string;
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
    return { clientId: data.client_id, waId: data.wa_id, profileName: data.profile_name ?? undefined, state: data.state as OrderState, isPaused: Boolean(data.is_paused), missingFields: data.missing_fields ?? [], extractedFields: data.extracted_fields ?? {}, recentMessages: data.recent_messages ?? [], lastClientMessageAt: data.last_client_message_at ? new Date(data.last_client_message_at) : undefined, intentScore: data.intent_score ?? null, handedOver: Boolean(data.handed_over), sentiment: data.sentiment ?? null, objection: data.objection ?? null, language: data.language ?? null, clientNotes: data.client_notes ?? "" };
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
    const { error } = await getSupabaseServer().from("conversations").update({ wa_id: snapshot.waId, profile_name: snapshot.profileName ?? null, state: snapshot.state, is_paused: snapshot.isPaused, missing_fields: snapshot.missingFields, extracted_fields: snapshot.extractedFields, recent_messages: snapshot.recentMessages, last_client_message_at: snapshot.lastClientMessageAt?.toISOString() ?? null, intent_score: snapshot.intentScore ?? null, handed_over: snapshot.handedOver ?? false, sentiment: snapshot.sentiment ?? null, objection: snapshot.objection ?? null, language: snapshot.language ?? null, client_notes: snapshot.clientNotes ?? "", updated_at: new Date().toISOString() }).eq("client_id", snapshot.clientId);
    if (error) throw error;
    return;
  }
  const db = await getDb();
  if (!db) return;
  await db.update(conversations).set({ waId: snapshot.waId, profileName: snapshot.profileName ?? null, state: snapshot.state, isPaused: snapshot.isPaused ? 1 : 0, missingFields: JSON.stringify(snapshot.missingFields), extractedFields: JSON.stringify(snapshot.extractedFields), recentMessages: JSON.stringify(snapshot.recentMessages), lastClientMessageAt: snapshot.lastClientMessageAt ?? null }).where(eq(conversations.clientId, snapshot.clientId));
}

function currentPeriodKey(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function currentDayKey(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`; }

// WhatsApp is capped per month, Gemini per day, so each counter lives under its own period key.
const periodFor = (field: "outboundWhatsApp" | "geminiRequests", date: Date) => field === "outboundWhatsApp" ? currentPeriodKey(date) : currentDayKey(date);

export async function getUsageCounts(date = new Date()): Promise<{ outboundWhatsApp: number; geminiRequests: number }> {
  if (useSupabase()) {
    const supabase = getSupabaseServer();
    const [month, day] = await Promise.all([
      supabase.from("usage_counters").select("outbound_whatsapp").eq("period_key", periodFor("outboundWhatsApp", date)).maybeSingle(),
      supabase.from("usage_counters").select("gemini_requests").eq("period_key", periodFor("geminiRequests", date)).maybeSingle(),
    ]);
    if (month.error) throw month.error;
    if (day.error) throw day.error;
    return { outboundWhatsApp: month.data?.outbound_whatsapp ?? 0, geminiRequests: day.data?.gemini_requests ?? 0 };
  }
  const db = await getDb();
  if (!db) return { outboundWhatsApp: 0, geminiRequests: 0 };
  const [month] = await db.select().from(usageCounters).where(eq(usageCounters.periodKey, periodFor("outboundWhatsApp", date))).limit(1);
  const [day] = await db.select().from(usageCounters).where(eq(usageCounters.periodKey, periodFor("geminiRequests", date))).limit(1);
  return { outboundWhatsApp: month?.outboundWhatsApp ?? 0, geminiRequests: day?.geminiRequests ?? 0 };
}

export async function incrementUsage(field: "outboundWhatsApp" | "geminiRequests", date = new Date()): Promise<void> {
  const period = periodFor(field, date);
  if (useSupabase()) {
    const column = field === "outboundWhatsApp" ? "outbound_whatsapp" : "gemini_requests";
    const supabase = getSupabaseServer();
    // Try atomic increment via Postgres RPC; fall back to read-modify-write.
    if (!usageRpcMissing) {
      const { error: rpcError } = await supabase.rpc("increment_usage_counter", { p_period: period, p_column: column });
      if (!rpcError) return;
      // Function not created yet (migration 20261002 not applied): stop paying for a failed call on every increment.
      if (rpcError.code === "PGRST202") usageRpcMissing = true;
    }
    // Fallback: read-modify-write (acceptable for single-server deployments).
    const { data, error } = await supabase.from("usage_counters").select("outbound_whatsapp, gemini_requests").eq("period_key", period).maybeSingle();
    if (error) throw error;
    const next = (data?.[column] ?? 0) + 1;
    const { error: upsertError } = await supabase.from("usage_counters").upsert({ period_key: period, [column]: next, updated_at: new Date().toISOString() }, { onConflict: "period_key" });
    if (upsertError) throw upsertError;
    return;
  }
  const db = await getDb();
  if (!db) return;
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
