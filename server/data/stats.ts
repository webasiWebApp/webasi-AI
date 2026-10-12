import { getSupabaseServer } from "../_core/supabase";
import { hasDatabase } from "./core";

export type WeeklyStats = {
  activeChats: number; newChats: number; hotLeads: number; frustrated: number; handovers: number;
  messagesIn: number; messagesOut: number; ordersCreated: number; slipsWaiting: number; confirmedOrders: number; confirmedDeposits: number;
  followUpsSent: number; knowledgeAdded: number; learnedAnswersPending: number; topObjections: Array<[string, number]>;
  meetingsRequested: number;
};

export async function getWeeklyStats(now = new Date()): Promise<WeeklyStats | null> {
  if (!hasDatabase()) return null;
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
