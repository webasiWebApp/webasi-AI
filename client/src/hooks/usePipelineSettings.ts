import { trpc } from "@/lib/trpc";
import type { DocumentSettings } from "@shared/documents";
import type { ReminderSettings } from "@shared/reminders";

// The settings the pipeline module adds. The settings query itself is loosely typed (it spreads a database row), so the
// fields this module relies on are given their real types here.
export type PipelineSettingsFields = {
  registrationNo: string; nextDocumentNumber: number; defaultAdvancePercent: number; documentSettings: DocumentSettings;
  reminderSettings: ReminderSettings; ledgerCategories: { income: string[]; expense: string[] }; templateReviewDismissed: boolean;
};

export function usePipelineSettings() {
  const query = trpc.dashboard.settings.useQuery(undefined, { retry: false });
  return { ...query, data: query.data as (PipelineSettingsFields & Record<string, unknown>) | undefined };
}
