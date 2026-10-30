import { fromCents, toCents } from "./money";

// The finance rules in one pure place (cash basis, by entry date, LKR only, voided entries counted nowhere):
//
//   entry                      | company income | job received | job outstanding | project costs | company costs
//   income advance / final     | yes            | yes          | reduces it      |               |
//   income extra               | yes            | yes          | no              |               |
//   income renewal             | yes            | yes          | no              |               |
//   expense with a job         |                |              |                 | yes           |
//   expense without a job      |                |              |                 |               | yes
//
// Sums are whole cents, never floats.
export type LedgerLike = { id: string; jobId: string | null; type: "income" | "expense"; category: string; amount: number; entryDate: string; voidedAt?: string | null };
export type FinanceJobLike = { id: string; title: string; clientName: string; stage: string; priceTotal: number | null; startedAt: string | null };
export type RenewalLike = { status: string; amount: number };

// The part of a payment that settles the quoted price. Extra work and renewals are paid on top of it.
export const SETTLES_PRICE = ["advance", "final"];

const live = (entries: LedgerLike[]) => entries.filter((entry) => !entry.voidedAt);

export type JobMoney = { price: number; advanceDue: number; received: number; paidTowardPrice: number; outstanding: number; overpaid: number; costs: number; profit: number };

export function jobMoney(job: Pick<FinanceJobLike, "id" | "priceTotal">, entries: LedgerLike[], advancePercent?: number | null): JobMoney {
  const mine = live(entries).filter((entry) => entry.jobId === job.id);
  const sum = (rows: LedgerLike[]) => rows.reduce((total, entry) => total + toCents(entry.amount), 0);
  const income = mine.filter((entry) => entry.type === "income");
  const paidCents = sum(income.filter((entry) => SETTLES_PRICE.includes(entry.category)));
  const receivedCents = sum(income);
  const costsCents = sum(mine.filter((entry) => entry.type === "expense"));
  const priceCents = toCents(job.priceTotal);
  return {
    price: fromCents(priceCents),
    advanceDue: advancePercent ? fromCents(Math.round((priceCents * Math.round(advancePercent * 100)) / 10_000)) : 0,
    received: fromCents(receivedCents),
    paidTowardPrice: fromCents(paidCents),
    outstanding: fromCents(Math.max(priceCents - paidCents, 0)),
    overpaid: fromCents(Math.max(paidCents - priceCents, 0)),
    costs: fromCents(costsCents),
    profit: fromCents(receivedCents - costsCents),
  };
}

export type Range = { from?: string; to?: string }; // inclusive YYYY-MM-DD, either end optional
export const inRange = (date: string, range: Range = {}) => (!range.from || date >= range.from) && (!range.to || date <= range.to);

export function monthRange(month: string): Range {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

const STARTED = ["active", "delivered", "closed"];

export type FinanceSummary = {
  income: number;
  projectCosts: number;
  companyCosts: number;
  companyProfit: number;
  receivables: number;
  renewalReceivables: number;
  owing: Array<{ jobId: string; title: string; clientName: string; outstanding: number }>;
  perJob: Array<{ jobId: string; title: string; clientName: string; stage: string; price: number; received: number; outstanding: number; costs: number; profit: number }>;
  monthly: Array<{ month: string; income: number; costs: number; profit: number }>;
  costsByCategory: Array<{ category: string; amount: number }>;
};

export function summarizeFinance(entries: LedgerLike[], jobs: FinanceJobLike[], range: Range = {}, renewals: RenewalLike[] = []): FinanceSummary {
  const inPeriod = live(entries).filter((entry) => inRange(entry.entryDate, range));
  const cents = (rows: LedgerLike[]) => rows.reduce((total, entry) => total + toCents(entry.amount), 0);
  const incomeCents = cents(inPeriod.filter((entry) => entry.type === "income"));
  const projectCostCents = cents(inPeriod.filter((entry) => entry.type === "expense" && entry.jobId));
  const companyCostCents = cents(inPeriod.filter((entry) => entry.type === "expense" && !entry.jobId));

  const started = jobs.filter((job) => STARTED.includes(job.stage));
  const owing = started
    .map((job) => ({ jobId: job.id, title: job.title, clientName: job.clientName, outstanding: jobMoney(job, entries).outstanding }))
    .filter((row) => row.outstanding > 0);
  const receivablesCents = owing.reduce((total, row) => total + toCents(row.outstanding), 0);
  const renewalCents = renewals.filter((renewal) => renewal.status === "invoiced").reduce((total, renewal) => total + toCents(renewal.amount), 0);

  const perJob = jobs
    .filter((job) => STARTED.includes(job.stage))
    .map((job) => {
      const windowed = jobMoney(job, inPeriod);
      const overall = jobMoney(job, entries);
      return { jobId: job.id, title: job.title, clientName: job.clientName, stage: job.stage, price: overall.price, received: windowed.received, outstanding: overall.outstanding, costs: windowed.costs, profit: windowed.profit };
    })
    .filter((row) => row.received > 0 || row.costs > 0 || row.outstanding > 0);

  const months = new Map<string, { income: number; costs: number }>();
  for (const entry of live(entries)) {
    const month = entry.entryDate.slice(0, 7);
    const bucket = months.get(month) ?? { income: 0, costs: 0 };
    bucket[entry.type === "income" ? "income" : "costs"] += toCents(entry.amount);
    months.set(month, bucket);
  }
  const monthly = [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, bucket]) => ({ month, income: fromCents(bucket.income), costs: fromCents(bucket.costs), profit: fromCents(bucket.income - bucket.costs) }));

  const byCategory = new Map<string, number>();
  for (const entry of inPeriod.filter((row) => row.type === "expense")) byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + toCents(entry.amount));

  return {
    income: fromCents(incomeCents),
    projectCosts: fromCents(projectCostCents),
    companyCosts: fromCents(companyCostCents),
    companyProfit: fromCents(incomeCents - projectCostCents - companyCostCents),
    receivables: fromCents(receivablesCents),
    renewalReceivables: fromCents(renewalCents),
    owing,
    perJob,
    monthly,
    costsByCategory: [...byCategory.entries()].map(([category, amount]) => ({ category, amount: fromCents(amount) })).sort((a, b) => b.amount - a.amount),
  };
}

export const DEFAULT_LEDGER_CATEGORIES = {
  income: ["advance", "final", "renewal", "extra"],
  expense: ["hosting", "domain", "software", "freelancer", "ads", "internet", "salary", "other"],
};
export const INCOME_CATEGORIES = DEFAULT_LEDGER_CATEGORIES.income; // fixed: the database and the formulas above depend on them
export const PAYMENT_METHODS = ["bank_transfer", "cash", "paypal", "other"] as const;

// CSV with a header, quoted cells, and a leading formula character neutralised so a spreadsheet never runs a note.
export function ledgerCsv(entries: Array<LedgerLike & { method?: string; note?: string; voidedReason?: string | null; jobTitle?: string }>) {
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ["date", "type", "category", "amount_lkr", "job", "method", "note", "status", "void_reason"];
  const rows = entries.map((entry) => [entry.entryDate, entry.type, entry.category, entry.amount.toFixed(2), entry.jobTitle ?? (entry.jobId ? entry.jobId : "company"), entry.method ?? "", entry.note ?? "", entry.voidedAt ? "void" : "ok", entry.voidedReason ?? ""]);
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
