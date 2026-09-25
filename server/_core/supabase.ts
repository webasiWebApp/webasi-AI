import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ENV } from "./env";

let client: SupabaseClient | null = null;

export function getSupabaseServer(): SupabaseClient {
  if (!ENV.supabaseUrl || !ENV.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server persistence");
  }

  if (!client) {
    client = createClient(ENV.supabaseUrl, ENV.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return client;
}

export async function checkSupabaseConnection() {
  try {
    const { error } = await getSupabaseServer().from("settings").select("id").limit(1);
    return { ok: !error, error: error?.message };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "supabase_unavailable" };
  }
}
