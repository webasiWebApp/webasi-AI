import { trpc } from "@/lib/trpc";
import { usePipelineSettings } from "@/hooks/usePipelineSettings";
import { SettingsSection } from "@/components/dashboard/shared";
import { Busy, TextArea, TextInput } from "@/components/pipeline/kit";
import { DEFAULT_DOCUMENT_SETTINGS } from "@shared/documents";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const labelled = (text: string) => lines(text).map((line) => { const at = line.indexOf(":"); return at < 0 ? { label: line, text: "" } : { label: line.slice(0, at).trim(), text: line.slice(at + 1).trim() }; });
const unlabel = (rows: Array<{ label: string; text: string }>) => rows.map((row) => (row.text ? `${row.label}: ${row.text}` : row.label)).join("\n");

// The pipeline module's settings: documents, the task template and the reminders. They sit under the existing sections.
export default function PipelineSettings() {
  return (
    <div className="mt-6 grid gap-6 [&>*]:min-w-0">
      <TemplateReview />
      <BusinessDocuments />
      <TaskTemplate />
      <Reminders />
    </div>
  );
}

function TemplateReview() {
  const review = trpc.documents.templateReview.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const dismiss = trpc.settings.update.useMutation({ onSuccess: () => { utils.documents.templateReview.invalidate(); utils.dashboard.settings.invalidate(); toast.success("Notice dismissed"); }, onError: (error) => toast.error(error.message) });
  if (!review.data || review.data.dismissed) return null;
  return (
    <div role="note" className="rounded-2xl border border-[#FED7AA] bg-[#FFF7ED] p-4 text-xs leading-5 text-[#9A3412]">
      <p className="text-sm font-bold">Template review needed</p>
      <p className="mt-1">Your contract template has three things that do not agree with each other. They are kept exactly as you wrote them. Decide what each should say, edit the wording below or in the contract form, then dismiss this notice.</p>
      <ul className="mt-2 list-disc pl-5">{review.data.notes.map((note) => <li key={note}>{note}</li>)}</ul>
      <button onClick={() => dismiss.mutate({ templateReviewDismissed: true })} className="mt-3 font-semibold underline">Dismiss this notice</button>
    </div>
  );
}

