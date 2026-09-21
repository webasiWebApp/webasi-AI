export type OrderState =
  | "new"
  | "collecting"
  | "brief_complete"
  | "awaiting_deposit"
  | "slip_received"
  | "confirmed_by_owner"
  | "needs_owner"
  | "paused"
  | "abandoned"
  | "cancelled";

export const requiredOrderFields = [
  "clientName",
  "contactDetails",
  "businessName",
  "businessDescription",
  "chosenPackage",
  "budget",
  "deadline",
  "existingAssets",
] as const;

export function usagePercent(value: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((value / limit) * 100)));
}

export function canActivateProject(isReady: boolean): boolean {
  return isReady;
}

export function shouldSendReply({
  isOn,
  withinCustomerWindow,
  monthlyOutbound,
  monthlyCap,
}: {
  isOn: boolean;
  withinCustomerWindow: boolean;
  monthlyOutbound: number;
  monthlyCap: number;
}): boolean {
  if (!isOn || !withinCustomerWindow) return false;
  return monthlyOutbound < monthlyCap * 0.9;
}

export function nextOrderState(current: OrderState, event: "brief_complete" | "slip_received" | "owner_confirmed" | "pause" | "resume"): OrderState {
  if (event === "pause") return "paused";
  if (event === "resume" && current === "paused") return "collecting";
  if (event === "brief_complete" && current === "collecting") return "awaiting_deposit";
  if (event === "slip_received" && current === "awaiting_deposit") return "slip_received";
  if (event === "owner_confirmed" && current === "slip_received") return "confirmed_by_owner";
  return current;
}
