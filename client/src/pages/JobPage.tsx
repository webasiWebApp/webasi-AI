import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/components/dashboard/shared";
import { ButtonRow, Busy, Card, Modal, Stat, StageBadge, TextArea, TextInput, SelectInput, dayText, formatLkr, newKey, notify, when } from "@/components/pipeline/kit";
import { DocumentsTab } from "@/pages/job/DocumentsTab";
import { MeetingsTab } from "@/pages/job/MeetingsTab";
import { MoneyTab } from "@/pages/job/MoneyTab";
import { RenewalsTab } from "@/pages/job/RenewalsTab";
import { TasksTab } from "@/pages/job/TasksTab";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { toast } from "sonner";
import { colomboDate } from "@shared/time";
import { PAYMENT_METHODS } from "@shared/finance";

const TABS = ["Overview", "Meetings", "Documents", "Tasks", "Money", "Renewals", "Notes"] as const;
type Tab = (typeof TABS)[number];
export type JobDetail = NonNullable<RouterOutputs["jobs"]["get"]>;

export default function JobPage() {
  const [, params] = useRoute("/jobs/:id");
  const id = params?.id ?? "";
  const job = trpc.jobs.get.useQuery({ id }, { enabled: Boolean(id), retry: false });
  // /jobs/<id>?tab=Money opens that tab, so a row elsewhere can link straight to it.
  const [tab, setTab] = useState<Tab>(() => { const wanted = new URLSearchParams(window.location.search).get("tab"); return (TABS as readonly string[]).includes(wanted ?? "") ? (wanted as Tab) : "Overview"; });

  if (job.isLoading) return <div className="p-8 text-xs text-[#94A3B8]">Loading…</div>;
  if (job.error || !job.data) return <div className="mx-auto max-w-xl p-6"><p className="rounded-lg bg-[#FEF2F2] p-3 text-xs text-[#B91C1C]">{job.error?.message ?? "That job does not exist."}</p><Link href="/pipeline" className="mt-3 inline-block text-xs font-semibold text-[#2563FF]">Back to the pipeline</Link></div>;
  const data = job.data;

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-14 pt-5 sm:px-6 lg:px-8 lg:pt-8">
      <Link href="/pipeline" className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#64748B] hover:text-[#0F172A]"><ArrowLeft className="h-3.5 w-3.5" />Pipeline</Link>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-[22px] font-bold tracking-[-0.03em] text-[#0F172A] sm:text-[26px]">{data.clientName}</h1><StageBadge stage={data.stage} /></div>
          <p className="mt-0.5 text-sm text-[#64748B]">{data.title}{data.clientPhone && <span className="text-[#94A3B8]"> · {data.clientPhone}</span>}</p>
        </div>
      </header>

      <nav aria-label="Job sections" className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-[#E2E8F0] px-4 sm:mx-0 sm:px-0">
        {TABS.map((name) => (
          <button key={name} onClick={() => setTab(name)} aria-current={tab === name ? "page" : undefined} className={cn("shrink-0 border-b-2 px-3 py-2.5 text-xs font-semibold transition", tab === name ? "border-[#2563FF] text-[#1D4ED8]" : "border-transparent text-[#64748B] hover:text-[#0F172A]")}>{name}</button>
        ))}
      </nav>

      {tab === "Overview" && <Overview job={data} goTo={setTab} />}
      {tab === "Meetings" && <MeetingsTab job={data} />}
      {tab === "Documents" && <DocumentsTab job={data} />}
      {tab === "Tasks" && <TasksTab job={data} />}
      {tab === "Money" && <MoneyTab job={data} />}
      {tab === "Renewals" && <RenewalsTab job={data} />}
      {tab === "Notes" && <Notes job={data} />}
    </div>
  );
}

