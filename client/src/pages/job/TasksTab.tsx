import { trpc } from "@/lib/trpc";
import { cn } from "@/components/dashboard/shared";
import { Busy, Card, Empty, notify } from "@/components/pipeline/kit";
import type { JobDetail } from "@/pages/JobPage";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

// The A to Z checklist: checkboxes and a count, not a board.
export function TasksTab({ job }: { job: JobDetail }) {
  const utils = trpc.useUtils();
  const tasks = trpc.tasks.list.useQuery({ jobId: job.id }, { retry: false });
  const refresh = () => { utils.tasks.list.invalidate({ jobId: job.id }); utils.jobs.get.invalidate({ id: job.id }); utils.today.overview.invalidate(); };
  const update = trpc.tasks.update.useMutation({ ...notify(), onSuccess: refresh });
  const remove = trpc.tasks.remove.useMutation({ ...notify(), onSuccess: refresh });
  const reorder = trpc.tasks.reorder.useMutation({ ...notify(), onSuccess: refresh });
  const add = trpc.tasks.add.useMutation({ ...notify(), onSuccess: () => { refresh(); setTitle(""); } });
  const [title, setTitle] = useState("");
  const [openNote, setOpenNote] = useState<string | null>(null);
  const rows = tasks.data ?? [];
  const done = rows.filter((task) => task.status === "done").length;
  const move = (index: number, delta: number) => {
    const ids = rows.map((task) => task.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate({ jobId: job.id, orderedIds: ids });
  };
  const locked = job.stage === "lost";

  return (
    <Card title={`Tasks${rows.length ? ` · ${done} / ${rows.length}` : ""}`}>
      {rows.length > 0 && <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[#E2E8F0]" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={rows.length}><div className="h-full rounded-full bg-[#22C55E] transition-all" style={{ width: `${(done / rows.length) * 100}%` }} /></div>}
      {tasks.isLoading ? <p className="text-xs text-[#94A3B8]">Loading…</p> : rows.length === 0 ? <Empty>{["lead", "meeting", "quoted", "approved"].includes(job.stage) ? "The checklist is created when the project starts." : "No tasks."}</Empty> : (
        <ul className="divide-y divide-[#F1F5F9]">
          {rows.map((task, index) => (
            <li key={task.id} className="py-2.5 text-xs">
              <div className="flex items-start gap-2.5">
                <input type="checkbox" checked={task.status === "done"} disabled={locked || update.isPending} onChange={(event) => update.mutate({ id: task.id, status: event.target.checked ? "done" : "todo" })} aria-label={`Done: ${task.title}`} className="mt-0.5 h-5 w-5 shrink-0 accent-[#2563FF]" />
                <div className="min-w-0 flex-1">
                  <button onClick={() => setOpenNote(openNote === task.id ? null : task.id)} className={cn("text-left font-medium text-[#1E293B]", task.status === "done" && "text-[#94A3B8] line-through")}>{task.title}</button>
                  {task.dueDate && <span className="ml-2 text-[11px] text-[#94A3B8]">due {task.dueDate}</span>}
                  {task.note && openNote !== task.id && <p className="text-[11px] text-[#94A3B8]">{task.note}</p>}
                </div>
                <div className="flex shrink-0 items-center">
                  <button aria-label="Move up" disabled={index === 0 || reorder.isPending} onClick={() => move(index, -1)} className="flex h-8 w-8 items-center justify-center rounded-md text-[#94A3B8] hover:bg-[#F1F5F9] disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button aria-label="Move down" disabled={index === rows.length - 1 || reorder.isPending} onClick={() => move(index, 1)} className="flex h-8 w-8 items-center justify-center rounded-md text-[#94A3B8] hover:bg-[#F1F5F9] disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                  <button aria-label="Remove task" disabled={locked || remove.isPending} onClick={() => { if (window.confirm(`Remove “${task.title}” from this job?`)) remove.mutate({ id: task.id }); }} className="flex h-8 w-8 items-center justify-center rounded-md text-[#94A3B8] hover:bg-[#FEF2F2] hover:text-[#B91C1C]"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              {openNote === task.id && (
                <div className="mt-2 grid gap-2 pl-8 sm:grid-cols-[160px_1fr]">
                  <input type="date" defaultValue={task.dueDate ?? ""} onBlur={(event) => { if ((event.target.value || null) !== task.dueDate) update.mutate({ id: task.id, dueDate: event.target.value || null }); }} aria-label="Due date" className="rounded-lg border border-[#E2E8F0] px-2 py-1.5 text-xs" />
                  <input defaultValue={task.note} maxLength={2000} placeholder="Note" onBlur={(event) => { if (event.target.value !== task.note) update.mutate({ id: task.id, note: event.target.value }); }} aria-label="Note" className="rounded-lg border border-[#E2E8F0] px-2 py-1.5 text-xs" />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!locked && ["active", "delivered", "closed"].includes(job.stage) && (
        <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (title.trim()) add.mutate({ jobId: job.id, title }); }}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} placeholder="Add a task" aria-label="New task" className="min-w-0 flex-1 rounded-lg border border-[#E2E8F0] px-3 py-2 text-xs outline-none focus:border-[#2563FF]" />
          <button type="submit" disabled={add.isPending || !title.trim()} className="webasi-button-secondary"><Busy on={add.isPending}><Plus className="h-3.5 w-3.5" />Add</Busy></button>
        </form>
      )}
    </Card>
  );
}
