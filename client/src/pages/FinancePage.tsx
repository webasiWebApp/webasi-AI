import { trpc } from "@/lib/trpc";
import { cn, PageHeader } from "@/components/dashboard/shared";
import { Busy, Card, Empty, Modal, SelectInput, Stat, TextInput, dayText, formatLkr, newKey } from "@/components/pipeline/kit";
import { VoidModal } from "@/pages/job/MoneyTab";
import { PAYMENT_METHODS } from "@shared/finance";
import { colomboDate } from "@shared/time";
import { Download, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";

export default function FinancePage() {
  const thisMonth = colomboDate().slice(0, 7);
  const [month, setMonth] = useState<string | null>(thisMonth);
  const finance = trpc.finance.overview.useQuery({ month: month ?? undefined }, { retry: false });
  const utils = trpc.useUtils();
  const refresh = () => { utils.finance.overview.invalidate(); utils.ledger.list.invalidate(); utils.jobs.list.invalidate(); utils.jobs.get.invalidate(); };
  const [spending, setSpending] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const data = finance.data;
  const s = data?.summary;
  const max = Math.max(1, ...(s?.monthly ?? []).flatMap((row) => [row.income, row.costs]));

  return (
    <div className="mx-auto max-w-[1200px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9">
      <PageHeader eyebrow="Workspace / Finance" title="Finance" description="Cash basis, in LKR, by the date money moved. Voided entries count nowhere."
        action={<div className="flex flex-wrap gap-2"><a href={`/api/finance/ledger.csv${month ? `?month=${month}` : ""}`} download className="webasi-button-secondary"><Download className="h-4 w-4" />Export CSV</a><button onClick={() => setSpending(true)} className="webasi-button-primary"><Plus className="h-4 w-4" />Company expense</button></div>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={() => setMonth(null)} aria-pressed={month === null} className={cn("rounded-full px-3 py-1.5 text-xs font-semibold", month === null ? "bg-[#2563FF] text-white" : "bg-white text-[#475569] ring-1 ring-[#E2E8F0]")}>All time</button>
        <input type="month" value={month ?? ""} onChange={(event) => setMonth(event.target.value || null)} aria-label="Month" className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs" />
        <button onClick={() => setMonth(thisMonth)} className="text-[11px] font-semibold text-[#2563FF]">This month</button>
      </div>

      {finance.error && <p className="mb-4 rounded-lg bg-[#FEF2F2] p-3 text-xs text-[#B91C1C]">{finance.error.message}</p>}
      {finance.isLoading && <p className="text-xs text-[#94A3B8]">Loading…</p>}
      {s && (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Income" value={formatLkr(s.income)} tone="good" />
            <Stat label="Project costs" value={formatLkr(s.projectCosts)} />
            <Stat label="Company costs" value={formatLkr(s.companyCosts)} />
            <Stat label="Company profit" value={formatLkr(s.companyProfit)} tone={s.companyProfit < 0 ? "bad" : "good"} />
          </div>
          <p className="-mt-2 text-[11px] text-[#94A3B8]">Company profit = income − project costs − company costs.</p>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`Outstanding receivables · ${formatLkr(s.receivables)}`}>
              {s.owing.length === 0 ? <Empty>Nobody owes you anything.</Empty> : (
                <ul className="divide-y divide-[#F1F5F9]">{s.owing.map((row) => <li key={row.jobId} className="flex items-center justify-between gap-3 py-2.5 text-xs"><Link href={`/jobs/${row.jobId}`} className="min-w-0 truncate font-semibold text-[#1D4ED8] hover:underline">{row.clientName}<span className="font-normal text-[#64748B]"> · {row.title}</span></Link><span className="shrink-0 font-bold text-[#B91C1C]">{formatLkr(row.outstanding)}</span></li>)}</ul>
              )}
              {s.renewalReceivables > 0 && <p className="mt-3 border-t border-[#F1F5F9] pt-3 text-xs text-[#475569]">Plus {formatLkr(s.renewalReceivables)} in renewal invoices not yet paid.</p>}
            </Card>

            <Card title="Monthly trend">
              {s.monthly.length === 0 ? <Empty>No entries yet.</Empty> : (
                <div className="flex h-40 items-end gap-2 overflow-x-auto pb-1" role="img" aria-label="Income and costs per month">
                  {s.monthly.slice(-12).map((row) => (
                    <div key={row.month} className="flex min-w-[34px] flex-1 flex-col items-center gap-1">
                      <div className="flex h-28 w-full items-end justify-center gap-0.5"><div title={`Income ${formatLkr(row.income)}`} className="w-3 rounded-t bg-[#22C55E]" style={{ height: `${(row.income / max) * 100}%` }} /><div title={`Costs ${formatLkr(row.costs)}`} className="w-3 rounded-t bg-[#F59E0B]" style={{ height: `${(row.costs / max) * 100}%` }} /></div>
                      <span className="text-[10px] text-[#94A3B8]">{row.month.slice(2)}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 flex gap-3 text-[10px] text-[#94A3B8]"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#22C55E]" />Income</span><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#F59E0B]" />Costs</span></p>
            </Card>
          </div>

          <Card title="By job">
            {s.perJob.length === 0 ? <Empty>No started jobs have money in this period.</Empty> : (
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead><tr className="text-[10px] uppercase tracking-[0.06em] text-[#94A3B8]"><th className="px-1 py-2">Job</th><th className="px-1 py-2 text-right">Price</th><th className="px-1 py-2 text-right">Received</th><th className="px-1 py-2 text-right">Outstanding</th><th className="px-1 py-2 text-right">Costs</th><th className="px-1 py-2 text-right">Profit</th></tr></thead>
                  <tbody>{s.perJob.map((row) => <tr key={row.jobId} className="border-t border-[#F1F5F9]"><td className="px-1 py-2"><Link href={`/jobs/${row.jobId}`} className="font-semibold text-[#1D4ED8] hover:underline">{row.clientName}</Link><span className="block text-[#94A3B8]">{row.title}</span></td><td className="px-1 py-2 text-right">{formatLkr(row.price)}</td><td className="px-1 py-2 text-right">{formatLkr(row.received)}</td><td className={cn("px-1 py-2 text-right", row.outstanding > 0 && "font-semibold text-[#B91C1C]")}>{formatLkr(row.outstanding)}</td><td className="px-1 py-2 text-right">{formatLkr(row.costs)}</td><td className={cn("px-1 py-2 text-right font-semibold", row.profit < 0 && "text-[#B91C1C]")}>{formatLkr(row.profit)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Ledger">
            {(data?.entries ?? []).length === 0 ? <Empty>No entries in this period.</Empty> : (
              <ul className="divide-y divide-[#F1F5F9]">
                {data!.entries.map((entry) => (
                  <li key={entry.id} className={cn("flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs", entry.voidedAt && "opacity-60")}>
                    <div className="min-w-0"><p className="font-semibold text-[#0F172A]"><span className={entry.type === "income" ? "text-[#15803D]" : "text-[#B91C1C]"}>{entry.type === "income" ? "+" : "−"}{formatLkr(entry.amount)}</span> · <span className="capitalize">{entry.category}</span>{entry.voidedAt && <span className="ml-2 rounded-full bg-[#FEF2F2] px-2 py-0.5 text-[10px] font-bold text-[#B91C1C]">VOID</span>}</p><p className="text-[#64748B]">{dayText(entry.entryDate)} · {entry.jobTitle ? <Link href={`/jobs/${entry.jobId}`} className="text-[#2563FF] hover:underline">{entry.jobTitle}</Link> : "Company"}{entry.note && <> · {entry.note}</>}{entry.voidedReason && <> · voided: {entry.voidedReason}</>}</p></div>
                    {!entry.voidedAt && <button onClick={() => setVoiding(entry.id)} className="webasi-button-secondary min-h-8 px-2.5 text-[#B91C1C]">Void</button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
      <CompanyExpenseModal open={spending} onClose={() => setSpending(false)} onDone={refresh} />
      <VoidModal id={voiding} onClose={() => setVoiding(null)} onDone={refresh} />
    </div>
  );
}

function CompanyExpenseModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const categories = trpc.ledger.categories.useQuery(undefined, { retry: false });
  const jobs = trpc.jobs.list.useQuery(undefined, { retry: false, enabled: open });
  const [form, setForm] = useState({ jobId: "", category: "internet", amount: "", entryDate: colomboDate(), method: "bank_transfer", note: "" });
  const [key, setKey] = useState(newKey());
  const record = trpc.ledger.recordExpense.useMutation({ onSuccess: () => { onDone(); onClose(); setKey(newKey()); setForm((current) => ({ ...current, amount: "", note: "" })); toast.success("Expense recorded"); }, onError: (error) => toast.error(error.message) });
  const set = (name: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [name]: event.target.value }));
  const started = (jobs.data ?? []).filter((job) => job.startedAt);
  return (
    <Modal open={open} onClose={onClose} title="Add an expense" description="Leave the job empty for a company expense: internet, subscriptions, ads, your own salary.">
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); record.mutate({ jobId: form.jobId || null, category: form.category, amount: Number(form.amount), entryDate: form.entryDate, method: form.method as never, note: form.note, idempotencyKey: key }); }}>
        <SelectInput label="Job" value={form.jobId} onChange={set("jobId")}><option value="">Company (no job)</option>{started.map((job) => <option key={job.id} value={job.id}>{job.clientName} · {job.title}</option>)}</SelectInput>
        <SelectInput label="Category" value={form.category} onChange={set("category")}>{(categories.data?.expense ?? ["internet"]).map((name) => <option key={name} value={name}>{name}</option>)}</SelectInput>
        <TextInput label="Amount (LKR)" type="number" min={0.01} step="0.01" inputMode="decimal" value={form.amount} onChange={set("amount")} required />
        <TextInput label="Date" type="date" value={form.entryDate} onChange={set("entryDate")} required />
        <SelectInput label="Method" value={form.method} onChange={set("method")}>{PAYMENT_METHODS.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</SelectInput>
        <TextInput label="Note" value={form.note} onChange={set("note")} maxLength={500} />
        <button type="submit" disabled={record.isPending || !(Number(form.amount) > 0)} className="webasi-button-primary"><Busy on={record.isPending}>Add expense</Busy></button>
      </form>
    </Modal>
  );
}