function Overview({ job, goTo }: { job: JobDetail; goTo: (tab: Tab) => void }) {
  const utils = trpc.useUtils();
  const refresh = () => { utils.jobs.get.invalidate({ id: job.id }); utils.jobs.list.invalidate(); utils.tasks.list.invalidate(); utils.ledger.list.invalidate(); utils.renewals.list.invalidate(); utils.today.overview.invalidate(); };
  const done = (message: string) => ({ onSuccess: () => { refresh(); toast.success(message); }, onError: (error: { message: string }) => { refresh(); toast.error(error.message); } });
  const [starting, setStarting] = useState(false);
  const [losing, setLosing] = useState(false);
  const pending = trpc.jobs.pendingOrder.useQuery({ jobId: job.id }, { retry: false });
  const confirmOrder = trpc.orders.confirm.useMutation({ ...done("Deposit confirmed"), onSuccess: () => { pending.refetch(); toast.success("Deposit confirmed"); } });
  const delivered = trpc.jobs.markDelivered.useMutation({ onSuccess: (result) => { refresh(); toast.success("Marked as delivered", { description: result.warnings.join(" ") || "Renewals were created for hosting, domain and support." }); }, onError: (error) => { refresh(); toast.error(error.message); } });
  const close = trpc.jobs.close.useMutation(done("Job closed"));
  const reopen = trpc.jobs.reopen.useMutation(done("Job reopened"));
  const revoke = trpc.jobs.revokeApproval.useMutation(done("Approval revoked"));
  const update = trpc.jobs.update.useMutation(done("Saved"));
  const money = job.money;
  const started = ["active", "delivered", "closed"].includes(job.stage);
  const confirmMessage = (text: string, run: () => void) => { if (window.confirm(text)) run(); };

  return (
    <div className="grid gap-4">
      <Card title="Next step">
        <p className="mb-3 text-xs leading-5 text-[#475569]">{job.nextAction}.</p>
        <ButtonRow>
          {job.stage === "lead" && <><button onClick={() => goTo("Meetings")} className="webasi-button-primary">Book a meeting</button><button onClick={() => goTo("Documents")} className="webasi-button-secondary">Write a quotation</button></>}
          {job.stage === "meeting" && <button onClick={() => goTo("Documents")} className="webasi-button-primary">Write a quotation</button>}
          {job.stage === "quoted" && <button onClick={() => goTo("Documents")} className="webasi-button-primary">Open the quotations</button>}
          {job.stage === "approved" && <><button onClick={() => setStarting(true)} className="webasi-button-primary">Start project</button><button disabled={revoke.isPending} onClick={() => confirmMessage("Revoke the approval? The job goes back to quoted and the price and payment schedule are cleared.", () => revoke.mutate({ jobId: job.id }))} className="webasi-button-secondary"><Busy on={revoke.isPending}>Revoke approval</Busy></button></>}
          {job.stage === "active" && <button disabled={delivered.isPending} onClick={() => confirmMessage(job.unfinishedTasks ? `${job.unfinishedTasks} task${job.unfinishedTasks === 1 ? " is" : "s are"} not finished yet. Mark the job delivered anyway?` : "Mark this job delivered?", () => delivered.mutate({ jobId: job.id }))} className="webasi-button-primary"><Busy on={delivered.isPending}>Mark delivered</Busy></button>}
          {job.stage === "delivered" && <button disabled={close.isPending || money.outstanding > 0} onClick={() => close.mutate({ jobId: job.id })} className="webasi-button-primary" title={money.outstanding > 0 ? "The outstanding balance must be zero." : undefined}><Busy on={close.isPending}>Close job</Busy></button>}
          {job.stage === "lost" && <button disabled={reopen.isPending} onClick={() => reopen.mutate({ jobId: job.id })} className="webasi-button-primary"><Busy on={reopen.isPending}>Reopen at {job.lostFromStage}</Busy></button>}
          {["lead", "meeting", "quoted", "approved"].includes(job.stage) && <button onClick={() => setLosing(true)} className="webasi-button-secondary border-[#FECACA] text-[#B91C1C]">Mark lost</button>}
        </ButtonRow>
        {job.stage === "delivered" && money.outstanding > 0 && <p className="mt-2 text-[11px] text-[#C2410C]">{formatLkr(money.outstanding)} is still outstanding. Record the payment in Money, then close the job.</p>}
        {job.stage === "lost" && <p className="mt-2 text-[11px] text-[#64748B]">Lost from {job.lostFromStage}{job.lostReason ? `: ${job.lostReason}` : ""} · {when(job.lostAt)}</p>}
      </Card>

      {pending.data && (
        <Card title="Order waiting for your check">
          <p className="text-xs leading-5 text-[#475569]">WEBASI collected a payment slip in this client's chat for order <b>{pending.data.orderKey}</b> ({formatLkr(pending.data.depositAmount)}). Confirm it once you have checked the bank transfer.</p>
          <div className="mt-3"><button disabled={confirmOrder.isPending} onClick={() => confirmMessage("Confirm this deposit only after you have verified the bank transfer and slip?", () => confirmOrder.mutate({ orderKey: pending.data!.orderKey }))} className="webasi-button-secondary"><Busy on={confirmOrder.isPending}>Confirm the order's deposit</Busy></button></div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Price" value={job.priceTotal != null ? formatLkr(job.priceTotal) : "—"} />
        <Stat label={`Advance${job.advancePercent ? ` (${job.advancePercent}%)` : ""}`} value={job.requiredAdvance != null ? formatLkr(job.requiredAdvance) : "—"} />
        <Stat label="Received" value={formatLkr(money.received)} tone={started && money.received > 0 ? "good" : undefined} />
        <Stat label="Outstanding" value={started || job.priceTotal != null ? formatLkr(money.outstanding) : "—"} tone={money.outstanding > 0 && started ? "bad" : "good"} />
        <Stat label="Project costs" value={formatLkr(money.costs)} />
        <Stat label="Project profit" value={formatLkr(money.profit)} tone={money.profit < 0 ? "bad" : undefined} />
      </div>

      <Card title="Details">
        <DetailsForm job={job} save={(patch) => update.mutate({ id: job.id, ...patch })} saving={update.isPending} />
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
          <dt className="text-[#94A3B8]">Started</dt><dd>{when(job.startedAt)}</dd>
          <dt className="text-[#94A3B8]">Delivered</dt><dd>{when(job.deliveredAt)}</dd>
          <dt className="text-[#94A3B8]">Closed</dt><dd>{when(job.closedAt)}</dd>
          <dt className="text-[#94A3B8]">Tasks</dt><dd>{job.unfinishedTasks} unfinished</dd>
        </dl>
      </Card>

      <StartProjectModal job={job} open={starting} onClose={() => setStarting(false)} onDone={refresh} />
      <LostModal job={job} open={losing} onClose={() => setLosing(false)} onDone={refresh} />
    </div>
  );
}

function DetailsForm({ job, save, saving }: { job: JobDetail; save: (patch: { clientName: string; clientPhone: string; title: string; estimatedDeliveryDate: string | null }) => void; saving: boolean }) {
  const [form, setForm] = useState({ clientName: job.clientName, clientPhone: job.clientPhone, title: job.title, estimatedDeliveryDate: job.estimatedDeliveryDate ?? "" });
  useEffect(() => setForm({ clientName: job.clientName, clientPhone: job.clientPhone, title: job.title, estimatedDeliveryDate: job.estimatedDeliveryDate ?? "" }), [job.clientName, job.clientPhone, job.title, job.estimatedDeliveryDate]);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); save({ ...form, estimatedDeliveryDate: form.estimatedDeliveryDate || null }); }}>
      <TextInput label="Client" value={form.clientName} onChange={set("clientName")} required maxLength={180} />
      <TextInput label="Phone" value={form.clientPhone} onChange={set("clientPhone")} maxLength={40} />
      <TextInput label="Job" value={form.title} onChange={set("title")} required maxLength={180} />
      <TextInput label="Estimated delivery" type="date" value={form.estimatedDeliveryDate} onChange={set("estimatedDeliveryDate")} helper="Feeds the Today page. The quotation usually says 7 to 10 days." />
      <div className="sm:col-span-2"><button type="submit" disabled={saving} className="webasi-button-secondary"><Busy on={saving}>Save details</Busy></button></div>
    </form>
  );
}

