import { getSupabaseServer } from "../_core/supabase";
import { hasDatabase } from "./core";

// The claim-then-send protocol that keeps an owner reminder from ever going out twice. See claim_reminder() in the
// 20261030 migration. Two instances, a restart, or an edited document all end at the same unique key.
const supabase = () => getSupabaseServer();

export async function claimReminder(key: string, kind: "quotation" | "balance" | "renewal", subjectId: string, staleMinutes = 15): Promise<boolean> {
  if (!hasDatabase()) return false;
  const { data, error } = await supabase().rpc("claim_reminder", { p_key: key, p_kind: kind, p_subject: subjectId, p_stale_minutes: staleMinutes });
  if (error) throw error;
  return data === true;
}

export async function finishReminder(key: string, ok: boolean, errorText?: string) {
  const { error } = await supabase().rpc("finish_reminder", { p_key: key, p_ok: ok, p_error: errorText ?? null });
  if (error) throw error;
}
