import { trpc } from "@/lib/trpc";
import { cn, PageHeader } from "@/components/dashboard/shared";
import { MeetingForm, SyncBadge, type MeetingRow } from "@/components/pipeline/MeetingForm";
import { Card, Empty, notify, when } from "@/components/pipeline/kit";
import { addDays, colomboDate, colomboLocalToInstant } from "@shared/time";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (n: number) => String(n).padStart(2, "0");

// The month grid is built by hand (no calendar library): weeks start on Monday, and every cell is a Sri Lanka calendar day.
export function monthCells(month: string) {
  const [year, number] = month.split("-").map(Number);
  const first = `${month}-01`;
  const weekday = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const start = addDays(first, -weekday);
  const total = Math.ceil((weekday + days) / 7) * 7;
  return { start, cells: Array.from({ length: total }, (_, index) => { const date = addDays(start, index); return { date, inMonth: date.slice(0, 7) === month }; }) };
}

export default function CalendarPage() {
  const today = colomboDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const { start, cells } = useMemo(() => monthCells(month), [month]);
  const end = addDays(start, cells.length);
  const utils = trpc.useUtils();
  const meetings = trpc.meetings.list.useQuery({ from: colomboLocalToInstant(`${start}T00:00`).toISOString(), to: colomboLocalToInstant(`${end}T00:00`).toISOString() }, { retry: false, refetchInterval: 60_000 });
  const jobs = trpc.jobs.list.useQuery(undefined, { retry: false });
  const refresh = () => { utils.meetings.list.invalidate(); utils.jobs.list.invalidate(); utils.today.overview.invalidate(); };
  const cancel = trpc.meetings.cancel.useMutation({ ...notify("Meeting cancelled"), onSuccess: refresh });
  const complete = trpc.meetings.complete.useMutation({ ...notify("Marked as done"), onSuccess: refresh });
  const retry = trpc.meetings.retrySync.useMutation({ ...notify("Sync retried"), onSuccess: refresh });
  const [editing, setEditing] = useState<MeetingRow | null>(null);
  const [creating, setCreating] = useState(false);
  const rows = meetings.data ?? [];
  const jobById = new Map((jobs.data ?? []).map((job) => [job.id, job]));
  const byDay = useMemo(() => { const map = new Map<string, typeof rows>(); for (const meeting of rows) { const key = colomboDate(meeting.startsAt); map.set(key, [...(map.get(key) ?? []), meeting]); } return map; }, [rows]);
  const move = (delta: number) => { const [year, number] = month.split("-").map(Number); const date = new Date(Date.UTC(year, number - 1 + delta, 1)); setMonth(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`); };
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const openJobs = (jobs.data ?? []).filter((job) => !["closed", "lost"].includes(job.stage));
  const agenda = rows.filter((meeting) => meeting.status !== "cancelled" && colomboDate(meeting.startsAt) >= today).slice(0, 12);
  const dayMeetings = byDay.get(selected) ?? [];

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9">
      <PageHeader eyebrow="Workspace / Calendar" title="Calendar" description="Your meetings, in Sri Lanka time. Google Calendar sync is optional and never blocks saving."
        action={<button disabled={openJobs.length === 0} onClick={() => setCreating(true)} className="webasi-button-primary" title={openJobs.length === 0 ? "Create a job first." : undefined}><Plus className="h-4 w-4" />Add meeting</button>} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <button onClick={() => move(-1)} aria-label="Previous month" className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#E2E8F0]"><ChevronLeft className="h-4 w-4" /></button>
            <div className="flex items-center gap-2"><h2 className="text-sm font-bold text-[#0F172A]">{label}</h2><button onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }} className="text-[11px] font-semibold text-[#2563FF]">Today</button></div>
            <button onClick={() => move(1)} aria-label="Next month" className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#E2E8F0]"><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div role="grid" aria-label={label} className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-[#E2E8F0] bg-[#E2E8F0] text-center">
            {WEEKDAYS.map((name) => <div key={name} className="bg-[#F8FAFC] py-1.5 text-[10px] font-bold uppercase tracking-[0.06em] text-[#94A3B8]">{name}</div>)}
            {cells.map(({ date, inMonth }) => {
              const items = (byDay.get(date) ?? []).filter((meeting) => meeting.status !== "cancelled");
              return (
                <button key={date} onClick={() => setSelected(date)} role="gridcell" aria-label={`${date}${items.length ? `, ${items.length} meeting${items.length === 1 ? "" : "s"}` : ""}`} aria-selected={selected === date}
                  className={cn("flex min-h-[52px] flex-col items-center gap-1 bg-white px-0.5 py-1.5 text-xs sm:min-h-[78px] sm:items-stretch sm:px-1.5", !inMonth && "bg-[#F8FAFC] text-[#CBD5E1]", selected === date && "ring-2 ring-inset ring-[#2563FF]")}>
                  <span className={cn("mx-auto flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold sm:mx-0", date === today && "bg-[#2563FF] text-white")}>{Number(date.slice(8))}</span>
                  <span className="hidden flex-col gap-0.5 sm:flex">{items.slice(0, 2).map((meeting) => <span key={meeting.id} className="truncate rounded bg-[#EFF6FF] px-1 py-0.5 text-left text-[10px] font-medium text-[#1D4ED8]">{when(meeting.startsAt, { hour: "2-digit", minute: "2-digit" })} {meeting.title}</span>)}{items.length > 2 && <span className="text-left text-[10px] text-[#94A3B8]">+{items.length - 2} more</span>}</span>
                  {items.length > 0 && <span className="flex gap-0.5 sm:hidden">{items.slice(0, 3).map((meeting) => <span key={meeting.id} className="h-1.5 w-1.5 rounded-full bg-[#2563FF]" />)}</span>}
                </button>
              );
            })}
          </div>
        </Card>

        <div className="grid content-start gap-4">
          <Card title={new Date(`${selected}T00:00:00+05:30`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Colombo" })}>
            {dayMeetings.length === 0 ? <Empty>Nothing on this day.</Empty> : (
              <ul className="divide-y divide-[#F1F5F9]">
                {dayMeetings.map((meeting) => {
                  const job = jobById.get(meeting.jobId);
                  return (
                    <li key={meeting.id} className="py-2.5 text-xs">
                      <p className={cn("font-semibold text-[#0F172A]", meeting.status === "cancelled" && "text-[#94A3B8] line-through")}>{when(meeting.startsAt, { hour: "2-digit", minute: "2-digit" })}–{when(meeting.endsAt, { hour: "2-digit", minute: "2-digit" })} · {meeting.title}</p>
                      <p className="text-[#64748B]">{job ? <Link href={`/jobs/${job.id}`} className="text-[#2563FF] hover:underline">{job.clientName}</Link> : "—"}{meeting.locationOrLink && <> · {meeting.locationOrLink}</>}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><span className="rounded-full bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-bold capitalize text-[#475569]">{meeting.status}</span><SyncBadge status={meeting.syncStatus} error={meeting.syncError} /></div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {meeting.status === "scheduled" && <>
                          <button onClick={() => setEditing(meeting)} className="webasi-button-secondary min-h-8 px-2.5">Edit</button>
                          <button onClick={() => complete.mutate({ id: meeting.id })} className="webasi-button-secondary min-h-8 px-2.5">Done</button>
                          <button onClick={() => { if (window.confirm("Cancel this meeting?")) cancel.mutate({ id: meeting.id }); }} className="webasi-button-secondary min-h-8 px-2.5 text-[#B91C1C]">Cancel</button>
                        </>}
                        {meeting.syncStatus === "failed" && <button onClick={() => retry.mutate({ id: meeting.id })} className="webasi-button-secondary min-h-8 px-2.5">Retry sync</button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Coming up">
            {agenda.length === 0 ? <Empty>No upcoming meetings this month.</Empty> : (
              <ul className="divide-y divide-[#F1F5F9]">{agenda.map((meeting) => <li key={meeting.id} className="py-2 text-xs"><button onClick={() => setSelected(colomboDate(meeting.startsAt))} className="text-left"><span className="font-semibold text-[#0F172A]">{when(meeting.startsAt, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span> · {meeting.title}</button></li>)}</ul>
            )}
          </Card>
        </div>
      </div>
      <MeetingForm open={creating || Boolean(editing)} meeting={editing} jobs={openJobs} onClose={() => { setCreating(false); setEditing(null); }} onSaved={refresh} />
    </div>
  );
}
