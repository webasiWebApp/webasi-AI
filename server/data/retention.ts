import { getSupabaseServer } from "../_core/supabase";
import { hasDatabase } from "./core";

// Deletes the rows of an append-only table that are older than the cutoff and reports how many went.
export async function deleteOlderThan(table: "event_log" | "messages", cutoff: Date): Promise<number> {
  if (!hasDatabase()) return 0;
  const { count, error } = await getSupabaseServer().from(table).delete({ count: "exact" }).lt("created_at", cutoff.toISOString());
  if (error) throw error;
  return count ?? 0;
}
