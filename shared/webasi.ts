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

export function trainingReadiness(checklist: readonly string[], answers: Record<string, string>, summary: string): { completed: number; total: number; readiness: number; complete: boolean } {
  const completed = checklist.filter((item) => Boolean(answers[item]?.trim())).length;
  const total = checklist.length;
  const readiness = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { completed, total, readiness, complete: completed === total && Boolean(summary.trim()) };
}

export function usagePercent(value: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((value / limit) * 100)));
}

export function canActivateProject(isReady: boolean): boolean {
  return isReady;
}

export function formatAutomationAudit({ actor, project, previous, next, detail }: { actor: string; project: string; previous: string; next: string; detail: string }): string {
  return `Actor: ${actor}. Project: ${project}. Previous: ${previous}. New: ${next}. ${detail}`;
}

export function safeEventExportRows(events: Array<{ id: number; eventType: string; severity: string; title: string; detail: string; clientId?: string | null; createdAt: Date | string }>) {
  return events.map((event) => ({ id: event.id, eventType: event.eventType, severity: event.severity, title: event.title, detail: event.detail, clientId: event.clientId ?? "", createdAt: new Date(event.createdAt).toISOString() }));
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