function BusinessDocuments() {
  const settings = usePipelineSettings();
  const utils = trpc.useUtils();
  const save = trpc.settings.update.useMutation({ onSuccess: () => { utils.dashboard.settings.invalidate(); toast.success("Document settings saved"); }, onError: (error) => toast.error(error.message) });
  const saved = settings.data;
  const d = saved?.documentSettings ?? DEFAULT_DOCUMENT_SETTINGS;
  const [form, setForm] = useState({ registrationNo: "", defaultAdvancePercent: "40", nextDocumentNumber: "9248", quotationDueDays: "30", invoiceDueDays: "14", paymentMethodText: "", supportPeriod: "", supportContact: "", contractTitle: "", receivingParty: "", infrastructure: "", afterService: "", timelineDuration: "", milestones: "", portfolioMain: "", portfolioLinks: "", footerLinks: "", agreementIntro: "", ndaIntro: "", ndaClosing: "", contractClauses: "", ndaClauses: "" });
  const clauseText = (clauses: Array<{ title: string; lines: string[] }>) => clauses.map((clause) => `# ${clause.title}\n${clause.lines.join("\n")}`).join("\n\n");
  useEffect(() => {
    if (!saved) return;
    const s = saved.documentSettings;
    setForm({ registrationNo: saved.registrationNo, defaultAdvancePercent: String(saved.defaultAdvancePercent), nextDocumentNumber: String(saved.nextDocumentNumber), quotationDueDays: String(s.quotationDueDays), invoiceDueDays: String(s.invoiceDueDays), paymentMethodText: s.paymentMethodText, supportPeriod: s.supportPeriod, supportContact: s.supportContact, contractTitle: s.contractTitle, receivingParty: s.receivingParty,
      infrastructure: unlabel(s.infrastructure), afterService: s.afterService.join("\n"), timelineDuration: s.timelineDuration, milestones: unlabel(s.milestones), portfolioMain: s.portfolioMain, portfolioLinks: s.portfolioLinks.join("\n"), footerLinks: s.footerLinks.map((link) => `${link.label} | ${link.url}`).join("\n"),
      agreementIntro: s.agreementIntro, ndaIntro: s.ndaIntro, ndaClosing: s.ndaClosing, contractClauses: clauseText(s.contractClauses), ndaClauses: clauseText(s.ndaClauses) });
  }, [saved]);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const parseClauses = (text: string) => text.split(/\n\s*\n(?=# )/).map((block) => block.trim()).filter(Boolean).map((block) => { const [first, ...rest] = block.split(/\r?\n/); return { title: first.replace(/^#\s*/, "").trim(), lines: rest.map((line) => line.trim()).filter(Boolean) }; });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    save.mutate({
      registrationNo: form.registrationNo, defaultAdvancePercent: Number(form.defaultAdvancePercent), nextDocumentNumber: Number(form.nextDocumentNumber),
      documentSettings: {
        quotationDueDays: Number(form.quotationDueDays), invoiceDueDays: Number(form.invoiceDueDays), paymentMethodText: form.paymentMethodText, supportPeriod: form.supportPeriod, supportContact: form.supportContact, contractTitle: form.contractTitle, receivingParty: form.receivingParty,
        infrastructure: labelled(form.infrastructure), afterService: lines(form.afterService), timelineDuration: form.timelineDuration, milestones: labelled(form.milestones), portfolioMain: form.portfolioMain, portfolioLinks: lines(form.portfolioLinks),
        footerLinks: lines(form.footerLinks).map((line) => { const [label, url = ""] = line.split("|").map((part) => part.trim()); return { label, url }; }),
        agreementIntro: form.agreementIntro, ndaIntro: form.ndaIntro, ndaClosing: form.ndaClosing, contractClauses: parseClauses(form.contractClauses), ndaClauses: parseClauses(form.ndaClauses),
      },
    });
  };
  return (
    <SettingsSection title="Business documents" description="What your quotations, invoices, receipts and contracts start from. Each document can still change any of it for itself.">
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextInput label="Registration no." value={form.registrationNo} onChange={set("registrationNo")} maxLength={60} helper="Printed top right as REG NO." />
          <TextInput label="Default advance %" type="number" min={1} max={100} value={form.defaultAdvancePercent} onChange={set("defaultAdvancePercent")} />
          <TextInput label="Next document number" type="number" min={1} value={form.nextDocumentNumber} onChange={set("nextDocumentNumber")} helper="The next number to issue. It only moves forward." />
          <TextInput label="Quotation due after (days)" type="number" min={1} value={form.quotationDueDays} onChange={set("quotationDueDays")} />
          <TextInput label="Invoice due after (days)" type="number" min={1} value={form.invoiceDueDays} onChange={set("invoiceDueDays")} />
          <TextInput label="Payment method text" value={form.paymentMethodText} onChange={set("paymentMethodText")} />
        </div>
        <TextArea label="Infrastructure (Label: text, one per line)" value={form.infrastructure} onChange={set("infrastructure")} rows={3} />
        <TextArea label="After service (one per line)" value={form.afterService} onChange={set("afterService")} rows={3} />
        <TextInput label="Estimated duration" value={form.timelineDuration} onChange={set("timelineDuration")} />
        <TextArea label="Milestones (Label: text, one per line)" value={form.milestones} onChange={set("milestones")} rows={4} />
        <TextInput label="Portfolio" value={form.portfolioMain} onChange={set("portfolioMain")} />
        <TextArea label="Portfolio links (one per line)" value={form.portfolioLinks} onChange={set("portfolioLinks")} rows={4} />
        <TextArea label="Footer links (Label | url, one per line)" value={form.footerLinks} onChange={set("footerLinks")} rows={3} />
        <div className="grid gap-3 sm:grid-cols-2"><TextInput label="Support period" value={form.supportPeriod} onChange={set("supportPeriod")} /><TextInput label="Support contact" value={form.supportContact} onChange={set("supportContact")} /><TextInput label="Contract title" value={form.contractTitle} onChange={set("contractTitle")} /><TextInput label="Freelancer / receiving party" value={form.receivingParty} onChange={set("receivingParty")} /></div>
        <details className="rounded-xl border border-[#E2E8F0] p-3">
          <summary className="cursor-pointer text-xs font-bold text-[#1E293B]">Contract and NDA wording</summary>
          <div className="mt-3 grid gap-3">
            <p className="text-[11px] leading-5 text-[#64748B]">Your template's wording, kept as written. Each clause starts with a line beginning “# ”. {"{{totalFee}}"}, {"{{paymentSchedule}}"}, {"{{paymentMethod}}"}, {"{{startDate}}"} and {"{{completionDate}}"} are filled in for you; the fee and the payment split always come from the approved quotation.</p>
            <TextArea label="Agreement opening line" value={form.agreementIntro} onChange={set("agreementIntro")} rows={2} />
            <TextArea label="Contract clauses" value={form.contractClauses} onChange={set("contractClauses")} rows={14} className="font-mono" />
            <TextArea label="NDA opening line" value={form.ndaIntro} onChange={set("ndaIntro")} rows={2} />
            <TextArea label="NDA clauses" value={form.ndaClauses} onChange={set("ndaClauses")} rows={12} />
            <TextArea label="NDA closing line" value={form.ndaClosing} onChange={set("ndaClosing")} rows={2} />
          </div>
        </details>
        <div><button type="submit" disabled={save.isPending || settings.isLoading} className="webasi-button-primary"><Busy on={save.isPending}>Save document settings</Busy></button></div>
      </form>
    </SettingsSection>
  );
}

