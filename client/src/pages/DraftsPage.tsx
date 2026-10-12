import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Eye, RefreshCw, Send } from "lucide-react";
import { cn, PageHeader } from "@/components/dashboard/shared";

const failureText: Record<string, string> = {
  draft_not_found: "This draft is no longer waiting.",
  draft_already_handled: "This draft was already sent or discarded.",
  conversation_not_found: "The conversation for this draft no longer exists.",
  whatsapp_usage_hard_stop: "The monthly WhatsApp limit blocked this message.",
  baileys_not_connected: "WhatsApp is not connected.",
  baileys_rate_limited: "Too many messages to this client in the last minute. Try again shortly.",
};

// Replies WEBASI wrote in shadow mode. Nothing here has reached a client: each draft is sent as written, edited
// first, or discarded.
export default function DraftsPage() {
  const draftsQuery = trpc.shadowDrafts.list.useQuery(undefined, { refetchInterval: 15000, retry: false });
  const settingsQuery = trpc.dashboard.settings.useQuery(undefined, { retry: false });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const forget = (id: string) => setEdits(({ [id]: _sent, ...rest }) => rest);
  const send = trpc.shadowDrafts.send.useMutation({
    onSuccess: (result, variables) => {
      draftsQuery.refetch();
      if (result.accepted) { forget(String(variables.id)); toast.success("Reply sent to the client"); }
      else toast.error(failureText[result.reason ?? ""] ?? "The reply could not be sent", { description: result.reason });
    },
    onError: (error) => toast.error(error.message),
  });
  const discard = trpc.shadowDrafts.discard.useMutation({
    onSuccess: (done, variables) => { draftsQuery.refetch(); forget(String(variables.id)); done ? toast.success("Draft discarded") : toast.error(failureText.draft_already_handled); },
    onError: (error) => toast.error(error.message),
  });
  const drafts = draftsQuery.data ?? [];
  const shadowMode = settingsQuery.data?.shadowMode;
  const busy = send.isPending || discard.isPending;

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9">
      <PageHeader
        eyebrow="Workspace / Drafts"
        title="Drafts"
        description="Replies WEBASI wrote in shadow mode. Send one as it is, change the wording first, or discard it."
        action={<button onClick={() => draftsQuery.refetch()} disabled={draftsQuery.isFetching} className="webasi-button-secondary"><RefreshCw className={cn("h-4 w-4", draftsQuery.isFetching && "animate-spin")} />Refresh</button>}
      />

      {shadowMode !== undefined && (
        <div className={cn("mb-5 flex items-start gap-2 rounded-lg p-3 text-[11px] leading-5", shadowMode ? "bg-[#FFF7ED] text-[#9A3412]" : "bg-[#F1F5F9] text-[#475569]")}>
          <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{shadowMode ? "Shadow mode is on: WEBASI writes its replies here and sends nothing itself." : "Shadow mode is off, so WEBASI sends its replies itself. Drafts listed here were written while it was on. Switch it in Settings."}</span>
        </div>
      )}

      <section className="webasi-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E2E8F0] p-5">
          <div>
            <h2 className="text-base font-bold text-[#0F172A]">Waiting for you</h2>
            <p className="mt-1 text-xs text-[#94A3B8]">The newest draft for each client. A newer client message replaces the older draft.</p>
          </div>
          <span className="rounded-full bg-[#EFF6FF] px-2.5 py-1 text-[10px] font-bold text-[#1D4ED8]">{drafts.length} waiting</span>
        </div>

        <div className="divide-y divide-[#F1F5F9]">
          {draftsQuery.isLoading ? (
            <div className="p-6 text-xs text-[#94A3B8]">Loading drafts…</div>
          ) : drafts.length === 0 ? (
            <div className="p-6 text-xs text-[#94A3B8]">No drafts are waiting.</div>
          ) : drafts.map((draft) => {
            const id = String(draft.id);
            const text = edits[id] ?? draft.draft;
            const edited = text.trim() !== draft.draft.trim();
            return (
              <div key={id} className="grid gap-4 p-5 lg:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold text-[#1E293B]">{draft.clientName ?? draft.waId ?? "Client"}<span className="ml-2 text-[10px] font-normal text-[#94A3B8]">{new Date(draft.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span></p>
                  <div className="mt-2 whitespace-pre-line rounded-2xl rounded-bl-md bg-[#2563FF] px-4 py-3 text-sm leading-6 text-white">{draft.clientMessage}<span className="mt-1 block text-[10px] text-blue-100">Client wrote</span></div>
                </div>
                <div>
                  <label className="block">
                    <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">WEBASI's draft{edited ? " · edited" : ""}</span>
                    <textarea value={text} onChange={(event) => setEdits((items) => ({ ...items, [id]: event.target.value }))} rows={5} maxLength={4000} className="w-full rounded-lg border border-[#E2E8F0] bg-white p-3 text-xs leading-5 text-[#1E293B] outline-none focus:border-[#2563FF]" />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => send.mutate({ id: draft.id, ...(edited ? { text: text.trim() } : {}) })} disabled={busy || !text.trim()} className="webasi-button-primary min-h-9 px-3"><Send className="h-3.5 w-3.5" />{send.isPending ? "Sending…" : edited ? "Send edited reply" : "Send as written"}</button>
                    {edited && <button onClick={() => forget(id)} disabled={busy} className="webasi-button-secondary min-h-9 px-3">Undo changes</button>}
                    <button onClick={() => { if (window.confirm("Discard this draft? The client gets no reply from it.")) discard.mutate({ id: draft.id }); }} disabled={busy} className="webasi-button-secondary min-h-9 border-[#FECACA] px-3 text-[#B91C1C] hover:bg-[#FEF2F2]">Discard</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
