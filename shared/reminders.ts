// Settings for the reminders sent to the owner on WhatsApp, and the keys that make each reminder unique.
export type ReminderSettings = { quotationEnabled: boolean; quotationDays: number; balanceEnabled: boolean; balanceDays: number; renewalEnabled: boolean };
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { quotationEnabled: true, quotationDays: 3, balanceEnabled: true, balanceDays: 3, renewalEnabled: true };

export function mergeReminderSettings(stored: unknown): ReminderSettings {
  const given = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const days = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 60 ? value : fallback);
  return {
    quotationEnabled: typeof given.quotationEnabled === "boolean" ? given.quotationEnabled : DEFAULT_REMINDER_SETTINGS.quotationEnabled,
    quotationDays: days(given.quotationDays, DEFAULT_REMINDER_SETTINGS.quotationDays),
    balanceEnabled: typeof given.balanceEnabled === "boolean" ? given.balanceEnabled : DEFAULT_REMINDER_SETTINGS.balanceEnabled,
    balanceDays: days(given.balanceDays, DEFAULT_REMINDER_SETTINGS.balanceDays),
    renewalEnabled: typeof given.renewalEnabled === "boolean" ? given.renewalEnabled : DEFAULT_REMINDER_SETTINGS.renewalEnabled,
  };
}

// The identity of one reminder. Editing or regenerating a document changes none of these inputs.
export const quotationReminderKey = (quotationId: string, sentAt: string) => `quotation:${quotationId}:${new Date(sentAt).toISOString()}`;
export const balanceReminderKey = (jobId: string, deliveredAt: string) => `balance:${jobId}:${new Date(deliveredAt).toISOString()}`;
export const renewalReminderKey = (renewalId: string, dueDate: string, window: "30d" | "7d") => `renewal:${renewalId}:${dueDate}:${window}`;
