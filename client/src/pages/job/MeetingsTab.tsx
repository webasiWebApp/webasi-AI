import { trpc } from "@/lib/trpc";
import { MeetingForm, SyncBadge, type MeetingRow } from "@/components/pipeline/MeetingForm";
import { Busy, Card, Empty, notify, when } from "@/components/pipeline/kit";
import type { JobDetail } from "@/pages/JobPage";
import { Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/dashboard/shared";

export function MeetingsTab({ job }: { job: JobDetail }) {
  const utils = trpc.useUtils();
  const meetings = trpc.meetings.list.useQuery({ jobId: job.id }, { retry: false });
  const refresh = () => { utils.meetings.list.invalidate(); utils.jobs.get.invalidate({ id: job.id }); utils.jobs.list.invalidate(); utils.today.overview.invalidate(); };
  const [editing, setEditing] = useState<MeetingRow | null>(null);
  const [creating, setCreating] = useState(false);
  const cancel = trpc.meetings.cancel.useMutation({ ...notify("Meeting cancelled"), onSuccess: refresh });
  const complete = trpc.meetings.complete.useMutation({ ...notify("Marked as done"), onSuccess: refresh });
  const retry = trpc.meetings.retrySync.useMutation({ ...notify("Sync retried"), onSuccess: refresh });
  const closed = job.stage === "lost" || job.stage === "closed";

  return (
    <Card title="Meetings" action={!closed && <button onClick={() => setCreating(true)} className="webasi-button-primary min-h-9"><Plus className="h-3.5 w-3.5" />Add meeting</button>}>
      {meetings.isLoading ? <p className="text-xs text-[#94A3B8]">Loading…</p> : (meetings.data ?? []).length === 0 ? <Empty>No meetings yet.</Empty> : (
        <ul className="divide-y divide-[#F1F5F9]">
          {(meetings.data ?? []).map((meeting) => (
            <li key={meeting.id} className="py-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className={cn("font-semibold text-[#0F172A]", meeting.status === "cancelled" && "text-[#94A3B8] line-through")}>{meeting.title}</p>
                  <p className="text-[#64748B]">{when(meeting.startsAt, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} – {when(meeting.endsAt, { hour: "2-digit", minute: "2-digit" })}{meeting.locationOrLink && <> · {/^https?:\/\//.test(meeting.locationOrLink) ? <a href={meeting.locationOrLink} target="_blank" rel="noreferrer noopener" className="text-[#2563FF] underline">{meeting.locationOrLink}</a> : meeting.locationOrLink}</>}</p>
                </div>
                <div className="flex items-center gap-2"><span className="rounded-full bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-bold capitalize text-[#475569]">{meeting.status}</span><SyncBadge status={meeting.syncStatus} error={meeting.syncError} /></div>
              </div>
              {meeting.notes && <p className="mt-1 whitespace-pre-line text-[#64748B]">{meeting.notes}</p>}
              {meeting.syncStatus === "failed" && <p className="mt-1 text-[11px] text-[#B91C1C]">{meeting.syncError}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {meeting.status === "scheduled" && <>
                  <button onClick={() => setEditing(meeting)} className="webasi-button-secondary min-h-8 px-2.5">Edit</button>
                  <button onClick={() => complete.mutate({ id: meeting.id })} disabled={complete.isPending} className="webasi-button-secondary min-h-8 px-2.5">Mark done</button>
                  <button onClick={() => { if (window.confirm("Cancel this meeting?")) cancel.mutate({ id: meeting.id }); }} disabled={cancel.isPending} className="webasi-button-secondary min-h-8 px-2.5 text-[#B91C1C]">Cancel</button>
                </>}
                {meeting.syncStatus === "failed" && <button onClick={() => retry.mutate({ id: meeting.id })} disabled={retry.isPending} className="webasi-button-secondary min-h-8 px-2.5"><Busy on={retry.isPending}>Retry sync</Busy></button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <MeetingForm open={creating || Boolean(editing)} meeting={editing} jobId={job.id} onClose={() => { setCreating(false); setEditing(null); }} onSaved={refresh} />
    </Card>
  );
}
