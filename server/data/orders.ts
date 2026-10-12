import { getSupabaseServer } from "../_core/supabase";
import { hasDatabase } from "./core";
import { recordEvent } from "./events";

const mapOrder = (row: any) => ({ ...row, orderKey: row.order_key, clientId: row.client_id, waId: row.wa_id, packageName: row.package_name, depositAmount: row.deposit_amount, slipMediaId: row.slip_media_id, createdAt: row.created_at, updatedAt: row.updated_at });

export async function createOrder(input: { orderKey: string; clientId: string; waId: string; packageName: string; depositAmount: number; slipMediaId?: string; state?: "awaiting_deposit" | "slip_received" | "confirmed_by_owner"; notes?: string }) {
  if (!hasDatabase()) return null;
  const { error } = await getSupabaseServer().from("orders").upsert({ order_key: input.orderKey, client_id: input.clientId, wa_id: input.waId, package_name: input.packageName, deposit_amount: input.depositAmount, slip_media_id: input.slipMediaId ?? null, state: input.state ?? "awaiting_deposit", notes: input.notes ?? "", updated_at: new Date().toISOString() }, { onConflict: "order_key" });
  if (error) throw error;
  return true;
}

export async function markOrderSlipReceived(waId: string, slipMediaId?: string) {
  if (!hasDatabase()) return false;
  const { data, error } = await getSupabaseServer().from("orders").update({ state: "slip_received", slip_media_id: slipMediaId ?? null, notes: "Payment slip received; owner verification required.", updated_at: new Date().toISOString() }).eq("wa_id", waId).eq("state", "awaiting_deposit").select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

// The newest orders; the dashboard does not page, and an ever-growing list would be downloaded on every refresh.
const ORDER_LIST_LIMIT = 200;

export async function listOrders() {
  if (!hasDatabase()) return [];
  const { data, error } = await getSupabaseServer().from("orders").select("*").order("updated_at", { ascending: false }).limit(ORDER_LIST_LIMIT);
  if (error) throw error;
  return (data ?? []).map(mapOrder);
}

// Only an order whose slip has arrived can be confirmed (see nextOrderState). Returns false when there is no such order,
// so the dashboard never reports a confirmation that did not happen.
export async function confirmOrder(orderKey: string) {
  if (!hasDatabase()) return false;
  const supabase = getSupabaseServer();
  const { data, error } = await supabase.from("orders").update({ state: "confirmed_by_owner", updated_at: new Date().toISOString() }).eq("order_key", orderKey).eq("state", "slip_received").select("client_id");
  if (error) throw error;
  const confirmed = data?.[0];
  if (!confirmed) return false;
  // The chat moves on with its order. The order is already confirmed, so a failure here is logged rather than reported as one.
  const { error: chatError } = await supabase.from("conversations").update({ state: "confirmed_by_owner", updated_at: new Date().toISOString() }).eq("client_id", confirmed.client_id).eq("state", "slip_received");
  if (chatError) console.error("[Orders] conversation state not updated after confirmation", chatError.message);
  await recordEvent({ eventType: "order_confirmed", severity: "info", title: "Deposit confirmed", detail: `The owner confirmed the deposit for order ${orderKey}.`, clientId: confirmed.client_id }).catch((eventError) => console.error("[Orders] event log failed", eventError instanceof Error ? eventError.message : eventError));
  return true;
}
