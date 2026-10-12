import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { AlertCircle, Check, CheckCircle2, Info, MessageSquareText, RefreshCw, Send, Sparkles, Zap } from "lucide-react";
import { cn, PageHeader } from "@/components/dashboard/shared";

export default function TrainingPage() {
  const projectsQuery = trpc.dashboard.projects.useQuery(undefined, { retry: false });
  const projects = projectsQuery.data ?? [];
  const defaultProjectKey = useMemo(() => projects.find((project) => project.status === "active")?.projectKey ?? projects[0]?.projectKey ?? "", [projects]);
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const projectKey = selectedProjectKey || defaultProjectKey;
  const trainingQuery = trpc.projects.training.useQuery({ projectKey }, { enabled: Boolean(projectKey), retry: false });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  useEffect(() => { if (trainingQuery.data) { setAnswers(trainingQuery.data.answers); setSummary(trainingQuery.data.summary); const next = trainingQuery.data.checklist.findIndex((item: string) => !trainingQuery.data?.answers[item]); setCurrentIndex(next >= 0 ? next : 0); } }, [trainingQuery.data]);
  const save = trpc.projects.saveTraining.useMutation({ onSuccess: () => { trainingQuery.refetch(); toast.success("Training answer saved"); }, onError: (error) => toast.error(error.message) });
  const utils = trpc.useUtils();
  const approve = trpc.projects.approveTraining.useMutation({ onSuccess: () => { trainingQuery.refetch(); projectsQuery.refetch(); utils.projects.instantAnswers.invalidate(); toast.success("Training approved", { description: "The project is ready to activate." }); }, onError: (error) => toast.error(error.message) });
  const checklist = trainingQuery.data?.checklist ?? [];
  const currentKey = checklist[currentIndex] ?? "";
  const completed = checklist.filter((item: string) => Boolean(answers[item]?.trim())).length;
  const progress = checklist.length ? Math.round((completed / checklist.length) * 100) : 0;
  const label = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
  const saveCurrent = () => { if (!projectKey || !currentKey || !answers[currentKey]?.trim()) { toast.error("Add an answer before saving"); return; } save.mutate({ projectKey, answers, summary }); };
  const approveSummary = () => { if (completed !== checklist.length) { toast.error("Complete every checklist item before approval"); return; } if (!summary.trim()) { toast.error("Review and enter a project summary before approval"); return; } if (window.confirm("Approve this training summary? The project can then be activated for client conversations.")) approve.mutate({ projectKey }); };
  if (!projectKey) return <div className="mx-auto max-w-[1100px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9"><PageHeader eyebrow="Workspace / Training" title="Project training" description="Create a project first, then complete its knowledge checklist." /><div className="webasi-card p-8 text-sm text-[#64748B]">No project is available yet. Create a draft from Projects to begin training.</div></div>;
  return <div className="mx-auto max-w-[1100px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9"><PageHeader eyebrow="Workspace / Training" title="Project training" description="Answer one question at a time. WEBASI stores the checklist and summary before approval." action={<span className="inline-flex items-center gap-1.5 rounded-full bg-[#EFF6FF] px-3 py-1.5 text-xs font-bold text-[#1D4ED8]"><Sparkles className="h-3.5 w-3.5" />{progress}% ready</span>} /><div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-[#E2E8F0] bg-white p-3"><span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">Project</span><select value={projectKey} onChange={(event) => { setSelectedProjectKey(event.target.value); setAnswers({}); setSummary(""); setCurrentIndex(0); }} className="h-9 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-bold text-[#1D4ED8] outline-none focus:border-[#2563FF]">{projects.map((project) => <option key={project.projectKey} value={project.projectKey}>{project.name} · v{project.version}</option>)}</select><span className="text-[11px] text-[#94A3B8]">Complete and approve this project before activation.</span></div><div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_310px]"><section className="webasi-card flex min-h-[560px] flex-col overflow-hidden"><div className="flex items-center justify-between border-b border-[#E2E8F0] p-5"><div><p className="text-sm font-bold text-[#1E293B]">Training interview</p><p className="mt-1 text-xs text-[#94A3B8]">One grounded answer at a time</p></div><span className="text-xs font-semibold text-[#64748B]">{completed} / {checklist.length} complete</span></div><div className="flex-1 space-y-5 bg-[#F8FAFC] p-5 sm:p-8"><div className="flex justify-start"><div className="max-w-[82%] rounded-2xl rounded-bl-md border border-[#E2E8F0] bg-white px-4 py-3 text-sm leading-6 text-[#1E293B] shadow-sm">What should WEBASI know about <strong>{label(currentKey).toLowerCase()}</strong>? Give a precise answer that can be safely used with clients.<span className="mt-1 block text-[10px] text-[#94A3B8]">WEBASI · checklist item {currentIndex + 1}</span></div></div><div className="flex justify-end"><div className="max-w-[82%] rounded-2xl rounded-br-md bg-[#2563FF] px-4 py-3 text-sm leading-6 text-white shadow-sm">{answers[currentKey] || "I'm ready to answer this item."}</div></div></div><div className="border-t border-[#E2E8F0] bg-white p-4"><div className="flex items-end gap-2 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-2"><textarea value={answers[currentKey] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [currentKey]: event.target.value }))} className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-xs leading-5 outline-none" placeholder="Type your answer…" /><button onClick={() => { saveCurrent(); if (answers[currentKey]?.trim() && currentIndex < checklist.length - 1) setCurrentIndex((index) => index + 1); }} disabled={save.isPending} className="webasi-button-primary min-h-9 px-3"><Send className="h-3.5 w-3.5" />{save.isPending ? "Saving…" : "Save & next"}</button></div></div></section><section className="space-y-5"><div className="webasi-card p-5"><div className="mb-4 flex items-center justify-between"><div><p className="webasi-label mb-2">Checklist</p><h2 className="text-base font-bold text-[#0F172A]">Knowledge readiness</h2></div><span className="text-xs font-bold text-[#2563FF]">{progress}%</span></div><div className="mb-5 h-2 overflow-hidden rounded-full bg-[#F1F5F9]"><div className="h-full rounded-full bg-[#2563FF] transition-all" style={{ width: `${progress}%` }} /></div><div className="space-y-3">{checklist.map((item: string, index: number) => <button key={item} onClick={() => setCurrentIndex(index)} className="flex w-full items-center gap-2.5 text-left text-xs"><span className={cn("flex h-5 w-5 items-center justify-center rounded-full", answers[item]?.trim() ? "bg-[#DCFCE7] text-[#15803D]" : index === currentIndex ? "bg-[#DBEAFE] text-[#1D4ED8]" : "bg-[#F1F5F9] text-[#94A3B8]")}>{answers[item]?.trim() ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}</span><span className={answers[item]?.trim() ? "font-medium text-[#1E293B]" : "text-[#64748B]"}>{label(item)}</span></button>)}</div></div><div className="webasi-card border-[#C7D8FF] bg-[#EFF6FF] p-5"><p className="text-xs font-bold text-[#1D4ED8]">Summary approval</p><p className="mt-2 text-xs leading-5 text-[#1E40AF]">Review the summary before this project can become eligible for activation.</p><textarea value={summary} onChange={(event) => setSummary(event.target.value)} className="mt-4 min-h-24 w-full rounded-lg border border-[#BFDBFE] bg-white p-3 text-xs leading-5 text-[#1E293B] outline-none focus:border-[#2563FF]" placeholder="Write the approved project summary…" /><div className="mt-3 flex gap-2"><button onClick={() => save.mutate({ projectKey, answers, summary })} disabled={save.isPending} className="webasi-button-secondary min-h-9 px-3">Save draft</button><button onClick={approveSummary} disabled={approve.isPending} className="webasi-button-primary min-h-9 px-3">{approve.isPending ? "Approving & writing instant answers…" : "Approve summary"}</button></div></div></section></div><InstantAnswersPanel projectKey={projectKey} /><KnowledgeGapQuiz /></div>;
}

function InstantAnswersPanel({ projectKey }: { projectKey: string }) {
  const answersQuery = trpc.projects.instantAnswers.useQuery({ projectKey }, { enabled: Boolean(projectKey), retry: false });
  const regenerate = trpc.projects.regenerateInstantAnswers.useMutation({ onSuccess: (result) => { answersQuery.refetch(); toast.success(`${result.count} instant answers written`, { description: "WEBASI now answers these questions without an AI request." }); }, onError: (error) => toast.error("Could not write the instant answers", { description: error.message }) });
  const remove = trpc.projects.removeInstantAnswer.useMutation({ onSuccess: () => { answersQuery.refetch(); toast.success("Instant answer removed", { description: "The AI answers this question again." }); }, onError: (error) => toast.error(error.message) });
  const owner = answersQuery.data?.owner ?? [];
  const generated = answersQuery.data?.generated ?? [];
  const outOfDate = Boolean(answersQuery.data?.outOfDate);
  return (
    <section className="mt-6 webasi-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] bg-gradient-to-r from-[#FFFBEB] to-[#EFF6FF] p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#F59E0B] text-white shadow-sm">
            <Zap className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-bold text-[#1E293B]">Instant answers</p>
            <p className="mt-0.5 text-[11px] text-[#64748B]">Questions WEBASI answers straight from this list, without an AI request</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {generated.length > 0 && <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-bold", outOfDate ? "bg-[#FEF3C7] text-[#B45309]" : "bg-[#F0FDF4] text-[#15803D]")}>{generated.length} generated{outOfDate ? " · not in use" : ""}</span>}
          {owner.length > 0 && <span className="rounded-full bg-[#EFF6FF] px-2.5 py-1 text-[10px] font-bold text-[#1D4ED8]">{owner.length} from your FAQs</span>}
          <button onClick={() => regenerate.mutate({ projectKey })} disabled={regenerate.isPending || !projectKey} className="webasi-button-secondary px-2.5 py-1.5 text-[11px]"><RefreshCw className={cn("h-3.5 w-3.5", regenerate.isPending && "animate-spin")} />{regenerate.isPending ? "Writing…" : generated.length > 0 ? "Regenerate" : "Generate"}</button>
        </div>
      </div>
      {outOfDate && (
        <div className="flex items-start gap-2 border-b border-[#FDE68A] bg-[#FFFBEB] p-4 text-[11px] leading-5 text-[#92400E]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>The project knowledge changed after these answers were written, so WEBASI is not using the generated ones. Regenerate to switch them back on.</span>
        </div>
      )}
      {answersQuery.isLoading ? (
        <div className="p-8 text-center text-xs text-[#94A3B8]">Loading answers…</div>
      ) : owner.length + generated.length === 0 ? (
        <div className="p-8 text-center text-xs leading-5 text-[#94A3B8]">No instant answers yet. They are written from the project knowledge when you approve the training, or when you press Generate.</div>
      ) : (
        <div className="max-h-[420px] divide-y divide-[#F1F5F9] overflow-y-auto">
          {owner.map((entry) => (
            <div key={`owner-${entry.question}`} className="p-4">
              <p className="text-xs font-semibold text-[#1E293B]">{entry.question}<span className="ml-2 rounded-full bg-[#EFF6FF] px-2 py-0.5 text-[10px] font-medium text-[#1D4ED8]">Your FAQ</span></p>
              <p className="mt-1.5 whitespace-pre-line text-xs leading-5 text-[#475569]">{entry.answer}</p>
            </div>
          ))}
          {generated.map((entry) => (
            <div key={`generated-${entry.question}`} className={cn("flex items-start justify-between gap-4 p-4", outOfDate && "opacity-60")}>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#1E293B]">{entry.question}</p>
                {(entry.alternatives ?? []).length > 0 && <p className="mt-1 text-[10px] leading-4 text-[#94A3B8]">Also asked as: {(entry.alternatives ?? []).join(" · ")}</p>}
                <p className="mt-1.5 text-xs leading-5 text-[#475569]">{entry.answer}</p>
              </div>
              <button onClick={() => remove.mutate({ projectKey, question: entry.question })} disabled={remove.isPending} className="shrink-0 text-[11px] font-semibold text-[#B91C1C] hover:underline">Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-start gap-2 border-t border-[#E2E8F0] bg-[#F8FAFC] p-4">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#64748B]" />
        <p className="text-[11px] leading-5 text-[#64748B]">An answer is sent word for word when a client's question clearly matches. Generated answers are in English{answersQuery.data?.englishForSinglish ? "; a Singlish question that clearly matches gets the English answer, and other Singlish and Sinhala messages still go to the AI" : ", so Singlish and Sinhala messages still go to the AI"}, as do discounts, complaints and clients who are ready to order. Remove any answer you would not send yourself.</p>
      </div>
    </section>
  );
}

function KnowledgeGapQuiz() {
  const gapsQuery = trpc.knowledgeGaps.list.useQuery(undefined, { refetchInterval: 15000, retry: false });
  const answerMutation = trpc.knowledgeGaps.answer.useMutation({ onSuccess: () => { gapsQuery.refetch(); toast.success("Answer saved & added to project FAQs 🎉"); setDraft(""); }, onError: (error) => toast.error(error.message) });
  const gaps = (gapsQuery.data ?? []).filter((gap) => gap.status === "pending");
  const answered = (gapsQuery.data ?? []).filter((gap) => gap.status === "answered");
  const [activeId, setActiveId] = useState<string | number | null>(null);
  const [draft, setDraft] = useState("");
  const activeGap = gaps.find((gap) => gap.id === activeId) ?? gaps[0] ?? null;
  const reasonLabel = (reason: string) => reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const submit = () => { if (!activeGap || !draft.trim()) { toast.error("Write an answer first"); return; } answerMutation.mutate({ id: activeGap.id, answer: draft.trim() }); };
  return (
    <section className="mt-6 webasi-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-gradient-to-r from-[#F5F3FF] to-[#EFF6FF] p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#7C3AED] text-white shadow-sm">
            <MessageSquareText className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-bold text-[#1E293B]">Knowledge Gap Quiz</p>
            <p className="mt-0.5 text-[11px] text-[#64748B]">Questions clients asked that WEBASI couldn't answer — answer them to train the bot</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {gaps.length > 0 && <span className="rounded-full bg-[#7C3AED] px-2.5 py-1 text-[10px] font-bold text-white">{gaps.length} pending</span>}
          {answered.length > 0 && <span className="rounded-full bg-[#F0FDF4] px-2.5 py-1 text-[10px] font-bold text-[#15803D]">{answered.length} answered</span>}
          <button onClick={() => gapsQuery.refetch()} disabled={gapsQuery.isFetching} className="webasi-button-secondary px-2.5 py-1.5 text-[11px]"><RefreshCw className={cn("h-3.5 w-3.5", gapsQuery.isFetching && "animate-spin")} /></button>
        </div>
      </div>
      {gapsQuery.isLoading ? (
        <div className="p-8 text-center text-xs text-[#94A3B8]">Loading gaps…</div>
      ) : gaps.length === 0 ? (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#F0FDF4] text-[#15803D]"><CheckCircle2 className="h-6 w-6" /></div>
          <p className="text-sm font-bold text-[#1E293B]">All gaps answered!</p>
          <p className="max-w-xs text-xs text-[#94A3B8]">{answered.length > 0 ? `${answered.length} question${answered.length > 1 ? "s" : ""} answered and added to your knowledge base.` : "No unanswered questions yet. They appear here automatically when a client asks something WEBASI can't answer."}</p>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[260px_1fr]">
          <div className="divide-y divide-[#F1F5F9] border-r border-[#E2E8F0]">
            {gaps.map((gap) => (
              <button key={gap.id} onClick={() => { setActiveId(gap.id); setDraft(""); }} className={cn("w-full p-4 text-left transition", activeGap?.id === gap.id ? "bg-[#F5F3FF]" : "hover:bg-[#FAFCFF]")}>
                <p className="line-clamp-2 text-xs font-semibold text-[#1E293B]">{gap.question}</p>
                <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-[#F5F3FF] px-2 py-0.5 text-[10px] font-medium text-[#7C3AED]">{reasonLabel(gap.reason)}</span>
                <p className="mt-1 text-[10px] text-[#94A3B8]">{new Date(gap.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</p>
              </button>
            ))}
          </div>
          {activeGap ? (
            <div className="flex flex-col">
              <div className="flex-1 space-y-4 bg-[#F8FAFC] p-5 sm:p-7">
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-[#E2E8F0] bg-white px-4 py-3 text-sm leading-6 text-[#1E293B] shadow-sm">
                    {activeGap.question}
                    <span className="mt-1 block text-[10px] text-[#7C3AED]">Client asked · {reasonLabel(activeGap.reason)}</span>
                  </div>
                </div>
                {activeGap.answer && (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#7C3AED] px-4 py-3 text-sm leading-6 text-white shadow-sm">
                      {activeGap.answer}
                      <span className="mt-1 block text-[10px] text-purple-200">Your answer · added to FAQs</span>
                    </div>
                  </div>
                )}
                <div className="flex items-start gap-2 rounded-lg border border-[#E2E8F0] bg-white p-3">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#7C3AED]" />
                  <p className="text-[11px] leading-5 text-[#64748B]">Your answer will be added to the active project's FAQs. WEBASI will use it to answer similar questions from future clients automatically.</p>
                </div>
              </div>
              <div className="border-t border-[#E2E8F0] bg-white p-4">
                <div className="flex items-end gap-2 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-2">
                  <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit(); }} className="min-h-[60px] flex-1 resize-none bg-transparent px-2 py-1 text-xs leading-5 outline-none" placeholder="Type your answer… (Ctrl+Enter to save)" />
                  <button onClick={submit} disabled={answerMutation.isPending || !draft.trim()} className="webasi-button-primary min-h-9 px-3" style={{ background: "#7C3AED" }}><Send className="h-3.5 w-3.5" />{answerMutation.isPending ? "Saving…" : "Answer & add to FAQs"}</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center p-8 text-xs text-[#94A3B8]">Select a question from the list to answer it.</div>
          )}
        </div>
      )}
    </section>
  );
}
