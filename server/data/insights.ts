import { getSupabaseServer } from "../_core/supabase";
import { asQuestionLine, hasDatabase } from "./core";
import { listConversations } from "./conversations";
import { recordEvent } from "./events";
import { appendProjectFaq } from "./training";

const mapInsight = (row: any) => ({ ...row, createdAt: row.created_at });

// Replies drafted in shadow mode wait for the owner in this table too (see drafts.ts); they have their own page.
export const SHADOW_DRAFT_CATEGORY = "Shadow draft";

export async function listInsights() {
  if (!hasDatabase()) return [];
  const { data, error } = await getSupabaseServer().from("insights").select("*").neq("status", "dismissed").neq("category", SHADOW_DRAFT_CATEGORY).order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapInsight);
}

export async function setInsightStatus(id: string | number, status: "approved" | "dismissed", detail?: string) {
  if (!hasDatabase()) return false;
  const supabase = getSupabaseServer();
  const { data: before, error: readError } = await supabase.from("insights").select("category, detail, status").eq("id", id).maybeSingle();
  if (readError) throw readError;
  if (!before) return false;
  if (status !== "approved" || before.category !== "Learned answer") {
    const { error } = await supabase.from("insights").update({ status, ...(detail ? { detail } : {}) }).eq("id", id);
    if (error) throw error;
    return true;
  }
  // A learned answer goes into the knowledge base exactly once: claiming it while it is still "suggested" stops a
  // second click from adding it again, and it is handed back if the knowledge base could not take it.
  const answer = detail ?? before.detail;
  const { data: claimed, error } = await supabase.from("insights").update({ status, detail: answer }).eq("id", id).eq("status", "suggested").select("id");
  if (error) throw error;
  if (!claimed?.length) return false;
  try {
    await appendProjectFaq(answer);
  } catch (appendError) {
    await supabase.from("insights").update({ status: before.status, detail: before.detail }).eq("id", id);
    throw appendError;
  }
  return true;
}

const ANALYSIS_CATEGORIES = ["Objection", "Language", "Drop-off", "Handover"];

export async function analyzeInsights() {
  const rows = await listConversations();
  const messages = rows.flatMap((row) => { try { return JSON.parse(row.recentMessages) as Array<{ role?: string; text?: string }>; } catch { return []; } });
  const clientText = messages.filter((message) => message.role === "client").map((message) => message.text ?? "").join(" ").toLowerCase();
  const priceMentions = (clientText.match(/price|cost|budget|expensive|discount|cheap/g) ?? []).length;
  // Whole words only: "one" is also inside "phone" and "money".
  const singlishMentions = (clientText.match(/\b(?:mata|one|puluwan|kiyada|hari|eka|ganna)\b/g) ?? []).length;
  const dropoffStates = rows.filter((row) => ["collecting", "awaiting_deposit", "needs_owner"].includes(row.state));
  const handovers = rows.filter((row) => row.state === "needs_owner" || row.handedOver);
  const generated = [
    priceMentions > 0 ? { title: "Price and budget questions recur in client chats", detail: `${priceMentions} price-related mentions were found across the latest ${rows.length} conversations. Review the package FAQ and objection handling before adding anything to project knowledge.`, category: "Objection", status: "suggested" as const } : null,
    singlishMentions > 0 ? { title: "Clients frequently use English and Singlish together", detail: `${singlishMentions} Singlish markers were found in recent client messages. Keep mirroring the client’s language style and review the tone guidance.`, category: "Language", status: "suggested" as const } : null,
    dropoffStates.length > 0 ? { title: "Conversations are dropping off before confirmation", detail: `${dropoffStates.length} conversations remain in collecting, awaiting deposit, or needs owner states. Review the next-step prompts and escalation rules.`, category: "Drop-off", status: "suggested" as const } : null,
    handovers.length > 0 ? { title: "Questions are being handed over to you", detail: `${handovers.length} conversations were escalated because WEBASI could not answer from the project facts. Open them in Conversations and add the missing answers to the project's training.`, category: "Handover", status: "suggested" as const } : null,
  ].filter((item): item is { title: string; detail: string; category: string; status: "suggested" } => Boolean(item));
  if (!hasDatabase()) return [];
  const supabase = getSupabaseServer();
  // Only the suggestions this analysis writes are replaced. Learned answers waiting for approval are also "suggested" and must survive.
  const { error } = await supabase.from("insights").delete().eq("status", "suggested").in("category", ANALYSIS_CATEGORIES);
  if (error) throw error;
  if (generated.length > 0) {
    const { error: insertError } = await supabase.from("insights").insert(generated);
    if (insertError) throw insertError;
  }
  return listInsights();
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
  if (!q || !hasDatabase()) return false;
  const supabase = getSupabaseServer();
  // Deduplicate: don't store the same question twice within 24 h.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  // limit(1), not maybeSingle(): that reports an error once two copies exist, which read as "none" and added a third.
  const { data: existing, error: existingError } = await supabase.from("knowledge_gaps").select("id").eq("question", q).eq("status", "pending").gte("created_at", since).limit(1);
  if (existingError) throw existingError;
  if (existing?.length) return false;
  const { error } = await supabase.from("knowledge_gaps").insert({ question: q, reason, client_id: clientId ?? null, status: "pending", answer: null });
  if (error) throw error;
  return true;
}

export async function listKnowledgeGaps(): Promise<KnowledgeGap[]> {
  if (!hasDatabase()) return [];
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
  if (!text || !hasDatabase()) return false;
  const supabase = getSupabaseServer();
  // Claiming the gap while it is still pending means two submissions at once cannot both add the answer.
  const { data: claimed, error } = await supabase.from("knowledge_gaps").update({ status: "answered", answer: text }).eq("id", id).eq("status", "pending").select("question");
  if (error) throw error;
  const gap = claimed?.[0];
  if (!gap) return false;
  // Append as FAQ so the bot can answer this question immediately next time (this also rebuilds the FAQ cache).
  try {
    await appendProjectFaq(`Q: ${asQuestionLine(gap.question)}\nA: ${text}`);
  } catch (appendError) {
    // Not in the knowledge base, so not answered: reopen it instead of showing "added to FAQs" for an answer the bot never got.
    await supabase.from("knowledge_gaps").update({ status: "pending", answer: null }).eq("id", id);
    throw appendError;
  }
  await recordEvent({ eventType: "knowledge_gap_answered", severity: "info", title: "Knowledge gap answered", detail: `Q: ${gap.question.slice(0, 200)}\nA: ${text.slice(0, 200)}` });
  return true;
}
