import { trpc } from "@/lib/trpc";
import { cn } from "@/components/dashboard/shared";
import { Busy, ButtonRow, Card, Empty, Modal, SelectInput, Stat, TextInput, dayText, formatLkr, newKey } from "@/components/pipeline/kit";
import type { JobDetail } from "@/pages/JobPage";
import { PAYMENT_METHODS } from "@shared/finance";
import { colomboDate } from "@shared/time";
import { Download, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function MoneyTab({ job }: { job: JobDetail }) {
  const utils = trpc.useUtils();
  const ledger = trpc.ledger.list.useQuery({ jobId: job.id, includeVoid: true }, { retry: false });
  const docs = trpc.documents.list.useQuery({ jobId: job.id }, { retry: false });
  const refresh = () => { utils.ledger.list.invalidate(); utils.documents.list.invalidate({ jobId: job.id }); utils.jobs.get.invalidate({ id: job.id }); utils.jobs.list.invalidate(); utils.finance.overview.invalidate(); utils.today.overview.invalidate(); };
  const [paying, setPaying] = useState(false);
  const [spending, setSpending] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const receipt = trpc.documents.createReceipt.useMutation({ onSuccess: (doc) => { refresh(); toast.success(`Receipt ${doc.number} ready`); window.location.assign(`/api/documents/${doc.id}/pdf`); }, onError: (error) => toast.error(error.message) });
  const invoice = trpc.documents.createInvoice.useMutation({ onSuccess: (doc) => { refresh(); toast.success(`Invoice ${doc.number} created`, { description: "Download it from Documents." }); }, onError: (error) => toast.error(error.message) });
  const m = job.money;
  const started = ["active", "delivered", "closed"].includes(job.stage);
  const entries = ledger.data ?? [];
  const receiptFor = new Map((docs.data ?? []).filter((doc) => doc.kind === "receipt").map((doc) => [doc.ledgerEntryId, doc]));

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Price" value={job.priceTotal != null ? formatLkr(job.priceTotal) : "—"} />
        <Stat label="Advance due" value={job.requiredAdvance != null ? formatLkr(job.requiredAdvance) : "—"} />
        <Stat label="Received" value={formatLkr(m.received)} tone={m.received > 0 ? "good" : undefined} />
        <Stat label="Outstanding" value={formatLkr(m.outstanding)} tone={started && m.outstanding > 0 ? "bad" : undefined} />
        <Stat label="Project costs" value={formatLkr(m.costs)} />
        <Stat label="Project profit" value={formatLkr(m.profit)} tone={m.profit < 0 ? "bad" : undefined} />
      </div>
      {m.overpaid > 0 && <p className="rounded-lg bg-[#FFF7ED] p-3 text-xs text-[#9A3412]">Overpaid by {formatLkr(m.overpaid)}.</p>}

      <Card title="Payments and costs">
        {!started && <p className="mb-3 rounded-lg bg-[#F1F5F9] p-3 text-xs leading-5 text-[#475569]">Money can only be recorded once the project has started. {job.stage === "approved" ? "Use Start project on the Overview tab to record the advance." : "Approve a quotation first."}</p>}
        <ButtonRow>
          <button disabled={!started} onClick={() => setPaying(true)} className="webasi-button-primary"><Plus className="h-3.5 w-3.5" />Record payment</button>
          <button disabled={!started} onClick={() => setSpending(true)} className="webasi-button-secondary"><Plus className="h-3.5 w-3.5" />Add expense</button>
          <button disabled={!started || invoice.isPending || m.outstanding <= 0} onClick={() => invoice.mutate({ jobId: job.id, basis: "balance" })} className="webasi-button-secondary"><Busy on={invoice.isPending}>Invoice the balance</Busy></button>
        </ButtonRow>
        {ledger.isLoading ? <p className="mt-3 text-xs text-[#94A3B8]">Loading…</p> : entries.length === 0 ? <div className="mt-3"><Empty>Nothing recorded yet.</Empty></div> : (
          <ul className="mt-3 divide-y divide-[#F1F5F9]">
            {entries.map((entry) => {
              const existing = receiptFor.get(entry.id);
              return (
                <li key={entry.id} className={cn("py-3 text-xs", entry.voidedAt && "opacity-60")}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-[#0F172A]"><span className={entry.type === "income" ? "text-[#15803D]" : "text-[#B91C1C]"}>{entry.type === "income" ? "+" : "−"}{formatLkr(entry.amount)}</span> · <span className="capitalize">{entry.category}</span>{entry.voidedAt && <span className="ml-2 rounded-full bg-[#FEF2F2] px-2 py-0.5 text-[10px] font-bold text-[#B91C1C]">VOID</span>}</p>
                      <p className="text-[#64748B]">{dayText(entry.entryDate)} · {entry.method.replace("_", " ")}{entry.note && <> · {entry.note}</>}</p>
                      {entry.voidedReason && <p className="text-[#B91C1C]">Voided: {entry.voidedReason}</p>}
                    </div>
                    {!entry.voidedAt && (
                      <div className="flex flex-wrap gap-2">
                        {entry.type === "income" && (existing
                          ? <a href={`/api/documents/${existing.id}/pdf`} download className="webasi-button-secondary min-h-8 px-2.5"><Download className="h-3.5 w-3.5" />Receipt {existing.number}</a>
                          : <button onClick={() => receipt.mutate({ ledgerEntryId: entry.id })} disabled={receipt.isPending} className="webasi-button-secondary min-h-8 px-2.5">Make receipt</button>)}
                        <button onClick={() => setVoiding(entry.id)} className="webasi-button-secondary min-h-8 px-2.5 text-[#B91C1C]">Void</button>
                      </div>
                    )}
                  </div>
                  {entry.voidedAt && existing && <a href={`/api/documents/${existing.id}/pdf`} download className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[#2563FF]"><Download className="h-3 w-3" />Receipt {existing.number} (void)</a>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <PaymentModal job={job} open={paying} onClose={() => setPaying(false)} onDone={refresh} invoices={(docs.data ?? []).filter((doc) => ["invoice", "renewal_invoice"].includes(doc.kind) && doc.status !== "void")} />
      <ExpenseModal job={job} open={spending} onClose={() => setSpending(false)} onDone={refresh} />
      <VoidModal id={voiding} onClose={() => setVoiding(null)} onDone={refresh} />
    </div>
  );
}

function PaymentModal({ job, open, onClose, onDone, invoices }: { job: JobDetail; open: boolean; onClose: () => void; onDone: () => void; invoices: Array<{ id: string; number: string; kind: string; payload: Record<string, any> }> }) {
  const [form, setForm] = useState({ category: "final", amount: "", entryDate: colomboDate(), method: "bank_transfer", note: "", invoiceDocumentId: "", receipt: true });
  const [key, setKey] = useState(newKey());
  const record = trpc.ledger.recordPayment.useMutation({
    onSuccess: async (entry) => {
      onDone(); onClose(); setKey(newKey());
      toast.success("Payment recorded");
      if (form.receipt) { try { await utils.client.documents.createReceipt.mutate({ ledgerEntryId: entry.id }).then((doc) => window.location.assign(`/api/documents/${doc.id}/pdf`)); onDone(); } catch (error) { toast.error((error as Error).message); } }
      setForm((current) => ({ ...current, amount: "", note: "", invoiceDocumentId: "" }));
    },
    onError: (error) => toast.error(error.message),
  });
  const utils = trpc.useUtils();
  const set = (name: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [name]: event.target.value }));
  return (
    <Modal open={open} onClose={onClose} title="Record payment" description="Money that arrived. The balance reads advance and final payments; extra work and renewals are on top.">
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); record.mutate({ jobId: job.id, category: form.category as never, amount: Number(form.amount), entryDate: form.entryDate, method: form.method as never, note: form.note, invoiceDocumentId: form.invoiceDocumentId || undefined, idempotencyKey: key }); }}>
        <SelectInput label="What for" value={form.category} onChange={set("category")}><option value="advance">Advance</option><option value="final">Final payment</option><option value="extra">Extra work</option><option value="renewal">Renewal</option></SelectInput>
        <TextInput label="Amount (LKR)" type="number" min={0.01} step="0.01" inputMode="decimal" value={form.amount} onChange={set("amount")} required helper={job.money.outstanding > 0 ? `Outstanding: ${formatLkr(job.money.outstanding)}` : undefined} />
        <TextInput label="Date received" type="date" value={form.entryDate} onChange={set("entryDate")} required />
        <SelectInput label="Method" value={form.method} onChange={set("method")}>{PAYMENT_METHODS.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</SelectInput>
        {invoices.length > 0 && <SelectInput label="Settles invoice (optional)" value={form.invoiceDocumentId} onChange={set("invoiceDocumentId")} helper="Informational only. It changes no totals."><option value="">None</option>{invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · {formatLkr(invoice.payload.total)}</option>)}</SelectInput>}
        <TextInput label="Note" value={form.note} onChange={set("note")} maxLength={500} />
        <label className="flex items-center gap-2 text-xs text-[#475569]"><input type="checkbox" checked={form.receipt} onChange={(event) => setForm({ ...form, receipt: event.target.checked })} className="h-4 w-4" />Make the receipt PDF now</label>
        <button type="submit" disabled={record.isPending || !(Number(form.amount) > 0)} className="webasi-button-primary"><Busy on={record.isPending}>Record payment</Busy></button>
      </form>
    </Modal>
  );
}

function ExpenseModal({ job, open, onClose, onDone }: { job: JobDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const categories = trpc.ledger.categories.useQuery(undefined, { retry: false });
  const [form, setForm] = useState({ category: "hosting", amount: "", entryDate: colomboDate(), method: "bank_transfer", note: "" });
  const [key, setKey] = useState(newKey());
  const record = trpc.ledger.recordExpense.useMutation({ onSuccess: () => { onDone(); onClose(); setKey(newKey()); setForm((current) => ({ ...current, amount: "", note: "" })); toast.success("Expense recorded"); }, onError: (error) => toast.error(error.message) });
  const set = (name: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [name]: event.target.value }));
  return (
    <Modal open={open} onClose={onClose} title="Add a project expense" description={`A cost of this job (${job.title}). Company expenses with no job are added on the Finance page.`}>
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); record.mutate({ jobId: job.id, category: form.category, amount: Number(form.amount), entryDate: form.entryDate, method: form.method as never, note: form.note, idempotencyKey: key }); }}>
        <SelectInput label="Category" value={form.category} onChange={set("category")}>{(categories.data?.expense ?? ["hosting", "domain", "software", "freelancer", "ads", "internet", "salary", "other"]).map((name) => <option key={name} value={name}>{name}</option>)}</SelectInput>
        <TextInput label="Amount (LKR)" type="number" min={0.01} step="0.01" inputMode="decimal" value={form.amount} onChange={set("amount")} required />
        <TextInput label="Date" type="date" value={form.entryDate} onChange={set("entryDate")} required />
        <SelectInput label="Method" value={form.method} onChange={set("method")}>{PAYMENT_METHODS.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</SelectInput>
        <TextInput label="Note" value={form.note} onChange={set("note")} maxLength={500} />
        <button type="submit" disabled={record.isPending || !(Number(form.amount) > 0)} className="webasi-button-primary"><Busy on={record.isPending}>Add expense</Busy></button>
      </form>
    </Modal>
  );
}

export function VoidModal({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const voided = trpc.ledger.void.useMutation({ onSuccess: () => { onDone(); onClose(); setReason(""); toast.success("Entry voided", { description: "It stays on file, out of every total. Its receipt is stamped void." }); }, onError: (error) => toast.error(error.message) });
  return (
    <Modal open={Boolean(id)} onClose={onClose} title="Void this entry" description="Entries are never deleted. A voided one stays visible and counts nowhere. Record the correct entry afterwards if needed.">
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); if (id) voided.mutate({ id, reason }); }}>
        <TextInput label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} maxLength={500} placeholder="Typed the wrong amount" />
        <button type="submit" disabled={voided.isPending || reason.trim().length < 3} className="webasi-button-primary"><Busy on={voided.isPending}>Void entry</Busy></button>
      </form>
    </Modal>
  );
}
