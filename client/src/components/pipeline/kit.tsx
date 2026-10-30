import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/components/dashboard/shared";
import { STAGE_LABELS, type JobStage } from "@shared/jobs";
import { formatLkr } from "@shared/money";
import { Loader2 } from "lucide-react";
import { type ReactNode } from "react";
import { toast } from "sonner";

export { formatLkr };

const STAGE_TONE: Record<JobStage, string> = {
  lead: "bg-[#F1F5F9] text-[#475569]", meeting: "bg-[#F5F3FF] text-[#6D28D9]", quoted: "bg-[#EFF6FF] text-[#1D4ED8]", approved: "bg-[#ECFEFF] text-[#0E7490]",
  active: "bg-[#F0FDF4] text-[#15803D]", delivered: "bg-[#FFF7ED] text-[#C2410C]", closed: "bg-[#F1F5F9] text-[#334155]", lost: "bg-[#FEF2F2] text-[#B91C1C]",
};
export function StageBadge({ stage }: { stage: JobStage }) {
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em]", STAGE_TONE[stage])}>{STAGE_LABELS[stage]}</span>;
}

export const inputClass = "w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#1E293B] outline-none transition focus:border-[#2563FF] focus:ring-2 focus:ring-[#BFDBFE] disabled:bg-[#F8FAFC] disabled:text-[#94A3B8]";

export function Field({ label, helper, children, className }: { label: string; helper?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">{label}</span>
      {children}
      {helper && <span className="mt-1 block text-[11px] leading-4 text-[#94A3B8]">{helper}</span>}
    </label>
  );
}

export function TextInput({ label, helper, className, ...props }: { label: string; helper?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <Field label={label} helper={helper} className={className}><input {...props} className={inputClass} /></Field>;
}
export function TextArea({ label, helper, className, ...props }: { label: string; helper?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Field label={label} helper={helper} className={className}><textarea {...props} className={cn(inputClass, "leading-6")} /></Field>;
}
export function SelectInput({ label, helper, className, children, ...props }: { label: string; helper?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <Field label={label} helper={helper} className={className}><select {...props} className={inputClass}>{children}</select></Field>;
}

// A dialog that fits a phone: full width with a margin, scrolls inside when the form is long.
export function Modal({ open, onClose, title, description, children, wide }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className={cn("max-h-[90vh] w-[calc(100vw-1.5rem)] overflow-y-auto rounded-2xl p-5 sm:p-6", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <DialogHeader>
          <DialogTitle className="text-base font-bold text-[#0F172A]">{title}</DialogTitle>
          {description && <DialogDescription className="text-xs leading-5 text-[#64748B]">{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function Busy({ on, children }: { on: boolean; children: ReactNode }) {
  return <>{on && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{children}</>;
}

export const Card = ({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={cn("webasi-card min-w-0 p-4 sm:p-5", className)}>
    {(title || action) && <div className="mb-3 flex items-center justify-between gap-3">{title && <h2 className="text-sm font-bold text-[#0F172A]">{title}</h2>}{action}</div>}
    {children}
  </section>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg bg-[#F8FAFC] p-4 text-xs text-[#94A3B8]">{children}</p>;

// The mutation callbacks every action uses: show the server's own sentence on a refusal, a short note on success.
export function notify(success?: string) {
  return {
    onSuccess: () => { if (success) toast.success(success); },
    onError: (error: { message: string }) => toast.error(error.message),
  };
}

export const when = (iso: string | null | undefined, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Colombo", ...options }) : "—");
export const dayText = (date: string | null | undefined) => (date ? new Date(`${date}T00:00:00+05:30`).toLocaleDateString("en-GB", { timeZone: "Asia/Colombo", day: "numeric", month: "short", year: "numeric" }) : "—");

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function ButtonRow({ children }: { children: ReactNode }) { return <div className="flex flex-wrap gap-2">{children}</div>; }

// A cell of numbers on the job page and finance page.
export function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? "text-[#15803D]" : tone === "warn" ? "text-[#C2410C]" : tone === "bad" ? "text-[#B91C1C]" : "text-[#0F172A]";
  return <div className="rounded-xl border border-[#E2E8F0] bg-white p-3"><p className="webasi-label">{label}</p><p className={cn("mt-1 text-lg font-bold tracking-[-0.03em]", color)}>{value}</p></div>;
}
