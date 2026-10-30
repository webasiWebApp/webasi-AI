// The owner works on Sri Lanka time. Dates in the pipeline module are entered and shown in Asia/Colombo, while the
// database stores instants (timestamptz) and plain calendar dates (date).
export const TIME_ZONE = "Asia/Colombo";

// YYYY-MM-DD of an instant on the Colombo calendar.
export function colomboDate(at: Date | string | number = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

// "2026-10-28" plus days, calendar arithmetic only (no time zone involved).
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const parse = (value: string) => { const [year, month, day] = value.split("-").map(Number); return Date.UTC(year, month - 1, day); };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

// Whole calendar days since an instant, on the Colombo calendar.
export const daysSince = (at: Date | string | number, now: Date = new Date()) => daysBetween(colomboDate(at), colomboDate(now));

// 16.10.2026, as printed on the owner's documents.
export function dottedDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

// The Colombo wall-clock time "2026-10-28T09:30" as an instant (Sri Lanka has no daylight saving; UTC+05:30).
export function colomboLocalToInstant(local: string): Date {
  return new Date(`${local.length === 16 ? `${local}:00` : local}+05:30`);
}
export function instantToColomboLocal(at: Date | string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

// Messages to the owner go out at civil hours only, Sri Lanka time: from 09:00 up to, not including, 20:00.
export function isCivilHour(now: Date = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hour12: false }).format(now)) % 24;
  return hour >= 9 && hour < 20;
}
