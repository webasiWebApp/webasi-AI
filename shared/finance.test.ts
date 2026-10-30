import { describe, expect, it } from "vitest";
import { jobMoney, ledgerCsv, monthRange, summarizeFinance, type FinanceJobLike, type LedgerLike } from "./finance";
import { formatLkr, requiredAdvance, requiredAdvanceCents, toCents } from "./money";
import { addDays, colomboDate, colomboLocalToInstant, daysBetween, dottedDate, instantToColomboLocal } from "./time";

let n = 0;
const entry = (over: Partial<LedgerLike>): LedgerLike => ({ id: `e${++n}`, jobId: "j1", type: "income", category: "final", amount: 100, entryDate: "2026-10-10", ...over });
const job = (over: Partial<FinanceJobLike> = {}): FinanceJobLike => ({ id: "j1", title: "Site", clientName: "A", stage: "delivered", priceTotal: 1000, startedAt: "2026-10-01T00:00:00Z", ...over });

describe("how each ledger entry counts (cash basis, voided entries nowhere)", () => {
  const cases: Array<[string, Partial<LedgerLike>, Record<string, number>]> = [
    ["income advance", { category: "advance", amount: 400 }, { income: 400, received: 400, outstanding: 600, projectCosts: 0, companyCosts: 0 }],
    ["income final", { category: "final", amount: 600 }, { income: 600, received: 600, outstanding: 400, projectCosts: 0, companyCosts: 0 }],
    ["income extra", { category: "extra", amount: 250 }, { income: 250, received: 250, outstanding: 1000, projectCosts: 0, companyCosts: 0 }],
    ["income renewal", { category: "renewal", amount: 120 }, { income: 120, received: 120, outstanding: 1000, projectCosts: 0, companyCosts: 0 }],
    ["expense with a job", { type: "expense", category: "hosting", amount: 90 }, { income: 0, received: 0, outstanding: 1000, projectCosts: 90, companyCosts: 0 }],
    ["expense without a job", { type: "expense", category: "internet", jobId: null, amount: 45 }, { income: 0, received: 0, outstanding: 1000, projectCosts: 0, companyCosts: 45 }],
    ["voided income", { category: "final", amount: 600, voidedAt: "2026-10-11T00:00:00Z" }, { income: 0, received: 0, outstanding: 1000, projectCosts: 0, companyCosts: 0 }],
    ["voided expense", { type: "expense", category: "hosting", amount: 90, voidedAt: "2026-10-11T00:00:00Z" }, { income: 0, received: 0, outstanding: 1000, projectCosts: 0, companyCosts: 0 }],
  ];
  it.each(cases)("%s", (_name, over, expected) => {
    const entries = [entry(over)];
    const summary = summarizeFinance(entries, [job()]);
    const money = jobMoney(job(), entries);
    expect({ income: summary.income, received: money.received, outstanding: money.outstanding, projectCosts: summary.projectCosts, companyCosts: summary.companyCosts }).toEqual(expected);
  });

  it("company profit is income minus project costs minus company costs, with nothing counted twice or dropped", () => {
    const entries = [
      entry({ category: "advance", amount: 400 }), entry({ category: "final", amount: 600 }), entry({ category: "extra", amount: 50 }), entry({ category: "renewal", amount: 70 }),
      entry({ type: "expense", category: "hosting", amount: 30 }), entry({ type: "expense", category: "internet", jobId: null, amount: 20 }), entry({ category: "final", amount: 9999, voidedAt: "x" }),
    ];
    const summary = summarizeFinance(entries, [job()]);
    expect(summary).toMatchObject({ income: 1120, projectCosts: 30, companyCosts: 20, companyProfit: 1070, receivables: 0 });
    expect(summary.perJob[0]).toMatchObject({ received: 1120, costs: 30, profit: 1090, outstanding: 0 });
  });

  it("shows overpayment separately and never a negative balance", () => {
    const money = jobMoney(job(), [entry({ category: "advance", amount: 400 }), entry({ category: "final", amount: 700 })]);
    expect(money).toMatchObject({ outstanding: 0, overpaid: 100, paidTowardPrice: 1100 });
  });

  it("sums in cents so fractions never drift", () => {
    const entries = Array.from({ length: 10 }, () => entry({ category: "final", amount: 0.1 }));
    expect(summarizeFinance(entries, [job({ priceTotal: 1 })]).income).toBe(1);
    expect(jobMoney(job({ priceTotal: 1 }), entries).outstanding).toBe(0);
  });

  it("filters by month for income and costs, but reports receivables as of now", () => {
    const entries = [entry({ category: "advance", amount: 400, entryDate: "2026-09-30" }), entry({ category: "final", amount: 100, entryDate: "2026-10-01" }), entry({ type: "expense", category: "ads", jobId: null, amount: 10, entryDate: "2026-10-31" })];
    const october = summarizeFinance(entries, [job()], monthRange("2026-10"));
    expect(october).toMatchObject({ income: 100, companyCosts: 10, companyProfit: 90, receivables: 500 });
    expect(summarizeFinance(entries, [job()], monthRange("2026-09")).income).toBe(400);
    expect(summarizeFinance(entries, [job()]).income).toBe(500);
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02").to).toBe("2028-02-29");
  });

  it("lists who owes what and the invoiced renewals as a separate line", () => {
    const jobs = [job(), job({ id: "j2", title: "Other", priceTotal: 500, stage: "active" }), job({ id: "j3", stage: "approved", priceTotal: 800 })];
    const summary = summarizeFinance([entry({ category: "advance", amount: 200 })], jobs, {}, [{ status: "invoiced", amount: 150 }, { status: "paid", amount: 99 }, { status: "upcoming", amount: 77 }]);
    expect(summary.owing.map((row) => [row.jobId, row.outstanding])).toEqual([["j1", 800], ["j2", 500]]); // the approved job has not started: not a receivable yet
    expect(summary).toMatchObject({ receivables: 1300, renewalReceivables: 150 });
  });

  it("builds a monthly trend", () => {
    const entries = [entry({ category: "advance", amount: 400, entryDate: "2026-09-30" }), entry({ type: "expense", category: "ads", jobId: null, amount: 100, entryDate: "2026-09-02" }), entry({ category: "final", amount: 100, entryDate: "2026-10-01" })];
    expect(summarizeFinance(entries, [job()]).monthly).toEqual([{ month: "2026-09", income: 400, costs: 100, profit: 300 }, { month: "2026-10", income: 100, costs: 0, profit: 100 }]);
  });
});

