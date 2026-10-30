import { trpc } from "@/lib/trpc";
import { Busy, Modal, SelectInput, TextArea, TextInput } from "@/components/pipeline/kit";
import { colomboLocalToInstant, instantToColomboLocal } from "@shared/time";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export type MeetingRow = { id: string; jobId: string; title: string; startsAt: string; endsAt: string; locationOrLink: string; notes: string };

// Times are typed and shown in Sri Lanka time (the datetime-local value is a Colombo wall-clock time), and stored as instants.
export function MeetingForm({ open, onClose, meeting, jobId, jobs, onSaved }: { open: boolean; onClose: () => void; meeting?: MeetingRow | null; jobId?: string; jobs?: Array<{ id: string; clientName: string; title: string }>; onSaved: () => void }) {
  const blank = () => ({ jobId: jobId ?? jobs?.[0]?.id ?? "", title: "", starts: "", ends: "", locationOrLink: "", notes: "" });
  const [form, setForm] = useState(blank);
  useEffect(() => {
    if (!open) return;
    setForm(meeting ? { jobId: meeting.jobId, title: meeting.title, starts: instantToColomboLocal(meeting.startsAt), ends: instantToColomboLocal(meeting.endsAt), locationOrLink: meeting.locationOrLink, notes: meeting.notes } : blank());
  }, [open, meeting?.id]);
  const done = { onSuccess: () => { onSaved(); onClose(); toast.success(meeting ? "Meeting updated" : "Meeting booked"); }, onError: (error: { message: string }) => toast.error(error.message) };
  const create = trpc.meetings.create.useMutation(done);
  const update = trpc.meetings.update.useMutation(done);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const times = { startsAt: colomboLocalToInstant(form.starts).toISOString(), endsAt: colomboLocalToInstant(form.ends).toISOString() };
    if (meeting) update.mutate({ id: meeting.id, title: form.title, ...times, locationOrLink: form.locationOrLink, notes: form.notes });
    else create.mutate({ jobId: form.jobId, title: form.title, ...times, locationOrLink: form.locationOrLink, notes: form.notes });
  };
  const busy = create.isPending || update.isPending;
  return (
    <Modal open={open} onClose={onClose} title={meeting ? "Edit meeting" : "Book a meeting"} description="Times are Sri Lanka time. Paste a Zoom or Meet link into the location if there is one.">
      <form className="mt-2 grid gap-3" onSubmit={submit}>
        {!jobId && !meeting && <SelectInput label="Job" value={form.jobId} onChange={set("jobId")} required>{(jobs ?? []).map((job) => <option key={job.id} value={job.id}>{job.clientName} · {job.title}</option>)}</SelectInput>}
        <TextInput label="Title" value={form.title} onChange={set("title")} required maxLength={200} placeholder="Intro call" />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Starts" type="datetime-local" value={form.starts} onChange={set("starts")} required />
          <TextInput label="Ends" type="datetime-local" value={form.ends} onChange={set("ends")} required min={form.starts || undefined} />
        </div>
        <TextInput label="Location or link" value={form.locationOrLink} onChange={set("locationOrLink")} maxLength={500} />
        <TextArea label="Notes" value={form.notes} onChange={set("notes")} rows={3} maxLength={4000} />
        <button type="submit" disabled={busy || !form.jobId || !form.starts || !form.ends} className="webasi-button-primary"><Busy on={busy}>{meeting ? "Save meeting" : "Book meeting"}</Busy></button>
      </form>
    </Modal>
  );
}

const syncTone: Record<string, string> = { synced: "bg-[#F0FDF4] text-[#15803D]", pending: "bg-[#EFF6FF] text-[#1D4ED8]", failed: "bg-[#FEF2F2] text-[#B91C1C]", not_configured: "bg-[#F1F5F9] text-[#64748B]" };
export const SyncBadge = ({ status, error }: { status: string; error?: string | null }) => (
  <span title={error ?? undefined} className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${syncTone[status] ?? syncTone.not_configured}`}>{status === "not_configured" ? "Calendar only" : status === "synced" ? "On Google" : status === "pending" ? "Syncing" : "Sync failed"}</span>
);
