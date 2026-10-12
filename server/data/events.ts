import { getSupabaseServer } from "../_core/supabase";
import { hasDatabase } from "./core";

const mapEvent = (row: any) => ({ ...row, eventType: row.event_type, clientId: row.client_id, createdAt: row.created_at });

export async function recordEvent(input: { eventType: string; severity?: "info" | "warning" | "error"; title: string; detail: string; clientId?: string }) {
  if (!hasDatabase()) return;
  const { error } = await getSupabaseServer().from("event_log").insert({ event_type: input.eventType, severity: input.severity ?? "info", title: input.title, detail: input.detail, client_id: input.clientId ?? null });
  if (error) throw error;
}

export async function listEvents() {
  if (!hasDatabase()) return [];
  const { data, error } = await getSupabaseServer().from("event_log").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []).map(mapEvent);
}

export async function lastEventAt(eventType: string): Promise<Date | null> {
  if (!hasDatabase()) return null;
  const { data, error } = await getSupabaseServer().from("event_log").select("created_at").eq("event_type", eventType).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? new Date(data.created_at) : null;
}

// Every event of one type since a point in time, newest first: who was already reminded, what was already cleaned up.
export async function eventsSince(eventType: string, since: Date): Promise<Array<{ clientId: string | null; createdAt: string }>> {
  if (!hasDatabase()) return [];
  const { data, error } = await getSupabaseServer().from("event_log").select("client_id, created_at").eq("event_type", eventType).gte("created_at", since.toISOString()).order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({ clientId: row.client_id ?? null, createdAt: row.created_at }));
}