describe("CSV export", () => {
  it("quotes cells and neutralises spreadsheet formulas", () => {
    const csv = ledgerCsv([{ ...entry({ amount: 12.5 }), note: '=SUM(A1) "quoted", yes', method: "cash", jobTitle: "Site" }, { ...entry({ voidedAt: "x" }), voidedReason: "typo" }]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`"2026-10-10","income","final","12.50","Site","cash","'=SUM(A1) ""quoted"", yes","ok",""`);
    expect(lines[2]).toContain('"void","typo"');
  });
});

describe("money", () => {
  it("formats LKR like the owner's documents", () => {
    expect(formatLkr(40000)).toBe("LKR 40,000");
    expect(formatLkr(40000.5)).toBe("LKR 40,000.50");
    expect(formatLkr(0)).toBe("LKR 0");
    expect(formatLkr(-1250)).toBe("-LKR 1,250");
    expect(formatLkr(null)).toBe("LKR 0");
  });
  it("rounds the required advance to the cent like the database does", () => {
    expect(requiredAdvance(40_000, 40)).toBe(16_000);
    expect(requiredAdvance(45_555, 40)).toBe(18_222);
    expect(requiredAdvanceCents(toCents(33.33), 33.33)).toBe(Math.round((3333 * 3333) / 10_000));
    expect(requiredAdvance(100, 12.5)).toBe(12.5);
  });
});

describe("time on the Colombo calendar", () => {
  it("dates an instant in Sri Lanka time", () => {
    expect(colomboDate("2026-10-27T20:00:00Z")).toBe("2026-10-28"); // 01:30 the next day in Colombo
    expect(colomboDate("2026-10-27T10:00:00Z")).toBe("2026-10-27");
  });
  it("does calendar arithmetic and prints the owner's date style", () => {
    expect(addDays("2026-10-16", 30)).toBe("2026-11-15");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-01", "2026-10-28")).toBe(27);
    expect(dottedDate("2026-10-16")).toBe("16.10.2026");
  });
  it("converts between Colombo wall-clock time and an instant", () => {
    expect(colomboLocalToInstant("2026-10-28T09:30").toISOString()).toBe("2026-10-28T04:00:00.000Z");
    expect(instantToColomboLocal("2026-10-28T04:00:00.000Z")).toBe("2026-10-28T09:30");
    expect(instantToColomboLocal("2026-10-27T18:30:00.000Z")).toBe("2026-10-28T00:00");
  });
});