function StartProjectModal({ job, open, onClose, onDone }: { job: JobDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const required = job.requiredAdvance ?? 0;
  const [form, setForm] = useState({ amount: String(required), method: "bank_transfer", entryDate: colomboDate(), note: "" });
  // One key per time the dialog is opened: a double click or a retry sends the same key, so it cannot pay twice.
  const [key, setKey] = useState(newKey());
  useEffect(() => { if (open) { setKey(newKey()); setForm({ amount: String(required), method: "bank_transfer", entryDate: colomboDate(), note: "" }); } }, [open, required]);
  const start = trpc.jobs.startProject.useMutation({ onSuccess: (result) => { onDone(); onClose(); toast.success(result.alreadyStarted ? "The project had already started" : "Project started", { description: result.alreadyStarted ? undefined : `Advance recorded and ${result.tasks} tasks created.` }); }, onError: (error) => { onDone(); toast.error(error.message); } });
  const amount = Number(form.amount);
  const tooLow = !Number.isFinite(amount) || Math.round(amount * 100) < Math.round(required * 100);
  return (
    <Modal open={open} onClose={onClose} title="Start project" description="Records the full agreed advance, creates the task list and starts the job. Partial advances are not supported.">
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); start.mutate({ jobId: job.id, amount, idempotencyKey: key, method: form.method as never, entryDate: form.entryDate, note: form.note }); }}>
        <TextInput label="Advance received (LKR)" type="number" inputMode="decimal" step="0.01" min={required} value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} required helper={`Required: ${formatLkr(required)} (${job.advancePercent}% of ${formatLkr(job.priceTotal)}). You can record more.`} />
        {tooLow && <p className="text-[11px] text-[#B91C1C]">The advance must be at least {formatLkr(required)}.</p>}
        <SelectInput label="Method" value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</SelectInput>
        <TextInput label="Date received" type="date" value={form.entryDate} onChange={(event) => setForm({ ...form, entryDate: event.target.value })} required />
        <TextInput label="Note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} maxLength={500} />
        <button type="submit" disabled={start.isPending || tooLow} className="webasi-button-primary"><Busy on={start.isPending}>Record advance and start</Busy></button>
      </form>
    </Modal>
  );
}

