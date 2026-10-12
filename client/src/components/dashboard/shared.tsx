import { type ReactNode } from "react";
import { Sparkles } from "lucide-react";

export function cn(...classes: Array<string | false | null | undefined>) { return classes.filter(Boolean).join(" "); }

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="webasi-label mb-2">{eyebrow}</p>
        <h1 className="text-[26px] font-bold tracking-[-0.035em] text-[#0F172A] sm:text-[30px]">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[#64748B]">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function StatusDot({ color = "#22C55E" }: { color?: string }) { return <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />; }

export function MetricCard({ label, value, detail, icon: Icon, tone = "blue" }: { label: string; value: string; detail: string; icon: typeof Sparkles; tone?: "blue" | "violet" | "green" | "amber" }) { const colors = { blue: "bg-[#EFF6FF] text-[#2563FF]", violet: "bg-[#F5F3FF] text-[#7C3AED]", green: "bg-[#F0FDF4] text-[#16A34A]", amber: "bg-[#FFF7ED] text-[#F59E0B]" }; return <div className="webasi-card p-4"><div className="flex items-start justify-between"><div><p className="webasi-label">{label}</p><p className="mt-2 text-[26px] font-bold tracking-[-0.05em] text-[#0F172A]">{value}</p><p className="mt-1 text-[11px] text-[#94A3B8]">{detail}</p></div><div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", colors[tone])}><Icon className="h-4 w-4" /></div></div></div>; }
export function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <section className="webasi-card p-5 sm:p-6"><div className="mb-5"><h2 className="text-base font-bold text-[#0F172A]">{title}</h2><p className="mt-1.5 text-xs leading-5 text-[#64748B]">{description}</p></div>{children}</section>; }

const signalTone: Record<string, string> = { high: "bg-[#F0FDF4] text-[#15803D]", medium: "bg-[#EFF6FF] text-[#1D4ED8]", low: "bg-[#F1F5F9] text-[#64748B]", positive: "bg-[#F0FDF4] text-[#15803D]", neutral: "bg-[#F1F5F9] text-[#64748B]", confused: "bg-[#FFF7ED] text-[#C2410C]", frustrated: "bg-[#FEF2F2] text-[#B91C1C]" };
const fieldLabel = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());

// What WEBASI has learned about the client: lead fit, mood, main objection, memory notes and collected details.
export function ClientInsightPanel({ row }: { row: { intentScore?: string | null; sentiment?: string | null; objection?: string | null; language?: string | null; clientNotes?: string; extractedFields?: unknown; needsOwner?: boolean } }) {
  const fields = Object.entries((row.extractedFields ?? {}) as Record<string, string | null>).filter(([, value]) => value);
  const chips = [
    row.intentScore && { label: `${row.intentScore} fit`, tone: signalTone[row.intentScore] },
    row.sentiment && { label: row.sentiment, tone: signalTone[row.sentiment] },
    row.objection && row.objection !== "none" && { label: `objection: ${row.objection.replaceAll("_", " ")}`, tone: "bg-[#FFF7ED] text-[#C2410C]" },
    row.language && { label: row.language, tone: "bg-[#F5F3FF] text-[#7C3AED]" },
    row.needsOwner && { label: "needs you", tone: "bg-[#FEF2F2] text-[#B91C1C]" },
  ].filter(Boolean) as Array<{ label: string; tone: string }>;
  if (!chips.length && !row.clientNotes && !fields.length) return null;
  return <details className="rounded-xl border border-[#E2E8F0] bg-white p-3 text-xs" open>
    <summary className="cursor-pointer select-none font-bold text-[#1E293B]">Client insight</summary>
    {chips.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{chips.map((chip) => <span key={chip.label} className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold capitalize", chip.tone)}>{chip.label}</span>)}</div>}
    {row.clientNotes && <p className="mt-2 whitespace-pre-line leading-5 text-[#475569]">{row.clientNotes}</p>}
    {fields.length > 0 && <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">{fields.map(([key, value]) => <div key={key} className="contents"><dt className="text-[#94A3B8]">{fieldLabel(key)}</dt><dd className="text-[#1E293B]">{value}</dd></div>)}</dl>}
  </details>;
}
