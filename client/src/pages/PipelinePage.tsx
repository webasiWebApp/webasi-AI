import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/components/dashboard/shared";
import { Busy, Empty, Modal, StageBadge, TextInput, dayText, formatLkr, notify } from "@/components/pipeline/kit";
import { JOB_STAGES, STAGE_LABELS, type JobStage } from "@shared/jobs";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";

const COLUMNS = JOB_STAGES;

export function NewJobModal({ open, onClose, conversationClientId }: { open: boolean; onClose: () => void; conversationClientId?: string | null }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [form, setForm] = useState({ clientName: "", clientPhone: "", title: "" });
  const draft = trpc.jobs.draftFromConversation.useQuery({ clientId: conversationClientId ?? "" }, { enabled: open && Boolean(conversationClientId), retry: false });
  useEffect(() => { if (draft.data) setForm((current) => ({ ...current, clientName: draft.data.clientName, clientPhone: draft.data.clientPhone })); }, [draft.data]);
  const create = trpc.jobs.create.useMutation({
    ...notify("Job created"),
    onSuccess: (job) => { utils.jobs.list.invalidate(); onClose(); setForm({ clientName: "", clientPhone: "", title: "" }); setLocation(`/jobs/${job.id}`); },
    onError: (error) => notify().onError(error),
  });
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return (
    <Modal open={open} onClose={onClose} title="New job" description={conversationClientId ? "Name and number come from the conversation. Add what the job is about." : "A job is one client's whole engagement, from the first chat to the close."}>
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); create.mutate({ ...form, conversationClientId: conversationClientId ?? null }); }}>
        <TextInput label="Client name" value={form.clientName} onChange={set("clientName")} required maxLength={180} autoFocus />
        <TextInput label="Phone" value={form.clientPhone} onChange={set("clientPhone")} maxLength={40} placeholder="+94 77 000 0000" />
        <TextInput label="What is the job" value={form.title} onChange={set("title")} required maxLength={180} placeholder="Company website" />
        <button type="submit" disabled={create.isPending || !form.clientName.trim() || !form.title.trim()} className="webasi-button-primary mt-1"><Busy on={create.isPending}>Create job</Busy></button>
      </form>
    </Modal>
  );
}

// One column per stage. No dragging: a job moves through the gated buttons on its own page.
export default function PipelinePage() {
  const jobs = trpc.jobs.list.useQuery(undefined, { refetchInterval: 30_000, retry: false });
  const [creating, setCreating] = useState(false);
  const [conversationClientId, setConversationClientId] = useState<string | null>(null);
  // "Create job" on a conversation lands here as /pipeline?new=<client id>.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("new");
    if (id) { setConversationClientId(id); setCreating(true); window.history.replaceState(null, "", "/pipeline"); }
  }, []);
  const byStage = (stage: JobStage) => (jobs.data ?? []).filter((job) => job.stage === stage);
  const open = (jobs.data ?? []).filter((job) => !["closed", "lost"].includes(job.stage)).length;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9">
      <PageHeader eyebrow="Workspace / Pipeline" title="Pipeline" description={`${open} open job${open === 1 ? "" : "s"}. Open a job to move it forward.`}
        action={<button onClick={() => { setConversationClientId(null); setCreating(true); }} className="webasi-button-primary"><Plus className="h-4 w-4" />Create job</button>} />
      {jobs.error && <p className="mb-4 rounded-lg bg-[#FEF2F2] p-3 text-xs text-[#B91C1C]">{jobs.error.message}</p>}
      {jobs.isLoading ? <p className="text-xs text-[#94A3B8]">Loading…</p> : (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0">
          {COLUMNS.map((stage) => {
            const cards = byStage(stage);
            return (
              <section key={stage} aria-label={STAGE_LABELS[stage]} className="w-[270px] shrink-0 snap-start rounded-2xl bg-[#F1F5F9] p-2.5">
                <header className="mb-2 flex items-center justify-between px-1.5 pt-1"><StageBadge stage={stage} /><span className="text-[11px] font-bold text-[#94A3B8]">{cards.length}</span></header>
                <div className="grid gap-2">
                  {cards.length === 0 && <Empty>None</Empty>}
                  {cards.map((job) => (
                    <Link key={job.id} href={`/jobs/${job.id}`} className="block rounded-xl border border-[#E2E8F0] bg-white p-3 text-xs shadow-[0_6px_16px_-14px_rgba(15,23,42,0.4)] transition hover:border-[#93C5FD]">
                      <p className="font-bold text-[#0F172A]">{job.clientName}</p>
                      <p className="mt-0.5 text-[#64748B]">{job.title}</p>
                      {job.priceTotal != null && (
                        <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
                          <dt className="text-[#94A3B8]">Price</dt><dd className="text-right font-semibold text-[#1E293B]">{formatLkr(job.priceTotal)}</dd>
                          {job.startedAt && <><dt className="text-[#94A3B8]">Owes</dt><dd className={job.money.outstanding > 0 ? "text-right font-semibold text-[#B91C1C]" : "text-right font-semibold text-[#15803D]"}>{formatLkr(job.money.outstanding)}</dd></>}
                        </dl>
                      )}
                      {job.estimatedDeliveryDate && !["closed", "lost"].includes(job.stage) && <p className="mt-1 text-[11px] text-[#94A3B8]">Due {dayText(job.estimatedDeliveryDate)}</p>}
                      <p className="mt-2 border-t border-[#F1F5F9] pt-2 text-[11px] leading-4 text-[#2563FF]">{job.nextAction}</p>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <NewJobModal open={creating} onClose={() => setCreating(false)} conversationClientId={conversationClientId} />
    </div>
  );
}