function TaskTemplate() {
  const template = trpc.tasks.template.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const [titles, setTitles] = useState<string[]>([]);
  useEffect(() => { if (template.data) setTitles(template.data.map((task) => task.title)); }, [template.data]);
  const save = trpc.tasks.saveTemplate.useMutation({ onSuccess: () => { utils.tasks.template.invalidate(); toast.success("Task template saved", { description: "Jobs that already started keep their own list." }); }, onError: (error) => toast.error(error.message) });
  const move = (index: number, delta: number) => setTitles((current) => { const next = [...current]; const target = index + delta; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; });
  return (
    <SettingsSection title="Task template" description="The checklist copied into a job when its project starts. Changing it never changes jobs that already started.">
      <ol className="flex flex-col gap-2">
        {titles.map((title, index) => (
          <li key={index} className="flex min-w-0 items-center gap-1.5">
            <span className="w-6 text-right text-[11px] text-[#94A3B8]">{index + 1}</span>
            <input value={title} onChange={(event) => setTitles((current) => current.map((item, at) => (at === index ? event.target.value : item)))} maxLength={300} aria-label={`Task ${index + 1}`} className="min-w-0 flex-1 rounded-lg border border-[#E2E8F0] px-3 py-2 text-xs" />
            <button type="button" aria-label="Move up" onClick={() => move(index, -1)} disabled={index === 0} className="flex h-8 w-8 items-center justify-center rounded-md text-[#94A3B8] hover:bg-[#F1F5F9] disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Move down" onClick={() => move(index, 1)} disabled={index === titles.length - 1} className="flex h-8 w-8 items-center justify-center rounded-md text-[#94A3B8] hover:bg-[#F1F5F9] disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Remove" onClick={() => setTitles((current) => current.filter((_, at) => at !== index))} className="flex h-8 w-8 items-center justify-center rounded-md text-[#94A3B8] hover:bg-[#FEF2F2] hover:text-[#B91C1C]"><Trash2 className="h-3.5 w-3.5" /></button>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => setTitles((current) => [...current, ""])} className="webasi-button-secondary"><Plus className="h-3.5 w-3.5" />Add a task</button>
        <button type="button" onClick={() => save.mutate({ titles })} disabled={save.isPending} className="webasi-button-primary"><Busy on={save.isPending}>Save template</Busy></button>
      </div>
    </SettingsSection>
  );
}

function Reminders() {
  const settings = usePipelineSettings();
  const utils = trpc.useUtils();
  const save = trpc.settings.update.useMutation({ onSuccess: () => { utils.dashboard.settings.invalidate(); toast.success("Reminders saved"); }, onError: (error) => toast.error(error.message) });
  const saved = settings.data?.reminderSettings;
  const [form, setForm] = useState({ quotationEnabled: true, quotationDays: "3", balanceEnabled: true, balanceDays: "3", renewalEnabled: true });
  const [categories, setCategories] = useState("");
  useEffect(() => { if (saved) setForm({ quotationEnabled: saved.quotationEnabled, quotationDays: String(saved.quotationDays), balanceEnabled: saved.balanceEnabled, balanceDays: String(saved.balanceDays), renewalEnabled: saved.renewalEnabled }); }, [saved]);
  useEffect(() => { if (settings.data) setCategories(settings.data.ledgerCategories.expense.join("\n")); }, [settings.data]);
  const toggle = (key: "quotationEnabled" | "balanceEnabled" | "renewalEnabled", title: string, detail: string, days?: "quotationDays" | "balanceDays") => (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E2E8F0] p-3">
      <button type="button" aria-pressed={form[key]} onClick={() => setForm((current) => ({ ...current, [key]: !current[key] }))} className="text-left"><span className="block text-xs font-semibold text-[#1E293B]">{title}: {form[key] ? "on" : "off"}</span><span className="block text-[11px] text-[#94A3B8]">{detail}</span></button>
      {days && <label className="flex items-center gap-2 text-[11px] text-[#64748B]">after<input type="number" min={1} max={60} value={form[days]} onChange={(event) => setForm((current) => ({ ...current, [days]: event.target.value }))} className="w-16 rounded-lg border border-[#E2E8F0] px-2 py-1.5 text-xs" aria-label={`${title} days`} />days</label>}
    </div>
  );
  return (
    <SettingsSection title="Reminders and categories" description="Short WhatsApp lines to you, between 09:00 and 20:00 Sri Lanka time, each sent once. Documents are never sent to clients for you.">
      <div className="grid gap-3">
        {toggle("quotationEnabled", "Quotation with no answer", "Counted from the day you marked it as sent.", "quotationDays")}
        {toggle("balanceEnabled", "Unpaid balance after delivery", "Counted from the day the job was delivered.", "balanceDays")}
        {toggle("renewalEnabled", "Renewals due", "At 30 days and again at 7 days before the due date.")}
        <TextArea label="Expense categories (one per line)" value={categories} onChange={(event) => setCategories(event.target.value)} rows={6} helper="Income categories are fixed: advance, final, renewal and extra." />
        <div><button onClick={() => save.mutate({ reminderSettings: { quotationEnabled: form.quotationEnabled, quotationDays: Number(form.quotationDays), balanceEnabled: form.balanceEnabled, balanceDays: Number(form.balanceDays), renewalEnabled: form.renewalEnabled }, expenseCategories: lines(categories) })} disabled={save.isPending} className="webasi-button-primary"><Busy on={save.isPending}>Save</Busy></button></div>
      </div>
    </SettingsSection>
  );
}
