import { trpc, type RouterOutputs } from "@/lib/trpc";
import { usePipelineSettings } from "@/hooks/usePipelineSettings";
import { cn } from "@/components/dashboard/shared";
import { Busy, ButtonRow, Card, Empty, Field, Modal, SelectInput, TextArea, TextInput, dayText, formatLkr, notify, when } from "@/components/pipeline/kit";
import type { JobDetail } from "@/pages/JobPage";
import { DEFAULT_DOCUMENT_SETTINGS, KIND_LABELS, quotationTotals, paymentScheduleText, type DocumentKind } from "@shared/documents";
import { colomboDate, addDays } from "@shared/time";
import { Download, FileText, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Doc = RouterOutputs["documents"]["list"][number];
const statusTone: Record<string, string> = { draft: "bg-[#F1F5F9] text-[#475569]", sent: "bg-[#EFF6FF] text-[#1D4ED8]", approved: "bg-[#F0FDF4] text-[#15803D]", superseded: "bg-[#FFF7ED] text-[#C2410C]", rejected: "bg-[#FEF2F2] text-[#B91C1C]", void: "bg-[#FEF2F2] text-[#B91C1C]" };

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const labelled = (text: string) => lines(text).map((line) => { const at = line.indexOf(":"); return at < 0 ? { label: line, text: "" } : { label: line.slice(0, at).trim(), text: line.slice(at + 1).trim() }; });
const unlabel = (rows: Array<{ label: string; text: string }>) => rows.map((row) => (row.text ? `${row.label}: ${row.text}` : row.label)).join("\n");

export function DocumentsTab({ job }: { job: JobDetail }) {
  const utils = trpc.useUtils();
  const docs = trpc.documents.list.useQuery({ jobId: job.id }, { retry: false });
  const refresh = () => { utils.documents.list.invalidate({ jobId: job.id }); utils.jobs.get.invalidate({ id: job.id }); utils.jobs.list.invalidate(); utils.today.overview.invalidate(); };
  const [form, setForm] = useState<null | { kind: "quotation" | "contract" | "technical_doc" | "design_doc"; doc?: Doc }>(null);
  const [credentials, setCredentials] = useState(false);
  // A refusal usually means the page was out of date, so it is reloaded along with the message.
  const act = { onSuccess: refresh, onError: (error: { message: string }) => { refresh(); toast.error(error.message); } };
  const markSent = trpc.documents.markSent.useMutation({ ...act, onSuccess: () => { refresh(); toast.success("Marked as sent"); } });
  const approve = trpc.jobs.approveQuotation.useMutation({ ...act, onSuccess: () => { refresh(); toast.success("Quotation approved", { description: "The price and payment schedule now come from it." }); } });
  const reject = trpc.documents.rejectQuotation.useMutation({ ...act, onSuccess: () => { refresh(); toast.success("Marked as rejected"); } });
  const duplicate = trpc.documents.duplicateQuotation.useMutation({ ...act, onSuccess: () => { refresh(); toast.success("New draft created"); } });
  const voidDoc = trpc.documents.void.useMutation({ ...act, onSuccess: () => { refresh(); toast.success("Document voided"); } });
  const invoice = trpc.documents.createInvoice.useMutation({ ...act, onSuccess: (doc) => { refresh(); toast.success(`Invoice ${doc.number} created`); } });
  const rows = docs.data ?? [];
  const canQuote = ["lead", "meeting", "quoted"].includes(job.stage);
  const hasContractStage = ["approved", "active", "delivered", "closed"].includes(job.stage);
  const started = ["active", "delivered", "closed"].includes(job.stage);

  return (
    <div className="grid gap-4">
      <Card title="Create a document">
        <ButtonRow>
          <button disabled={!canQuote} onClick={() => setForm({ kind: "quotation" })} className="webasi-button-primary" title={canQuote ? undefined : "A quotation can only be written before the job is approved. Revoke the approval to change it."}><Plus className="h-3.5 w-3.5" />Quotation</button>
          <button disabled={!hasContractStage} onClick={() => setForm({ kind: "contract" })} className="webasi-button-secondary" title={hasContractStage ? undefined : "Needs an approved quotation."}>Proposal &amp; contract pack</button>
          <button disabled={!hasContractStage || invoice.isPending} onClick={() => invoice.mutate({ jobId: job.id, basis: "advance" })} className="webasi-button-secondary" title={hasContractStage ? "Asks for the agreed advance. Creates no payment." : "Needs an approved quotation."}>Invoice: advance</button>
          <button disabled={!started || invoice.isPending} onClick={() => invoice.mutate({ jobId: job.id, basis: "balance" })} className="webasi-button-secondary" title="Asks for what is still outstanding. Creates no payment.">Invoice: balance</button>
          <button onClick={() => setForm({ kind: "technical_doc" })} disabled={!started} className="webasi-button-secondary">Technical docs</button>
          <button onClick={() => setForm({ kind: "design_doc" })} disabled={!started} className="webasi-button-secondary">Design docs</button>
          <button onClick={() => setCredentials(true)} disabled={!started} className="webasi-button-secondary">Credentials PDF</button>
        </ButtonRow>
        <p className="mt-3 text-[11px] leading-4 text-[#94A3B8]">You download each PDF and send it yourself on WhatsApp. Receipts are made from the Money tab, from a payment that was really received.</p>
      </Card>

      <Card title="Documents">
        {docs.isLoading ? <p className="text-xs text-[#94A3B8]">Loading…</p> : rows.length === 0 ? <Empty>No documents yet.</Empty> : (
          <ul className="divide-y divide-[#F1F5F9]">
            {rows.map((doc) => {
              const kind = doc.kind as DocumentKind;
              const editable = ["draft", "sent"].includes(doc.status) && ["quotation", "contract", "technical_doc", "design_doc"].includes(kind);
              return (
                <li key={doc.id} className="py-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-[#0F172A]"><FileText className="h-3.5 w-3.5 text-[#94A3B8]" />{KIND_LABELS[kind]} · {doc.number}<span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold capitalize", statusTone[doc.status])}>{doc.status}</span></p>
                      <p className="mt-0.5 text-[#64748B]">
                        {kind === "quotation" && <>{formatLkr(doc.payload.total)} · {doc.payload.advancePercent}% advance · </>}
                        {(kind === "invoice" || kind === "renewal_invoice") && <>{formatLkr(doc.payload.total)} · due {dayText(doc.payload.dueDate)} · </>}
                        {kind === "receipt" && <>{formatLkr(doc.payload.amount)} · {dayText(doc.payload.date)} · </>}
                        {doc.sentAt ? `Sent ${when(doc.sentAt)}` : `Created ${when(doc.createdAt)}`}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a href={`/api/documents/${doc.id}/pdf`} download className="webasi-button-secondary min-h-8 px-2.5"><Download className="h-3.5 w-3.5" />Download PDF</a>
                    {editable && <button onClick={() => setForm({ kind: kind as never, doc })} className="webasi-button-secondary min-h-8 px-2.5">Edit</button>}
                    {doc.status === "draft" && kind !== "quotation" || (kind === "quotation" && doc.status === "draft") ? <button onClick={() => markSent.mutate({ id: doc.id })} disabled={markSent.isPending} className="webasi-button-secondary min-h-8 px-2.5">Mark as sent</button> : null}
                    {doc.status === "sent" && <button onClick={() => { if (window.confirm("Mark as sent again? This restarts the reminder clock and remembers the earlier date.")) markSent.mutate({ id: doc.id, again: true }); }} disabled={markSent.isPending} className="webasi-button-secondary min-h-8 px-2.5">Mark as sent again</button>}
                    {kind === "quotation" && doc.status === "sent" && job.stage === "quoted" && <button onClick={() => { if (window.confirm("The client said yes to this quotation? It will set the price and payment schedule, and replace the job's other quotations.")) approve.mutate({ quotationId: doc.id }); }} disabled={approve.isPending} className="webasi-button-primary min-h-8 px-2.5"><Busy on={approve.isPending}>Client approved</Busy></button>}
                    {kind === "quotation" && ["draft", "sent"].includes(doc.status) && <button onClick={() => { if (window.confirm("Mark this quotation as rejected?")) reject.mutate({ id: doc.id }); }} className="webasi-button-secondary min-h-8 px-2.5">Rejected</button>}
                    {kind === "quotation" && canQuote && <button onClick={() => duplicate.mutate({ id: doc.id })} disabled={duplicate.isPending} className="webasi-button-secondary min-h-8 px-2.5">Duplicate as new</button>}
                    {["invoice", "renewal_invoice", "contract", "technical_doc", "design_doc"].includes(kind) && doc.status !== "void" && <button onClick={() => { if (window.confirm("Void this document? It stays on file, stamped void.")) voidDoc.mutate({ id: doc.id }); }} className="webasi-button-secondary min-h-8 px-2.5 text-[#B91C1C]">Void</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {form?.kind === "quotation" && <QuotationForm job={job} doc={form.doc} onClose={() => setForm(null)} onSaved={refresh} />}
      {form?.kind === "contract" && <ContractForm job={job} doc={form.doc} onClose={() => setForm(null)} onSaved={refresh} />}
      {form?.kind === "technical_doc" && <TechnicalForm job={job} doc={form.doc} onClose={() => setForm(null)} onSaved={refresh} />}
      {form?.kind === "design_doc" && <DesignForm job={job} doc={form.doc} onClose={() => setForm(null)} onSaved={refresh} />}
      <CredentialsModal job={job} open={credentials} onClose={() => setCredentials(false)} />
    </div>
  );
}

type FormProps = { job: JobDetail; doc?: Doc; onClose: () => void; onSaved: () => void };

// ----- Quotation -----------------------------------------------------------------------------------------------------
function QuotationForm({ job, doc, onClose, onSaved }: FormProps) {
  const settings = usePipelineSettings();
  const defaults = settings.data?.documentSettings ?? DEFAULT_DOCUMENT_SETTINGS;
  const p = doc?.payload as any | undefined;
  const [form, setForm] = useState(() => ({
    clientName: p?.clientName ?? "", projectName: p?.projectName ?? "", intro: p?.intro ?? "", advancePercent: String(p?.advancePercent ?? 40), date: p?.date ?? colomboDate(), dueDate: p?.dueDate ?? "",
    items: (p?.items ?? [{ description: "", bullets: [], cost: 0 }]).map((item: any) => ({ description: item.description, bullets: (item.bullets ?? []).join("\n"), cost: String(item.cost) })) as Array<{ description: string; bullets: string; cost: string }>,
    infrastructure: p ? unlabel(p.infrastructure) : "", afterService: p ? p.afterService.join("\n") : "", timelineDuration: p?.timelineDuration ?? "", milestones: p ? unlabel(p.milestones) : "", portfolioMain: p?.portfolioMain ?? "", portfolioLinks: p ? p.portfolioLinks.join("\n") : "",
    footerLinks: p ? p.footerLinks.map((link: any) => `${link.label} | ${link.url}`).join("\n") : "",
  }));
  // New quotations start the boilerplate sections from Settings once they have loaded; editing one keeps its own text.
  useEffect(() => {
    if (doc || !settings.data) return;
    const d = settings.data.documentSettings;
    setForm((current) => ({ ...current, advancePercent: String(settings.data!.defaultAdvancePercent), dueDate: current.dueDate || addDays(current.date, d.quotationDueDays), infrastructure: unlabel(d.infrastructure), afterService: d.afterService.join("\n"), timelineDuration: d.timelineDuration, milestones: unlabel(d.milestones), portfolioMain: d.portfolioMain, portfolioLinks: d.portfolioLinks.join("\n"), footerLinks: d.footerLinks.map((link) => `${link.label} | ${link.url}`).join("\n") }));
  }, [doc, settings.data]);
  void defaults;
  const done = { onSuccess: () => { onSaved(); onClose(); toast.success(doc ? "Quotation saved" : "Quotation created"); }, onError: (error: { message: string }) => toast.error(error.message) };
  const create = trpc.documents.createQuotation.useMutation(done);
  const update = trpc.documents.updateQuotation.useMutation(done);
  const costs = form.items.map((item) => Number(item.cost) || 0);
  const totals = quotationTotals(costs.map((cost) => ({ cost })));
  const percent = Number(form.advancePercent);
  const setItem = (index: number, patch: Partial<(typeof form.items)[number]>) => setForm((current) => ({ ...current, items: current.items.map((item, at) => (at === index ? { ...item, ...patch } : item)) }));
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const quotation = {
      clientName: form.clientName, projectName: form.projectName, intro: form.intro, advancePercent: percent, date: form.date, dueDate: form.dueDate || undefined,
      items: form.items.map((item) => ({ description: item.description, bullets: lines(item.bullets), cost: Number(item.cost) || 0 })),
      infrastructure: labelled(form.infrastructure), afterService: lines(form.afterService), timelineDuration: form.timelineDuration, milestones: labelled(form.milestones), portfolioMain: form.portfolioMain, portfolioLinks: lines(form.portfolioLinks),
      footerLinks: lines(form.footerLinks).map((line) => { const [label, url = ""] = line.split("|").map((part) => part.trim()); return { label, url }; }),
    };
    if (doc) update.mutate({ id: doc.id, quotation }); else create.mutate({ jobId: job.id, quotation });
  };
  const busy = create.isPending || update.isPending;

  return (
    <Modal open onClose={onClose} wide title={doc ? `Edit quotation ${doc.number}` : "New quotation"} description="Type the client, project, intro and prices yourself. The sections further down start from Settings and can be changed for this quotation.">
      <form className="mt-2 grid gap-4" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Client name" value={form.clientName} onChange={set("clientName")} required maxLength={180} placeholder={job.clientName} />
          <TextInput label="Project name" value={form.projectName} onChange={set("projectName")} required maxLength={180} placeholder={job.title} />
        </div>
        <TextArea label="Intro paragraph" value={form.intro} onChange={set("intro")} rows={3} maxLength={3000} />
        <div className="grid gap-3 sm:grid-cols-3">
          <TextInput label="Date" type="date" value={form.date} onChange={set("date")} required />
          <TextInput label="Due date" type="date" value={form.dueDate} onChange={set("dueDate")} />
          <TextInput label="Advance %" type="number" min={1} max={100} step="0.01" value={form.advancePercent} onChange={set("advancePercent")} required helper={percent > 0 && percent <= 100 ? paymentScheduleText(percent) : undefined} />
        </div>

        <div className="grid gap-3">
          <p className="webasi-label">Line items</p>
          {form.items.map((item, index) => (
            <div key={index} className="grid gap-2 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
                <TextInput label="Description" value={item.description} onChange={(event) => setItem(index, { description: event.target.value })} required maxLength={300} />
                <TextInput label="Cost (LKR)" type="number" min={0} step="0.01" inputMode="decimal" value={item.cost} onChange={(event) => setItem(index, { cost: event.target.value })} required />
              </div>
              <TextArea label="Bullets (one per line)" value={item.bullets} onChange={(event) => setItem(index, { bullets: event.target.value })} rows={4} />
              {form.items.length > 1 && <button type="button" onClick={() => setForm((current) => ({ ...current, items: current.items.filter((_, at) => at !== index) }))} className="justify-self-start text-[11px] font-semibold text-[#B91C1C]">Remove this item</button>}
            </div>
          ))}
          <button type="button" onClick={() => setForm((current) => ({ ...current, items: [...current.items, { description: "", bullets: "", cost: "0" }] }))} className="webasi-button-secondary justify-self-start"><Plus className="h-3.5 w-3.5" />Add line item</button>
          <p className="text-sm font-bold text-[#0F172A]">Total {formatLkr(totals.total)}</p>
        </div>

        <details className="rounded-xl border border-[#E2E8F0] p-3">
          <summary className="cursor-pointer text-xs font-bold text-[#1E293B]">Infrastructure, after service, timeline, portfolio, footer</summary>
          <div className="mt-3 grid gap-3">
            <TextArea label="Infrastructure (Label: text, one per line)" value={form.infrastructure} onChange={set("infrastructure")} rows={3} />
            <TextArea label="After service (one per line)" value={form.afterService} onChange={set("afterService")} rows={3} />
            <TextInput label="Estimated duration" value={form.timelineDuration} onChange={set("timelineDuration")} />
            <TextArea label="Milestones (Label: text, one per line)" value={form.milestones} onChange={set("milestones")} rows={4} />
            <TextInput label="Portfolio" value={form.portfolioMain} onChange={set("portfolioMain")} />
            <TextArea label="Portfolio links (one per line)" value={form.portfolioLinks} onChange={set("portfolioLinks")} rows={4} />
            <TextArea label="Footer links (Label | url, one per line)" value={form.footerLinks} onChange={set("footerLinks")} rows={3} helper="The first is the site, the next two sit in the middle and at the right." />
          </div>
        </details>
        <button type="submit" disabled={busy || !(percent > 0 && percent <= 100)} className="webasi-button-primary"><Busy on={busy}>{doc ? "Save quotation" : "Create quotation"}</Busy></button>
      </form>
    </Modal>
  );
}

// ----- Proposal & contract pack -------------------------------------------------------------------------------------------
function ContractForm({ job, doc, onClose, onSaved }: FormProps) {
  const settings = usePipelineSettings();
  const review = trpc.documents.templateReview.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const dismiss = trpc.settings.update.useMutation({ onSuccess: () => { utils.documents.templateReview.invalidate(); utils.dashboard.settings.invalidate(); toast.success("Notice dismissed"); } });
  const quotation = trpc.documents.get.useQuery({ id: job.approvedQuotationId ?? "" }, { enabled: Boolean(job.approvedQuotationId), retry: false });
  const d = settings.data?.documentSettings ?? DEFAULT_DOCUMENT_SETTINGS;
  const p = doc?.payload as any | undefined;
  const today = colomboDate();
  const [form, setForm] = useState(() => ({
    title: p?.title ?? "", dateOfDelivery: p?.dateOfDelivery ?? job.estimatedDeliveryDate ?? "", agreementDate: p?.agreementDate ?? today, startDate: p?.startDate ?? today, completionDate: p?.completionDate ?? job.estimatedDeliveryDate ?? "",
    paymentMethod: p?.paymentMethod ?? "", scope: p ? p.scope.join("\n") : "", receivingParty: p?.receivingParty ?? "", supportPeriod: p?.supportPeriod ?? "", supportContact: p?.supportContact ?? "",
    agreementIntro: p?.agreementIntro ?? "", ndaIntro: p?.ndaIntro ?? "", ndaClosing: p?.ndaClosing ?? "",
    clauses: (p?.clauses ?? null) as null | Array<{ title: string; lines: string[] }>, ndaClauses: (p?.ndaClauses ?? null) as null | Array<{ title: string; lines: string[] }>,
  }));
  const q = quotation.data?.payload as any | undefined;
  useEffect(() => {
    if (doc || !settings.data || !q) return;
    const s = settings.data.documentSettings;
    setForm((current) => ({ ...current, title: s.contractTitle, paymentMethod: s.paymentMethodText, receivingParty: s.receivingParty, supportPeriod: s.supportPeriod, supportContact: s.supportContact, agreementIntro: s.agreementIntro, ndaIntro: s.ndaIntro, ndaClosing: s.ndaClosing,
      scope: q.items.flatMap((item: any) => [item.description, ...item.bullets.map((bullet: string) => `  – ${bullet}`)]).join("\n") }));
  }, [doc, settings.data, q]);
  const done = { onSuccess: () => { onSaved(); onClose(); toast.success(doc ? "Contract saved" : "Contract pack created"); }, onError: (error: { message: string }) => toast.error(error.message) };
  const create = trpc.documents.createContract.useMutation(done);
  const update = trpc.documents.updateContract.useMutation(done);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const clausesOf = form.clauses ?? d.contractClauses;
  const ndaOf = form.ndaClauses ?? d.ndaClauses;
  const edit = (kind: "clauses" | "ndaClauses", index: number, patch: Partial<{ title: string; text: string }>) => setForm((current) => {
    const base = (kind === "clauses" ? current.clauses ?? d.contractClauses : current.ndaClauses ?? d.ndaClauses).map((clause) => ({ ...clause }));
    if (patch.title !== undefined) base[index].title = patch.title;
    if (patch.text !== undefined) base[index].lines = patch.text.split(/\r?\n/);
    return { ...current, [kind]: base };
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const contract = {
      title: form.title, dateOfDelivery: form.dateOfDelivery, agreementDate: form.agreementDate, startDate: form.startDate, completionDate: form.completionDate, paymentMethod: form.paymentMethod,
      scope: form.scope.split(/\r?\n/).filter((line: string) => line.trim()), receivingParty: form.receivingParty, supportPeriod: form.supportPeriod, supportContact: form.supportContact,
      agreementIntro: form.agreementIntro, ndaIntro: form.ndaIntro, ndaClosing: form.ndaClosing,
      ...(form.clauses && { clauses: form.clauses.map((c) => ({ title: c.title, lines: c.lines.filter((line) => line.trim()) })) }), ...(form.ndaClauses && { ndaClauses: form.ndaClauses.map((c) => ({ title: c.title, lines: c.lines.filter((line) => line.trim()) })) }),
    };
    if (doc) update.mutate({ id: doc.id, contract }); else create.mutate({ jobId: job.id, contract });
  };
  const busy = create.isPending || update.isPending;

  return (
    <Modal open onClose={onClose} wide title={doc ? `Edit contract pack ${doc.number}` : "Proposal & contract pack"} description="Built from the approved quotation. Wording starts from Settings; change it here only for this contract.">
      {review.data && !review.data.dismissed && (
        <div role="note" className="rounded-xl border border-[#FED7AA] bg-[#FFF7ED] p-3 text-[11px] leading-5 text-[#9A3412]">
          <p className="font-bold">Template review needed</p>
          <ul className="mt-1 list-disc pl-4">{review.data.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          <button type="button" onClick={() => dismiss.mutate({ templateReviewDismissed: true })} className="mt-2 font-semibold underline">Dismiss this notice</button>
        </div>
      )}
      <div className="mt-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-xs">
        <p className="webasi-label mb-1">From the approved quotation (not editable here)</p>
        <p>{q ? `${q.clientName} · ${q.projectName}` : "…"}</p>
        <p className="font-semibold">{job.priceTotal != null ? formatLkr(job.priceTotal) : "—"}{job.advancePercent ? ` · ${paymentScheduleText(job.advancePercent)}` : ""}</p>
      </div>
      <form className="mt-3 grid gap-3" onSubmit={submit}>
        <TextInput label="Project title" value={form.title} onChange={set("title")} required />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Agreement date" type="date" value={form.agreementDate} onChange={set("agreementDate")} required />
          <TextInput label="Start date" type="date" value={form.startDate} onChange={set("startDate")} required />
          <TextInput label="Estimated completion" type="date" value={form.completionDate} onChange={set("completionDate")} />
          <TextInput label="Date of delivery" type="date" value={form.dateOfDelivery} onChange={set("dateOfDelivery")} />
        </div>
        <TextInput label="Payment method" value={form.paymentMethod} onChange={set("paymentMethod")} />
        <TextArea label="Scope of work (starts as the quotation's line items)" value={form.scope} onChange={set("scope")} rows={6} />
        <TextArea label="Agreement opening line" value={form.agreementIntro} onChange={set("agreementIntro")} rows={2} helper="Kept as in your template. “[Start Date]” is filled in; other bracketed text is printed as written." />
        <TextInput label="Freelancer / receiving party" value={form.receivingParty} onChange={set("receivingParty")} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Support period" value={form.supportPeriod} onChange={set("supportPeriod")} />
          <TextInput label="Support contact" value={form.supportContact} onChange={set("supportContact")} />
        </div>
        <details className="rounded-xl border border-[#E2E8F0] p-3"><summary className="cursor-pointer text-xs font-bold text-[#1E293B]">Contract clauses ({clausesOf.length})</summary>
          <div className="mt-3 grid gap-3">{clausesOf.map((clause, index) => <div key={index} className="grid gap-2"><TextInput label={`Clause ${index + 1} title`} value={clause.title} onChange={(event) => edit("clauses", index, { title: event.target.value })} /><TextArea label="Wording" value={clause.lines.join("\n")} onChange={(event) => edit("clauses", index, { text: event.target.value })} rows={3} /></div>)}</div>
        </details>
        <details className="rounded-xl border border-[#E2E8F0] p-3"><summary className="cursor-pointer text-xs font-bold text-[#1E293B]">Non-disclosure agreement ({ndaOf.length} clauses)</summary>
          <div className="mt-3 grid gap-3">
            <TextArea label="Opening line" value={form.ndaIntro} onChange={set("ndaIntro")} rows={2} />
            {ndaOf.map((clause, index) => <div key={index} className="grid gap-2"><TextInput label={`Clause ${index + 1} title`} value={clause.title} onChange={(event) => edit("ndaClauses", index, { title: event.target.value })} /><TextArea label="Wording" value={clause.lines.join("\n")} onChange={(event) => edit("ndaClauses", index, { text: event.target.value })} rows={3} /></div>)}
            <TextArea label="Closing line" value={form.ndaClosing} onChange={set("ndaClosing")} rows={2} />
          </div>
        </details>
        <button type="submit" disabled={busy} className="webasi-button-primary"><Busy on={busy}>{doc ? "Save contract" : "Create contract pack"}</Busy></button>
      </form>
    </Modal>
  );
}

// ----- Technical and design documentation ---------------------------------------------------------------------------------
function TechnicalForm({ job, doc, onClose, onSaved }: FormProps) {
  const p = (doc?.payload ?? {}) as any;
  const [form, setForm] = useState({ overview: p.overview ?? "", frontend: p.frontend ?? "", backend: p.backend ?? "", database: p.database ?? "", installation: p.installation ?? "", apis: p.apis ?? "" });
  const save = trpc.documents.saveTechnical.useMutation({ onSuccess: () => { onSaved(); onClose(); toast.success("Saved"); }, onError: (error) => toast.error(error.message) });
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return (
    <Modal open onClose={onClose} wide title="Technical documentation" description="Never put passwords here: this form is stored. Use the Credentials PDF for logins.">
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); save.mutate({ jobId: job.id, id: doc?.id, ...form }); }}>
        <TextArea label="Overview (technology stack and architecture)" value={form.overview} onChange={set("overview")} rows={4} />
        <div className="grid gap-3 sm:grid-cols-3"><TextInput label="Frontend" value={form.frontend} onChange={set("frontend")} placeholder="React, Vue" /><TextInput label="Backend" value={form.backend} onChange={set("backend")} placeholder="Node.js, PHP" /><TextInput label="Database" value={form.database} onChange={set("database")} placeholder="MySQL, MongoDB" /></div>
        <TextArea label="Installation & deployment" value={form.installation} onChange={set("installation")} rows={5} />
        <TextArea label="APIs / plugins and integrations" value={form.apis} onChange={set("apis")} rows={4} />
        <button type="submit" disabled={save.isPending} className="webasi-button-primary"><Busy on={save.isPending}>Save</Busy></button>
      </form>
    </Modal>
  );
}

function DesignForm({ job, doc, onClose, onSaved }: FormProps) {
  const p = (doc?.payload ?? {}) as any;
  const [form, setForm] = useState({ sitemap: p.sitemap ?? "", figmaLink: p.figmaLink ?? "", primaryColor: p.primaryColor ?? "", secondaryColor: p.secondaryColor ?? "", accentColor: p.accentColor ?? "", fonts: p.fonts ?? "", responsive: p.responsive ?? "" });
  const save = trpc.documents.saveDesign.useMutation({ onSuccess: () => { onSaved(); onClose(); toast.success("Saved"); }, onError: (error) => toast.error(error.message) });
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return (
    <Modal open onClose={onClose} wide title="Design documentation" description="Never put passwords here: this form is stored.">
      <form className="mt-2 grid gap-3" onSubmit={(event) => { event.preventDefault(); save.mutate({ jobId: job.id, id: doc?.id, ...form }); }}>
        <TextArea label="Sitemap" value={form.sitemap} onChange={set("sitemap")} rows={4} />
        <TextInput label="Figma link" value={form.figmaLink} onChange={set("figmaLink")} placeholder="https://figma.com/…" />
        <div className="grid gap-3 sm:grid-cols-3"><TextInput label="Primary colour" value={form.primaryColor} onChange={set("primaryColor")} /><TextInput label="Secondary colour" value={form.secondaryColor} onChange={set("secondaryColor")} /><TextInput label="Accent colour" value={form.accentColor} onChange={set("accentColor")} /></div>
        <TextInput label="Fonts" value={form.fonts} onChange={set("fonts")} />
        <TextArea label="Responsive design" value={form.responsive} onChange={set("responsive")} rows={4} />
        <button type="submit" disabled={save.isPending} className="webasi-button-primary"><Busy on={save.isPending}>Save</Busy></button>
      </form>
    </Modal>
  );
}

// ----- Credentials & Access ----------------------------------------------------------------------------------------------------
// The values are typed here, sent in one POST and returned as a PDF. They are never stored: not in the database, the event
// log, local storage or the query cache. A plain fetch (not a tRPC mutation, which would keep its variables) and the form
// state is cleared the moment the file has been handed to the browser.
const BLANK_ROWS = () => [{ service: "Hosting Service", url: "", username: "", password: "" }, { service: "Domain Registrar", url: "", username: "", password: "" }];
function CredentialsModal({ job, open, onClose }: { job: JobDetail; open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState(BLANK_ROWS);
  const [show, setShow] = useState(false);
  const [confirmUnpaid, setConfirmUnpaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => { setRows(BLANK_ROWS()); setShow(false); setConfirmUnpaid(false); setError(""); onClose(); };
  const unpaid = job.money.outstanding > 0;
  const setRow = (index: number, patch: Partial<(typeof rows)[number]>) => setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/documents/credentials/pdf", { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id, rows, confirmUnpaid }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? "The PDF could not be made."); return; }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "Credentials-Access.pdf";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success("Credentials PDF downloaded", { description: "Nothing was saved on the server." });
      close();
    } catch { setError("Could not reach the server."); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={close} wide title="Credentials & Access PDF" description="Type the logins at handover. They go into the PDF and nowhere else: the server does not keep them, and neither does this page once the file is made.">
      <form className="mt-2 grid gap-3" onSubmit={generate} autoComplete="off">
        {unpaid && (
          <div role="alert" className="rounded-xl border border-[#FECACA] bg-[#FEF2F2] p-3 text-xs text-[#991B1B]">
            <p className="font-bold">{formatLkr(job.money.outstanding)} is still outstanding.</p>
            <label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={confirmUnpaid} onChange={(event) => setConfirmUnpaid(event.target.checked)} className="mt-0.5 h-4 w-4" /><span>I understand, hand over the credentials anyway. This is logged without the values.</span></label>
          </div>
        )}
        {rows.map((row, index) => (
          <div key={index} className="grid gap-2 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 sm:grid-cols-2">
            <TextInput label="Service" value={row.service} onChange={(event) => setRow(index, { service: event.target.value })} maxLength={300} autoComplete="off" />
            <TextInput label="URL" value={row.url} onChange={(event) => setRow(index, { url: event.target.value })} maxLength={300} autoComplete="off" />
            <TextInput label="Username" value={row.username} onChange={(event) => setRow(index, { username: event.target.value })} maxLength={300} autoComplete="off" />
            <TextInput label="Password" type={show ? "text" : "password"} value={row.password} onChange={(event) => setRow(index, { password: event.target.value })} maxLength={300} autoComplete="new-password" />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button type="button" onClick={() => setRows((current) => [...current, { service: "", url: "", username: "", password: "" }])} className="font-semibold text-[#2563FF]">Add a row</button>
          <label className="flex items-center gap-2 text-[#64748B]"><input type="checkbox" checked={show} onChange={(event) => setShow(event.target.checked)} />Show passwords</label>
        </div>
        {error && <p role="alert" className="text-xs text-[#B91C1C]">{error}</p>}
        <button type="submit" disabled={busy || (unpaid && !confirmUnpaid)} className="webasi-button-primary"><Busy on={busy}>Generate and download</Busy></button>
      </form>
    </Modal>
  );
}
