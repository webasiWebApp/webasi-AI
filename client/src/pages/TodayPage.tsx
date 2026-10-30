import { trpc } from "@/lib/trpc";
import { cn, PageHeader } from "@/components/dashboard/shared";
import { Card, Empty, dayText, formatLkr, when } from "@/components/pipeline/kit";
import { AlarmClock, CalendarDays, CheckCircle2, ListChecks, Repeat, Send, WalletCards } from "lucide-react";
import { Link } from "wouter";

const JobLink = ({ jobId, clientName, jobTitle }: { jobId: string; clientName: string; jobTitle: string }) => (
  <Link href={`/jobs/${jobId}`} className="font-semibold text-[#1D4ED8] hover:underline">{clientName}<span className="font-normal text-[#64748B]"> · {jobTitle}</span></Link>
);
const Row = ({ children }: { children: React.ReactNode }) => <li className="flex flex-col gap-0.5 border-b border-[#F1F5F9] py-2.5 text-xs last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">{children}</li>;

// The one screen for the day: what is booked, what is due, who to chase. Every row opens its job.
export default function TodayPage() {
  const today = trpc.today.overview.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const data = today.data;
  const chase = data ? data.moneyToChase.awaitingAdvance.length + data.moneyToChase.balances.length + data.quotationsWaiting.length : 0;
  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9">
      <PageHeader eyebrow="Workspace / Today" title="Today" description={data ? `${dayText(data.date)} · what is booked, what is due and who to chase.` : "What is booked, what is due and who to chase."} />
      {today.isLoading && <p className="text-xs text-[#94A3B8]">Loading…</p>}
      {today.error && <p className="rounded-lg bg-[#FEF2F2] p-3 text-xs text-[#B91C1C]">{today.error.message}</p>}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Meetings · next 7 days" action={<CalendarDays className="h-4 w-4 text-[#94A3B8]" />}>
            {data.meetings.length === 0 ? <Empty>No meetings booked.</Empty> : (
              <ul>{data.meetings.map((meeting) => (
                <Row key={meeting.id}><span><span className="font-semibold text-[#0F172A]">{when(meeting.startsAt, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span> · {meeting.title}</span><JobLink {...meeting} /></Row>
              ))}</ul>
            )}
          </Card>

          <Card title="Tasks due or overdue" action={<AlarmClock className="h-4 w-4 text-[#94A3B8]" />}>
            {data.tasks.dueOrOverdue.length === 0 ? <Empty>Nothing is due.</Empty> : (
              <ul>{data.tasks.dueOrOverdue.map((task) => (
                <Row key={task.id}><span><span className={cn("font-semibold", task.overdue ? "text-[#B91C1C]" : "text-[#0F172A]")}>{task.overdue ? "Overdue " : "Today "}</span>{task.title}<span className="text-[#94A3B8]"> · {dayText(task.dueDate)}</span></span><JobLink {...task} /></Row>
              ))}</ul>
            )}
          </Card>

          <Card title="Next task of each running job" action={<ListChecks className="h-4 w-4 text-[#94A3B8]" />}>
            {data.tasks.next.length === 0 ? <Empty>No job is running.</Empty> : (
              <ul>{data.tasks.next.map((task) => (
                <Row key={task.id}><span><span className="font-semibold text-[#0F172A]">{task.title}</span><span className="text-[#94A3B8]"> · {task.progress}</span></span><JobLink {...task} /></Row>
              ))}</ul>
            )}
          </Card>

          <Card title={`Money to chase${chase ? ` · ${chase}` : ""}`} action={<WalletCards className="h-4 w-4 text-[#94A3B8]" />}>
            {chase === 0 ? <Empty>Nobody to chase.</Empty> : (
              <ul>
                {data.moneyToChase.awaitingAdvance.map((row) => <Row key={`a-${row.jobId}`}><span><span className="font-semibold text-[#0F172A]">Advance {formatLkr(row.amount)}</span><span className="text-[#94A3B8]"> · approved {row.daysWaiting} day{row.daysWaiting === 1 ? "" : "s"} ago</span></span><JobLink {...row} /></Row>)}
                {data.moneyToChase.balances.map((row) => <Row key={`b-${row.jobId}`}><span><span className="font-semibold text-[#B91C1C]">Balance {formatLkr(row.amount)}</span><span className="text-[#94A3B8]"> · delivered {row.daysWaiting} day{row.daysWaiting === 1 ? "" : "s"} ago</span></span><JobLink {...row} /></Row>)}
                {data.quotationsWaiting.map((row) => <Row key={`q-${row.id}`}><span><span className="font-semibold text-[#0F172A]">Quotation {row.number} · {formatLkr(row.total)}</span><span className="text-[#94A3B8]"> · no answer for {row.daysWaiting} days</span></span><JobLink {...row} /></Row>)}
              </ul>
            )}
          </Card>

          <Card title="Renewals · next 30 days" action={<Repeat className="h-4 w-4 text-[#94A3B8]" />} className="lg:col-span-2">
            {data.renewalsDue.length === 0 ? <Empty>No renewals are due.</Empty> : (
              <ul>{data.renewalsDue.map((renewal) => (
                <Row key={renewal.id}><span><span className="font-semibold capitalize text-[#0F172A]">{renewal.kind} · {formatLkr(renewal.amount)}</span><span className={cn("ml-1", renewal.daysUntil < 0 ? "text-[#B91C1C]" : "text-[#94A3B8]")}>· {renewal.daysUntil < 0 ? `${-renewal.daysUntil} days overdue` : renewal.daysUntil === 0 ? "due today" : `due in ${renewal.daysUntil} days`} ({renewal.status})</span></span><JobLink {...renewal} /></Row>
              ))}</ul>
            )}
          </Card>
        </div>
      )}
      <p className="mt-6 flex items-center gap-1.5 text-[11px] text-[#94A3B8]"><CheckCircle2 className="h-3 w-3" /><Send className="h-3 w-3" />Sends nothing: you send documents yourself on WhatsApp.</p>
    </div>
  );
}
