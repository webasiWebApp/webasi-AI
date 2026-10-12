import { getSupabaseServer } from "./_core/supabase";
import { hasDatabase } from "./data/core";
import type { OrderState } from "../shared/webasi";

// Set once the database reports that a function is not there (its migration was not applied), so the fallback is used
// from then on instead of paying for a failed call each time.
let usageRpcMissing = false;
let appendRpcMissing = false;

export async function claimWhatsAppMessage(input: { messageId: string; waId: string; messageType: string; clientId?: string; body?: string | null }): Promise<boolean> {
  if (!hasDatabase()) return true;
  const { error } = await getSupabaseServer().from("messages").insert({ message_id: input.messageId, client_id: input.clientId ?? null, wa_id: input.waId, message_type: input.messageType, body: input.body ?? null, direction: "inbound", role: "client" });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}

export async function logMessage(input: { messageId: string; clientId: string; waId: string; role: "assistant" | "owner"; body: string; topic?: string | null; intentScore?: IntentScore | null; handedOver?: boolean }): Promise<void> {
  if (!hasDatabase()) return;
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
  if (!hasDatabase()) return emptyConversation(clientId, waId, profileName);
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

// Saves what a turn worked out about the chat. Two columns are deliberately left alone, because a turn can take many
// seconds (the AI, then the typing delay) and writing back what was read at its start would undo what happened since:
//  - the pause flag belongs to pauseConversation, pauseConversationByWaId and resumeConversation, so a takeover the
//    owner made from the dashboard in the meantime stays in force;
//  - the transcript only ever grows through appendTranscriptMessage, so an owner message that arrived in the meantime
//    is not overwritten.
export async function saveConversation(snapshot: ConversationSnapshot): Promise<void> {
  if (!hasDatabase()) return;
  const { error } = await getSupabaseServer().from("conversations").update({ wa_id: snapshot.waId, profile_name: snapshot.profileName ?? null, state: snapshot.state, missing_fields: snapshot.missingFields, extracted_fields: snapshot.extractedFields, last_client_message_at: snapshot.lastClientMessageAt?.toISOString() ?? null, intent_score: snapshot.intentScore ?? null, handed_over: snapshot.handedOver ?? false, sentiment: snapshot.sentiment ?? null, objection: snapshot.objection ?? null, language: snapshot.language ?? null, client_notes: snapshot.clientNotes ?? "", updated_at: new Date().toISOString() }).eq("client_id", snapshot.clientId);
  if (error) throw error;
}

// Adds one message to the end of a chat's transcript and keeps the last TRANSCRIPT_LIMIT. The database function does
// this in a single statement, so two writers at the same moment both land. Without the function (migration 20261011
// not applied) it reads and writes back, which is still a far shorter window than a whole turn.
export async function appendTranscriptMessage(clientId: string, message: TranscriptMessage): Promise<void> {
  if (!hasDatabase()) return;
  const supabase = getSupabaseServer();
  if (!appendRpcMissing) {
    const { error: rpcError } = await supabase.rpc("append_conversation_message", { p_client_id: clientId, p_message: message, p_limit: TRANSCRIPT_LIMIT });
    if (!rpcError) return;
    if (rpcError.code !== "PGRST202") throw rpcError;
    appendRpcMissing = true;
  }
  const { data, error } = await supabase.from("conversations").select("recent_messages").eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data) return;
  const { error: updateError } = await supabase.from("conversations").update({ recent_messages: [...((data.recent_messages ?? []) as TranscriptMessage[]), message].slice(-TRANSCRIPT_LIMIT), updated_at: new Date().toISOString() }).eq("client_id", clientId);
  if (updateError) throw updateError;
}

function currentPeriodKey(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function currentDayKey(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`; }

// WhatsApp is capped per month, Gemini per day, so each counter lives under its own period key.
const periodFor = (field: "outboundWhatsApp" | "geminiRequests", date: Date) => field === "outboundWhatsApp" ? currentPeriodKey(date) : currentDayKey(date);

export async function getUsageCounts(date = new Date()): Promise<{ outboundWhatsApp: number; geminiRequests: number }> {
  if (!hasDatabase()) return { outboundWhatsApp: 0, geminiRequests: 0 };
  const supabase = getSupabaseServer();
  const [month, day] = await Promise.all([
    supabase.from("usage_counters").select("outbound_whatsapp").eq("period_key", periodFor("outboundWhatsApp", date)).maybeSingle(),
    supabase.from("usage_counters").select("gemini_requests").eq("period_key", periodFor("geminiRequests", date)).maybeSingle(),
  ]);
  if (month.error) throw month.error;
  if (day.error) throw day.error;
  return { outboundWhatsApp: month.data?.outbound_whatsapp ?? 0, geminiRequests: day.data?.gemini_requests ?? 0 };
}

export async function incrementUsage(field: "outboundWhatsApp" | "geminiRequests", date = new Date()): Promise<void> {
  if (!hasDatabase()) return;
  const period = periodFor(field, date);
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
}

export function customerWindowOpen(lastClientMessageAt: Date | undefined, now = new Date()): boolean {
  if (!lastClientMessageAt) return false;
  return now.getTime() - lastClientMessageAt.getTime() <= 24 * 60 * 60 * 1000;
}

export { currentDayKey };
