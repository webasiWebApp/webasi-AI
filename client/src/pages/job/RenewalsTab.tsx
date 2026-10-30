import { trpc } from "@/lib/trpc";
import { Busy, Card, Empty, Modal, SelectInput, TextInput, dayText, formatLkr } from "@/components/pipeline/kit";
import { cn } from "@/components/dashboard/shared";
import type { JobDetail } from "@/pages/JobPage";
import { colomboDate } from "@shared/time";
import { Download, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const tone: Record<string, string> = { upcoming: "bg-[#EFF6FF] text-[#1D4ED8]", invoiced: "bg-[#FFF7ED] text-[#C2410C]", paid: "bg-[#F0FDF4] text-[#15803D]", skipped: "bg-[#F1F5F9] text-[#64748B]" };

// Hosting, domain and support come due a year after delivery. Each can be edited, skipped, invoiced and marked paid.
export function RenewalsTab({ job }: { job: JobDetail }) {
  const utils = trpc.useUtils();
  const renewals = trpc.renewals.list.useQuery({ jobId: job.id }, { retry: false });
  const refresh = () => { utils.renewals.list.invalidate(); utils.documents.list.invalidate({ jobId: job.id }); utils.ledger.list.invalidate(); utils.jobs.get.invalidate({ id: job.id }); utils.finance.overview.invalidate(); utils.today.overview.invalidate(); };
  const fail = (error: { message: string }) => toast.error(error.message);
  const update = trpc.renewals.update.useMutation({ onSuccess: refresh, onError: fail });
  const invoice = trpc.renewals.createInvoice.useMutation({ onSuccess: (doc) => { refresh(); toast.success(`Renewal invoice ${doc.number} created`); window.location.assign(`/api/documents/${doc.id}/pdf`); }, onError: fail });
  const pay = trpc.renewals.recordPayment.useMutation({ onSuccess: () => { refresh(); toast.success("Renewal payment recorded"); }, onError: fail });
  const [adding, setAdding] = useState(false);
  const rows = renewals.data ?? [];
  const delivered = ["delivered", "closed"].includes(job.stage);

  return (
    <Card title="Renewals" action={delivered && <button onClick={() => setAdding(true)} className="webasi-button-secondary min-h-9"><Plus className="h-3.5 w-3.5" />Add renewal</button>}>
      {!delivered && <Empty>Renewals are created when the job is marked delivered.</Empty>}
      {delivered && rows.length === 0 && <Empty>No renewals.</Empty>}
      <ul className="divide-y divide-[#F1F5F9]">
        {rows.map((renewal) => (
          <li key={renewal.id} className="py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold capitalize text-[#0F172A]">{renewal.kind}<span className="ml-2 font-normal normal-case text-[#64748B]">due {dayText(renewal.dueDate)}</span></p>
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold capitalize", tone[renewal.status])}>{renewal.status}</span>
            </div>
            {["upcoming", "invoiced"].includes(renewal.status) && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="block"><span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.08em] text-[#64748B]">Amount (LKR)</span><input type="number" min={0} step="0.01" defaultValue={renewal.amount} key={`${renewal.id}-${renewal.amount}`} onBlur={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value !== renewal.amount) update.mutate({ id: renewal.id, amount: value }); }} className="w-32 rounded-lg border border-[#E2E8F0] px-2 py-1.5 text-xs" /></label>
                <label className="block"><span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.08em] text-[#64748B]">Due</span><input type="date" defaultValue={renewal.dueDate} key={`${renewal.id}-${renewal.dueDate}`} onBlur={(event) => { if (event.target.value && event.target.value !== renewal.dueDate) update.mutate({ id: renewal.id, dueDate: event.target.value }); }} className="rounded-lg border border-[#E2E8F0] px-2 py-1.5 text-xs" /></label>
                <button onClick={() => invoice.mutate({ id: renewal.id })} disabled={invoice.isPending || renewal.amount <= 0} className="webasi-button-secondary min-h-8 px-2.5" title={renewal.amount <= 0 ? "Set the amount first." : undefined}><Busy on={invoice.isPending}>{renewal.status === "invoiced" ? "New invoice" : "Generate invoice"}</Busy></button>
                <button onClick={() => { if (window.confirm(`Record ${formatLkr(renewal.amount)} as received for this renewal?`)) pay.mutate({ id: renewal.id }); }} disabled={pay.isPending || renewal.amount <= 0} className="webasi-button-primary min-h-8 px-2.5">Record payment</button>
                <button onClick={() => { if (window.confirm("Skip this renewal? It leaves the reminders and the lists.")) update.mutate({ id: renewal.id, skip: true }); }} className="webasi-button-secondary min-h-8 px-2.5">Skip</button>
                {renewal.invoiceDocumentId && <a href={`/api/documents/${renewal.invoiceDocumentId}/pdf`} download className="webasi-button-secondary min-h-8 px-2.5"><Download className="h-3.5 w-3.5" />Invoice</a>}
              </div>
            )}
            {renewal.status === "paid" && renewal.invoiceDocumentId && <a href={`/api/documents/${renewal.invoiceDocumentId}/pdf`} download className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[#2563FF]"><Download className="h-3 w-3" />Invoice</a>}
          </li>
        ))}
      </ul>
      <AddRenewal job={job} open={adding} onClose={() => setAdding(false)} onDone={refresh} />
    </Card>
  );
}

function AddRenewal({ job, open, onClose, onDone }: { job: JobDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ kind: "hosting", dueDate: colomboDate(), amount: "" });
  const add = trpc.renewals.add.useMutation({ onSuccess: () => { onDone(); onClose(); toast.success("Renewal added"); }, onError: (error) => toast.error(error.message) });
  return (
    <Modal open={open} onClose={onClose} title="Add a renewal">
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); add.mutate({ jobId: job.id, kind: form.kind as never, dueDate: form.dueDate, amount: Number(form.amount) || 0 }); }}>
        <SelectInput label="Kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}><option value="hosting">Hosting</option><option value="domain">Domain</option><option value="support">Support</option></SelectInput>
        <TextInput label="Due" type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} required />
        <TextInput label="Amount (LKR)" type="number" min={0} step="0.01" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
        <button type="submit" disabled={add.isPending} className="webasi-button-primary"><Busy on={add.isPending}>Add</Busy></button>
      </form>
    </Modal>
  );
}
