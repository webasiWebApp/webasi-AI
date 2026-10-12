import { getSupabaseServer } from "../_core/supabase";
import { appendTranscriptMessage, type TranscriptMessage } from "../db";
import { asQuestionLine, hasDatabase } from "./core";
import { recordEvent } from "./events";

const mapConversation = (row: any) => ({ ...row, clientId: row.client_id, waId: row.wa_id, profileName: row.profile_name, isPaused: Boolean(row.is_paused), missingFields: row.missing_fields ?? [], extractedFields: row.extracted_fields ?? {}, recentMessages: JSON.stringify(row.recent_messages ?? []), lastClientMessageAt: row.last_client_message_at, intentScore: row.intent_score as "high" | "medium" | "low" | null, handedOver: Boolean(row.handed_over), needsOwner: Boolean(row.handed_over) || row.state === "needs_owner", sentiment: row.sentiment as string | null, objection: row.objection as string | null, language: row.language as string | null, clientNotes: (row.client_notes ?? "") as string, followupSentAt: row.followup_sent_at ? new Date(row.followup_sent_at) : null, createdAt: row.created_at, updatedAt: row.updated_at });

export async function listConversations() {
  if (!hasDatabase()) return [];
  const { data, error } = await getSupabaseServer().from("conversations").select("*").order("updated_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []).map(mapConversation);
}

const SINGLISH_MARKERS = /\b(mata|one|puluwan|kiyada|hari|eka)\b/i;

// What the dashboard lists need from a chat: everything except the transcript, which is replaced by its last message
// and a few counts. The open chat's full transcript comes from getConversationByClientId, so the list that is
// refreshed every few seconds stays small however long the chats are.
export async function listConversationSummaries() {
  return (await listConversations()).map(({ recentMessages, recent_messages: _raw, ...summary }) => {
    const messages = (() => { try { return JSON.parse(recentMessages) as TranscriptMessage[]; } catch { return []; } })();
    const last = [...messages].reverse().find((message) => (message.text ?? "").trim());
    return {
      ...summary,
      lastMessage: last ? { role: last.role, text: last.text.slice(0, 200) } : null,
      messageCount: messages.length,
      questionCount: messages.filter((message) => (message.text ?? "").includes("?")).length,
      singlishCount: messages.filter((message) => SINGLISH_MARKERS.test(message.text ?? "")).length,
    };
  });
}

export async function getConversationByClientId(clientId: string) {
  if (!hasDatabase()) return null;
  const { data, error } = await getSupabaseServer().from("conversations").select("*").eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  return data ? mapConversation(data) : null;
}

export async function pauseConversationByWaId(waId: string) {
  if (!hasDatabase()) return false;
  const { data, error } = await getSupabaseServer().from("conversations").update({ is_paused: true, updated_at: new Date().toISOString() }).eq("wa_id", waId).eq("is_paused", false).select("client_id");
  if (error) throw error;
  if (data?.[0]) await recordEvent({ eventType: "owner_echo", severity: "info", title: "Owner takeover detected", detail: "You replied from the phone; WEBASI is paused for this chat.", clientId: data[0].client_id });
  return true;
}

export async function recordOwnerMessageByWaId(waId: string, text: string) {
  const normalized = text.trim();
  if (!hasDatabase() || !normalized) return false;
  const { data, error } = await getSupabaseServer().from("conversations").select("client_id, recent_messages").eq("wa_id", waId).maybeSingle();
  if (error) throw error;
  if (!data) return false;
  // The phone echoes a message the dashboard already recorded: the same owner text twice in a row is one message.
  const last = ((data.recent_messages ?? []) as TranscriptMessage[]).at(-1);
  if (last?.role === "owner" && last.text === normalized) return true;
  await appendTranscriptMessage(data.client_id, { role: "owner", text: normalized });
  return true;
}

export async function captureLearnedAnswer(waId: string, ownerText: string) {
  if (!hasDatabase() || ownerText.trim().length < 3) return false;
  const supabase = getSupabaseServer();
  const { data, error } = await supabase.from("conversations").select("client_id, handed_over, recent_messages").eq("wa_id", waId).maybeSingle();
  if (error) throw error;
  const messages = (data?.recent_messages ?? []) as Array<{ role: string; text: string }>;
  const last = messages.at(-1);
  // Only the first owner reply right after a client question in a handed-over chat is a new answer.
  if (!data?.handed_over || last?.role !== "client") return false;
  const question = asQuestionLine(last.text);
  const { error: insertError } = await supabase.from("insights").insert({ title: question.slice(0, 200), detail: `Q: ${question}\nA: ${ownerText.trim()}`, category: "Learned answer", status: "suggested", client_id: data.client_id });
  if (insertError) throw insertError;
  return true;
}

// Hands the chat back to WEBASI: lifts the owner's pause and the handover, so the next client message is answered again.
export async function resumeConversation(clientId: string) {
  if (!hasDatabase()) return false;
  const { error } = await getSupabaseServer().from("conversations").update({ is_paused: false, handed_over: false, updated_at: new Date().toISOString() }).eq("client_id", clientId);
  if (error) throw error;
  return true;
}

export async function pauseConversation(clientId: string) {
  if (!hasDatabase()) return false;
  // The takeover is logged when the chat becomes paused, not again for every message the owner then sends from the dashboard.
  const { data, error } = await getSupabaseServer().from("conversations").update({ is_paused: true, updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("is_paused", false).select("client_id");
  if (error) throw error;
  if (data?.length) await recordEvent({ eventType: "dashboard_takeover", severity: "info", title: "Conversation taken over", detail: `Owner paused WEBASI from the dashboard for client ${clientId}.`, clientId });
  return true;
}

// text = null marks the silence as handled without adding to the transcript (shadow-mode drafts).
export async function recordFollowUp(clientId: string, text: string | null, sentAt = new Date()) {
  if (!hasDatabase()) return false;
  if (text) await appendTranscriptMessage(clientId, { role: "assistant", text, at: sentAt.toISOString() });
  const { error } = await getSupabaseServer().from("conversations").update({ followup_sent_at: sentAt.toISOString() }).eq("client_id", clientId);
  if (error) throw error;
  return true;
}