function LostModal({ job, open, onClose, onDone }: { job: JobDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const lost = trpc.jobs.markLost.useMutation({ onSuccess: () => { onDone(); onClose(); setReason(""); toast.success("Marked as lost"); }, onError: (error) => toast.error(error.message) });
  return (
    <Modal open={open} onClose={onClose} title="Mark as lost" description="You can reopen it later. A job that has started cannot be marked lost.">
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); lost.mutate({ jobId: job.id, reason }); }}>
        <TextArea label="Why" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} placeholder="Went with someone cheaper" />
        <button type="submit" disabled={lost.isPending} className="webasi-button-primary"><Busy on={lost.isPending}>Mark lost</Busy></button>
      </form>
    </Modal>
  );
}

function Notes({ job }: { job: JobDetail }) {
  const utils = trpc.useUtils();
  const [notes, setNotes] = useState(job.notes);
  useEffect(() => setNotes(job.notes), [job.notes]);
  const save = trpc.jobs.update.useMutation({ ...notify("Notes saved"), onSuccess: () => { utils.jobs.get.invalidate({ id: job.id }); toast.success("Notes saved"); } });
  return (
    <Card title="Notes">
      <TextArea label="Private notes about this client and job" value={notes} onChange={(event) => setNotes(event.target.value)} rows={10} maxLength={4000} />
      <div className="mt-3"><button onClick={() => save.mutate({ id: job.id, notes })} disabled={save.isPending || notes === job.notes} className="webasi-button-primary"><Busy on={save.isPending}>Save notes</Busy></button></div>
      <p className="mt-3 text-[11px] text-[#94A3B8]">Created {dayText(job.createdAt.slice(0, 10))}</p>
    </Card>
  );
}
