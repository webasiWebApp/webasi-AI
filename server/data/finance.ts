import { ledgerCsv, monthRange, summarizeFinance, type Range } from "../../shared/finance";
import { hasDatabase } from "./core";
import { listJobs } from "./jobs";
import { listLedger } from "./ledger";
import { listRenewals } from "./renewals";

// month: "2026-10", or nothing for all time.
export const rangeFor = (month?: string): Range => (month ? monthRange(month) : {});

export async function financeOverview(month?: string) {
  const range = rangeFor(month);
  if (!hasDatabase()) return { month: month ?? null, range, summary: summarizeFinance([], [], range), entries: [] };
  const [entries, jobs, renewals, shown] = await Promise.all([listLedger({}), listJobs(), listRenewals({ status: ["invoiced"] }), listLedger({ ...range, includeVoid: true, limit: 300 })]);
  const titles = new Map(jobs.map((job) => [job.id, `${job.clientName} – ${job.title}`]));
  return {
    month: month ?? null, range,
    summary: summarizeFinance(entries, jobs, range, renewals),
    entries: shown.map((entry) => ({ ...entry, jobTitle: entry.jobId ? titles.get(entry.jobId) ?? null : null })),
  };
}

export async function ledgerExport(month?: string) {
  const range = rangeFor(month);
  const [entries, jobs] = await Promise.all([listLedger({ ...range, includeVoid: true }), listJobs()]);
  const titles = new Map(jobs.map((job) => [job.id, `${job.clientName} – ${job.title}`]));
  return ledgerCsv(entries.map((entry) => ({ ...entry, jobTitle: entry.jobId ? titles.get(entry.jobId) : "company" })));
}
