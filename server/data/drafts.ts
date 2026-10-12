import { getSupabaseServer } from "../_core/supabase";
import { hasDatabase } from "./core";
import { SHADOW_DRAFT_CATEGORY } from "./insights";

// A reply WEBASI wrote in shadow mode, waiting for the owner to send, edit or discard it. Drafts live in the insights
// table like the other suggestions that wait for approval: "suggested" while waiting, "approved" once sent (with the
// text that actually went out), "dismissed" when discarded or replaced by a newer draft.
export type ShadowDraft = {
  id: string | number;
  clientId: string | null;
  clientMessage: string;
  draft: string;
  createdAt: string;
  clientName: string | null;
  waId: string | null;
};

export async function saveShadowDraft(input: { clientId: string; clientMessage: string; draft: string }) {
  if (!hasDatabase()) return false;
  const supabase = getSupabaseServer();
  // A newer draft answers the client's latest message, so one still waiting for the same client is out of date.
  const { error: replaceError } = await supabase.from("insights").update({ status: "dismissed" }).eq("category", SHADOW_DRAFT_CATEGORY).eq("status", "suggested").eq("client_id", input.clientId);
  if (replaceError) throw replaceError;
  const { error } = await supabase.from("insights").insert({ title: input.clientMessage.slice(0, 1000), detail: input.draft, category: SHADOW_DRAFT_CATEGORY, status: "suggested", client_id: input.clientId });
  if (error) throw error;
  return true;
}

export async function listShadowDrafts(): Promise<ShadowDraft[]> {
  if (!hasDatabase()) return [];
  const supabase = getSupabaseServer();
  const { data, error } = await supabase.from("insights").select("*").eq("category", SHADOW_DRAFT_CATEGORY).eq("status", "suggested").order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  const rows = data ?? [];
  const clientIds = Array.from(new Set(rows.map((row: any) => row.client_id).filter(Boolean)));
  const chats = new Map<string, { wa_id: string; profile_name: string | null }>();
  if (clientIds.length) {
    const { data: found, error: chatError } = await supabase.from("conversations").select("client_id, wa_id, profile_name").in("client_id", clientIds);
    if (chatError) throw chatError;
    for (const chat of found ?? []) chats.set(chat.client_id, chat);
  }
  return rows.map((row: any) => ({ id: row.id, clientId: row.client_id ?? null, clientMessage: row.title, draft: row.detail, createdAt: row.created_at, clientName: chats.get(row.client_id)?.profile_name ?? null, waId: chats.get(row.client_id)?.wa_id ?? null }));
}

export async function getShadowDraft(id: string | number) {
  if (!hasDatabase()) return null;
  const { data, error } = await getSupabaseServer().from("insights").select("id, client_id, title, detail").eq("id", id).eq("category", SHADOW_DRAFT_CATEGORY).eq("status", "suggested").maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, clientId: data.client_id as string | null, clientMessage: data.title as string, draft: data.detail as string } : null;
}

// Takes a waiting draft out of the queue. Only one caller gets `true`, so two clicks, or Send and Discard at the same
// moment, cannot both act on it. `sentText` records what went out when the owner edited the draft first.
export async function settleShadowDraft(id: string | number, status: "approved" | "dismissed", sentText?: string) {
  if (!hasDatabase()) return false;
  const { data, error } = await getSupabaseServer().from("insights").update({ status, ...(sentText ? { detail: sentText } : {}) }).eq("id", id).eq("category", SHADOW_DRAFT_CATEGORY).eq("status", "suggested").select("id");
  if (error) throw error;
  return Boolean(data?.length);
}

// Puts a draft back in the queue with its original wording after a send that did not go through.
export async function restoreShadowDraft(id: string | number, draft: string) {
  if (!hasDatabase()) return;
  const { error } = await getSupabaseServer().from("insights").update({ status: "suggested", detail: draft }).eq("id", id).eq("category", SHADOW_DRAFT_CATEGORY);
  if (error) throw error;
}
