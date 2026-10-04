import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import ConnectWhatsApp from "./ConnectWhatsApp";
import { parseProjectSnapshot, safeEventExportRows, csvCell } from "@shared/webasi";
import {
  AlertCircle,
  ArrowUpRight,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  FileClock,
  FolderKanban,
  Info,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  WalletCards,
  Zap,
} from "lucide-react";

function cn(...classes: Array<string | false | null | undefined>) { return classes.filter(Boolean).join(" "); }

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
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

function StatusDot({ color = "#22C55E" }: { color?: string }) { return <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />; }

function UsageMeter({ label, value, limit, unit, icon: Icon, tone = "blue" }: { label: string; value: number; limit: number; unit: string; icon: typeof MessageCircle; tone?: "blue" | "violet" }) {
  const percent = Math.round((value / limit) * 100);
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5"><div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", tone === "blue" ? "bg-[#EFF6FF] text-[#2563FF]" : "bg-[#F5F3FF] text-[#7C3AED]")}><Icon className="h-4 w-4" /></div><div><p className="text-xs font-semibold text-[#1E293B]">{label}</p><p className="mt-0.5 text-[11px] text-[#94A3B8]">{unit}</p></div></div>
        <span className="text-lg font-bold tracking-[-0.03em] text-[#0F172A]">{value.toLocaleString()}<span className="text-xs font-medium text-[#94A3B8]"> / {limit.toLocaleString()}</span></span>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#F1F5F9]"><div className={cn("h-full rounded-full transition-all", percent >= 70 ? "bg-[#F59E0B]" : tone === "blue" ? "bg-[#2563FF]" : "bg-[#8B5CF6]")} style={{ width: `${percent}%` }} /></div>
      <div className="mt-2 flex items-center justify-between text-[10px] font-medium"><span className={percent >= 70 ? "text-[#D97706]" : "text-[#64748B]"}>{percent}% used</span><span className="text-[#94A3B8]">Resets in 9 days</span></div>
    </div>
  );
}

function HomePage() {
  const [isOn, setIsOn] = useState(true);
  const [, setLocation] = useLocation();
  const overview = trpc.dashboard.overview.useQuery(undefined, { retry: false });
  const whatsappStatus = trpc.whatsapp.status.useQuery(undefined, { refetchInterval: 8000, retry: false });
  const settings = overview.data?.settings;
  const activeProject = overview.data?.activeProject ?? null;
  const snapshot = activeProject ? parseProjectSnapshot(activeProject.snapshot) : null;

  const recentConversations = (overview.data?.conversations ?? []).slice(0, 4).map((row) => {
    const name = row.profileName ?? row.waId;
    const initials = name.split(/\s+/).map((part: string) => part[0]).slice(0, 2).join("").toUpperCase();
    let message = "No message history yet";

    try {
      const parsed = JSON.parse(row.recentMessages ?? "[]") as Array<{ text?: string }>;
      const latest = [...parsed].reverse().find((item) => (item.text ?? "").trim());
      if (latest?.text) message = latest.text;
    } catch {
      message = "No message history yet";
    }

    return {
      name,
      initials,
      message,
      time: row.updatedAt ? new Date(row.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Now",
      state: row.state.replaceAll("_", " "),
      tone: row.isPaused ? "amber" : row.needsOwner ? "purple" : row.state === "confirmed_by_owner" ? "green" : "blue",
      unread: row.needsOwner || row.isPaused,
    };
  });

  const attentionItems = [
    ...((overview.data?.conversations ?? []).filter((row) => row.needsOwner).slice(0, 2).map((row) => ({
      title: `${row.profileName ?? row.waId} needs owner review`,
      detail: "Manual follow-up required before continuing automation.",
      action: "Review",
      icon: AlertCircle,
      tone: "amber",
      path: "/conversations",
    }))),
    ...((overview.data?.orders ?? []).filter((order) => order.state === "awaiting_deposit").slice(0, 2).map((order) => ({
      title: `Deposit pending for ${order.packageName}`,
      detail: `${order.orderKey} is waiting for confirmation.`,
      action: "Verify",
      icon: WalletCards,
      tone: "blue",
      path: "/orders",
    }))),
  ];

  const whatsappLabel = whatsappStatus.data?.status === "connected"
    ? "connected"
    : whatsappStatus.data?.status === "reconnect_required"
      ? "reconnect required"
      : whatsappStatus.data?.status === "disconnected"
        ? "disconnected"
        : "connecting";

  const shadowMode = settings?.shadowMode ?? false;
  const usage = overview.data?.usage ?? { outboundWhatsApp: 0, geminiRequests: 0 };
  const businessName = settings?.businessName?.trim() || "Your business";
  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  })();
  const todayLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());

  const updateSettings = trpc.settings.update.useMutation({
    onSuccess: (ok) => {
      if (!ok) {
        setIsOn(false);
        toast.error("WEBASI cannot turn on without an active approved project");
      }
      overview.refetch();
    },
    onError: (error) => {
      setIsOn((current) => !current);
      toast.error(error.message);
    },
  });

  const updateProvider = trpc.settings.updateProvider.useMutation({
    onSuccess: (res) => {
      toast.success("AI Model switched to " + res.provider);
      overview.refetch();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  useEffect(() => {
    if (settings) setIsOn(settings.webasiEnabled);
  }, [settings?.webasiEnabled]);

  const toggleBot = () => {
    const next = !isOn;
    if (next && !window.confirm(`Enable WEBASI live replies for ${activeProject?.name ?? "the active project"}? Incoming client messages may receive automated responses while WhatsApp is connected. You can turn it off at any time.`)) {
      return;
    }

    setIsOn(next);
    updateSettings.mutate({ webasiEnabled: next });
    toast(next ? "WEBASI is now live" : "WEBASI is off — no messages will be sent", {
      description: next ? "Replies are enabled for the active project." : "Incoming messages will still be logged.",
    });
  };

  const toggleProvider = () => {
    // @ts-ignore
    const next = settings?.aiProvider === "groq" ? "gemini" : "groq";
    if (window.confirm(`Switch AI model to ${next.toUpperCase()}?`)) {
      updateProvider.mutate({ provider: next });
    }
  };

  const activeProjectName = activeProject?.name ?? "No active project";
  const activeProjectStatus = activeProject?.status ? activeProject.status.replaceAll("_", " ") : "Not configured";
  const projectPrice = snapshot?.priceLkr ? `LKR ${snapshot.priceLkr.toLocaleString()}` : activeProject ? "Custom package" : "—";
  const projectDeposit = snapshot?.depositPercent ? `${snapshot.depositPercent}%` : activeProject ? "Varies" : "—";
  const projectTimeline = snapshot?.timelineBusinessDays || "—";
  const projectUpdated = activeProject?.updatedAt ? new Date(activeProject.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "No active project yet";
  const attentionTitle = attentionItems.length ? `${attentionItems.length} item${attentionItems.length === 1 ? "" : "s"} to review` : "No items to review";

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9">
      <div className="mb-7 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="webasi-label mb-2">{todayLabel}</p>
          <h1 className="text-[28px] font-bold tracking-[-0.045em] text-[#0F172A] sm:text-[32px]">{greeting}, {businessName}<span className="text-[#2563FF]">.</span></h1>
          <p className="mt-1.5 text-sm text-[#64748B]">Here’s what’s happening with your WhatsApp sales assistant.</p>
        </div>

        <div className="flex flex-col gap-2 self-start">
          <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 shadow-[0_4px_12px_-8px_rgba(15,23,42,0.25)]">
            <StatusDot color={isOn ? "#22C55E" : "#94A3B8"} />
            <span className="text-xs font-semibold text-[#1E293B]">{isOn ? "WEBASI is live" : "WEBASI is off"}</span>
            <span className="ml-1 text-[11px] text-[#94A3B8]">{isOn ? "Live" : "Replies paused"}</span>
            <span className="h-4 w-px bg-[#E2E8F0]" />
            <StatusDot color={whatsappLabel === "connected" ? "#22C55E" : whatsappLabel === "reconnect required" ? "#DC2626" : "#F59E0B"} />
            <span className={cn("text-[11px] font-semibold", whatsappLabel === "reconnect required" ? "text-[#B91C1C]" : "text-[#64748B]")}>WhatsApp {whatsappLabel}</span>
            <span className="h-4 w-px bg-[#E2E8F0]" />
            {/* @ts-ignore */}
            <button onClick={toggleProvider} disabled={updateProvider.isPending} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-bold uppercase transition hover:bg-[#F1F5F9]">{settings?.aiProvider === "groq" ? "GROQ" : "GEMINI"} <RefreshCw className={cn("h-3 w-3", updateProvider.isPending && "animate-spin")} /></button>
          </div>
        </div>
      </div>

      <section className="webasi-card relative mb-5 overflow-hidden border-[#C7D8FF] bg-white p-5 sm:p-6 lg:p-7">
        <div className="pointer-events-none absolute right-0 top-0 h-full w-1/2 bg-[radial-gradient(circle_at_80%_20%,rgba(37,99,255,0.10),transparent_58%)]" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4 sm:gap-5">
            <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl shadow-[0_8px_18px_-10px_rgba(37,99,255,0.6)]", isOn ? "bg-[#2563FF] text-white" : "bg-[#F1F5F9] text-[#94A3B8]")}>
              <Zap className="h-6 w-6" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold tracking-[-0.025em] text-[#0F172A]">Automation control</h2>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", isOn && !shadowMode ? "bg-[#DCFCE7] text-[#15803D]" : shadowMode ? "bg-[#FFF7ED] text-[#C2410C]" : "bg-[#F1F5F9] text-[#64748B]")}>{!isOn ? "OFF" : shadowMode ? "SHADOW" : "ON"}</span>
              </div>
              <p className="mt-1.5 max-w-xl text-sm leading-6 text-[#64748B]">{!isOn ? "WEBASI is silent. Incoming messages are logged, but no replies will be sent until you turn it back on." : shadowMode ? "WEBASI is drafting grounded replies for review. Shadow mode does not send messages to clients." : "WEBASI is replying to clients using your active project knowledge. You can take over any chat at any time."}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-medium text-[#64748B]">
                <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-[#22C55E]" />{activeProject ? "Active project ready" : "Awaiting project"}</span>
                <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-[#2563FF]" />24-hour window only</span>
                {shadowMode && <span className="inline-flex items-center gap-1.5 text-[#C2410C]"><Eye className="h-3.5 w-3.5" />Drafts only</span>}
              </div>
            </div>
          </div>

          <button onClick={toggleBot} className={cn("relative h-12 w-[104px] shrink-0 rounded-full p-1 transition-colors focus-visible:ring-2 focus-visible:ring-[#2563FF] active:scale-[0.98]", isOn ? "bg-[#2563FF]" : "bg-[#CBD5E1]")} aria-pressed={isOn} aria-label={isOn ? "Turn WEBASI off" : "Turn WEBASI on"}>
            <span className={cn("absolute top-1 flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-[0_3px_7px_rgba(15,23,42,0.18)] transition-transform", isOn ? "translate-x-[52px]" : "translate-x-0")}>{isOn ? <Check className="h-4 w-4 text-[#2563FF]" /> : <Pause className="h-4 w-4 text-[#94A3B8]" />}</span>
            <span className={cn("absolute inset-y-0 flex items-center text-[10px] font-bold uppercase tracking-[0.12em] text-white transition-opacity", isOn ? "left-4 opacity-100" : "left-4 opacity-0")}>On</span>
            <span className={cn("absolute inset-y-0 right-4 flex items-center text-[10px] font-bold uppercase tracking-[0.12em] text-white transition-opacity", isOn ? "opacity-0" : "opacity-100")}>Off</span>
          </button>
        </div>
      </section>

      <div className="mb-5 grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="webasi-card p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <p className="webasi-label mb-2">Active project</p>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold tracking-[-0.025em] text-[#0F172A]">{activeProjectName}</h2>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#DCFCE7] px-2 py-1 text-[10px] font-bold text-[#15803D]"><StatusDot />{activeProjectStatus}</span>
              </div>
            </div>
            <button className="flex h-8 w-8 items-center justify-center rounded-lg text-[#94A3B8] hover:bg-[#F8FAFC] hover:text-[#1E293B]" aria-label="Project options"><MoreHorizontal className="h-4 w-4" /></button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-[#F8FAFC] p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#94A3B8]">Package price</p><p className="mt-2 text-sm font-bold text-[#1E293B]">{projectPrice}</p></div>
            <div className="rounded-xl bg-[#F8FAFC] p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#94A3B8]">Deposit</p><p className="mt-2 text-sm font-bold text-[#1E293B]">{projectDeposit}</p></div>
            <div className="rounded-xl bg-[#F8FAFC] p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#94A3B8]">Timeline</p><p className="mt-2 text-sm font-bold text-[#1E293B]">{projectTimeline}</p></div>
            <div className="rounded-xl bg-[#F8FAFC] p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#94A3B8]">Knowledge</p><p className="mt-2 text-sm font-bold text-[#1E293B]">{activeProject ? `${activeProject.readiness ?? 100}% ready` : "Not configured"}</p></div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#E2E8F0] pt-4">
            <span className="text-[11px] text-[#94A3B8]">{projectUpdated}</span>
            <button onClick={() => setLocation("/projects")} className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563FF] hover:text-[#1D4ED8]">View project <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
        </section>

        <section className="webasi-card p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <p className="webasi-label mb-2">Performance</p>
              <h2 className="text-lg font-bold tracking-[-0.025em] text-[#0F172A]">This month</h2>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EFF6FF] text-[#2563FF]"><TrendingUp className="h-4 w-4" /></div>
          </div>
          <div className="flex items-end gap-4">
            <p className="text-[32px] font-bold leading-none tracking-[-0.06em] text-[#0F172A]">{overview.data?.orders?.length ?? 0}</p>
            <span className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-[#16A34A]"><ArrowUpRight className="h-3.5 w-3.5" />{Math.min(99, Math.max(0, overview.data?.orders?.length ?? 0))}% <span className="font-normal text-[#94A3B8]">live pipeline</span></span>
          </div>
          <div className="mt-5 flex h-12 items-end gap-1.5">
            {[32, 48, 40, 55, 62, 70, 64, 72, 68, 79, 84, 92].map((height, index) => (
              <div key={index} className={cn("flex-1 rounded-t-sm", index === 11 ? "bg-[#2563FF]" : "bg-[#DBEAFE]")} style={{ height: `${height}%` }} />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-[#94A3B8]"><span>{new Date().toLocaleDateString([], { month: "short", day: "numeric" })}</span><span>Now</span></div>
        </section>
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_1fr]">
        <section className="webasi-card p-5 sm:p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="webasi-label mb-2">Usage guard</p>
              <h2 className="text-lg font-bold tracking-[-0.025em] text-[#0F172A]">Free-tier limits</h2>
            </div>
            <button onClick={() => setLocation("/settings")} className="text-[#94A3B8] hover:text-[#2563FF]" aria-label="Usage settings"><Settings2 className="h-4 w-4" /></button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <UsageMeter label="WhatsApp messages" value={usage.outboundWhatsApp} limit={settings?.whatsappMonthlyCap ?? 900} unit="Outbound this month" icon={MessageCircle} />
            <UsageMeter label="Gemini requests" value={usage.geminiRequests} limit={settings?.geminiDailyCap ?? 500} unit="Requests today" icon={Sparkles} tone="violet" />
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-lg bg-[#FFF7ED] p-3 text-[11px] leading-5 text-[#9A3412]">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>You’ll be warned at 70% and automatically paused at 90%. Change caps in Settings.</span>
          </div>
        </section>

        <section className="webasi-card p-5 sm:p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="webasi-label mb-2">Needs your attention</p>
              <h2 className="text-lg font-bold tracking-[-0.025em] text-[#0F172A]">{attentionTitle}</h2>
            </div>
            <Bell className="h-4 w-4 text-[#F59E0B]" />
          </div>

          <div className="space-y-2">
            {attentionItems.length ? attentionItems.map((item) => {
              const Icon = item.icon;
              const colors = item.tone === "blue" ? "bg-[#EFF6FF] text-[#2563FF]" : item.tone === "amber" ? "bg-[#FFF7ED] text-[#F59E0B]" : "bg-[#F5F3FF] text-[#7C3AED]";

              return (
                <button key={item.title} onClick={() => setLocation(item.path)} className="group flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-[#F8FAFC]">
                  <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", colors)}><Icon className="h-4 w-4" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-[#1E293B]">{item.title}</p>
                    <p className="mt-0.5 truncate text-[11px] text-[#94A3B8]">{item.detail}</p>
                  </div>
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-[#2563FF] opacity-0 transition group-hover:opacity-100">{item.action}<ChevronRight className="h-3 w-3" /></span>
                </button>
              );
            }) : <div className="rounded-lg border border-dashed border-[#E2E8F0] px-3 py-4 text-xs text-[#64748B]">Everything looks clear right now.</div>}
          </div>
        </section>
      </div>

      <section className="webasi-card overflow-hidden p-5 sm:p-6">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="webasi-label mb-2">Recent activity</p>
            <h2 className="text-lg font-bold tracking-[-0.025em] text-[#0F172A]">Conversations</h2>
          </div>
          <button onClick={() => setLocation("/conversations")} className="inline-flex items-center gap-1 text-xs font-semibold text-[#2563FF] hover:text-[#1D4ED8]">View all <ChevronRight className="h-3.5 w-3.5" /></button>
        </div>

        <div className="divide-y divide-[#F1F5F9]">
          {recentConversations.length ? recentConversations.map((conversation) => (
            <button key={conversation.name} onClick={() => setLocation("/conversations")} className="flex w-full items-center gap-3 py-3 text-left transition first:pt-0 last:pb-0 hover:bg-[#FAFCFF]">
              <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold", conversation.tone === "blue" ? "bg-[#DBEAFE] text-[#1D4ED8]" : conversation.tone === "amber" ? "bg-[#FFEDD5] text-[#C2410C]" : conversation.tone === "green" ? "bg-[#DCFCE7] text-[#15803D]" : "bg-[#EDE9FE] text-[#6D28D9]")}>{conversation.initials}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-semibold text-[#1E293B]">{conversation.name}</p>
                  {conversation.unread && <span className="h-1.5 w-1.5 rounded-full bg-[#2563FF]" />}
                </div>
                <p className="mt-0.5 truncate text-xs text-[#64748B]">{conversation.message}</p>
              </div>

              <div className="hidden shrink-0 text-right sm:block">
                <p className="text-[10px] text-[#94A3B8]">{conversation.time}</p>
                <span className="mt-1 inline-flex rounded-full bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-medium text-[#64748B]">{conversation.state}</span>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-[#CBD5E1] sm:hidden" />
            </button>
          )) : <div className="p-4 text-xs text-[#64748B]">No recent conversations are available yet.</div>}
        </div>
      </section>
    </div>
  );
}


function ProjectsPage() {
  const [, setLocation] = useLocation();
  const projectsQuery = trpc.dashboard.projects.useQuery(undefined, { retry: false });
  const create = trpc.projects.create.useMutation({ onSuccess: () => { projectsQuery.refetch(); toast.success("Project draft created"); }, onError: (error) => toast.error(error.message) });
  const approve = trpc.projects.approve.useMutation({ onSuccess: () => { projectsQuery.refetch(); toast.success("Project approved"); }, onError: (error) => toast.error(error.message) });
  const activate = trpc.projects.activate.useMutation({ onSuccess: (ok) => { projectsQuery.refetch(); toast(ok ? "Project activated" : "Project is not ready to activate", { description: ok ? "Any previous active project was deactivated." : "Complete training and approve the project first." }); }, onError: (error) => toast.error(error.message) });
  const rows = projectsQuery.data ?? [];
  const createProject = () => { const name = window.prompt("Project name"); if (!name?.trim()) return; const projectKey = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80); create.mutate({ projectKey: `${projectKey}-${Date.now()}`, name: name.trim(), snapshot: JSON.stringify({ name: name.trim(), status: "draft" }) }); };
  const statusLabel = (status: string) => status === "active" ? "Active" : status === "approved" || status === "ready" ? "Ready to activate" : status === "training" ? "Training" : status[0].toUpperCase() + status.slice(1);
  return <div className="mx-auto max-w-[1440px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9"><PageHeader eyebrow="Workspace / Projects" title="Projects" description="Create, train, approve, and activate the service package WEBASI uses to guide clients." action={<button onClick={createProject} disabled={create.isPending} className="webasi-button-primary"><Plus className="h-4 w-4" />New project</button>} /><div className="mb-5 grid gap-4 sm:grid-cols-3"><MetricCard label="Total projects" value={String(rows.length)} detail={`${rows.filter((project) => project.status === "active").length} active`} icon={FolderKanban} /><MetricCard label="Knowledge readiness" value={rows.length ? `${Math.round(rows.reduce((sum, project) => sum + project.readiness, 0) / rows.length)}%` : "0%"} detail="Across all projects" icon={Sparkles} tone="violet" /><MetricCard label="Ready to activate" value={String(rows.filter((project) => project.status === "approved" || project.status === "ready").length)} detail="Approved project versions" icon={CheckCircle2} tone="green" /></div><section className="webasi-card overflow-hidden"><div className="flex items-center justify-between border-b border-[#E2E8F0] p-5"><div><h2 className="text-base font-bold text-[#0F172A]">Your service packages</h2><p className="mt-1 text-xs text-[#94A3B8]">Only one project can be active at a time. Activation requires an approved, ready project.</p></div><button onClick={() => projectsQuery.refetch()} disabled={projectsQuery.isFetching} className="webasi-button-secondary min-h-9 px-3"><RefreshCw className={cn("h-3.5 w-3.5", projectsQuery.isFetching && "animate-spin")} />Refresh</button></div><div className="divide-y divide-[#F1F5F9]">{projectsQuery.isLoading ? <div className="p-6 text-xs text-[#94A3B8]">Loading persisted projects…</div> : rows.length === 0 ? <div className="p-6 text-xs text-[#94A3B8]">No projects yet. Create a draft to begin training.</div> : rows.map((project) => <div key={project.projectKey} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><div className={cn("mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", project.status === "active" ? "bg-[#EFF6FF] text-[#2563FF]" : "bg-[#F8FAFC] text-[#64748B]")}><FolderKanban className="h-4 w-4" /></div><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-[#1E293B]">{project.name}</p><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", project.status === "active" ? "bg-[#DCFCE7] text-[#15803D]" : project.status === "approved" || project.status === "ready" ? "bg-[#EFF6FF] text-[#1D4ED8]" : "bg-[#F1F5F9] text-[#64748B]")}>{statusLabel(project.status)}</span></div><p className="mt-1 text-xs text-[#94A3B8]">Version {project.version} · Updated {new Date(project.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p></div></div><div className="flex items-center gap-4"><div className="hidden text-right sm:block"><p className="text-xs font-bold text-[#1E293B]">{project.readiness}%</p><p className="text-[10px] text-[#94A3B8]">knowledge ready</p></div>{project.status === "active" ? <span className="inline-flex items-center gap-1.5 rounded-full bg-[#DCFCE7] px-2.5 py-1.5 text-[10px] font-bold text-[#15803D]"><CheckCircle2 className="h-3.5 w-3.5" />Active</span> : project.status === "approved" || project.status === "ready" ? <button onClick={() => activate.mutate({ projectKey: project.projectKey })} disabled={activate.isPending} className="webasi-button-primary min-h-9 px-3">Activate</button> : <><button onClick={() => setLocation("/training")} className="webasi-button-secondary min-h-9 px-3">Continue training</button>{project.readiness >= 100 && <button onClick={() => approve.mutate({ projectKey: project.projectKey })} disabled={approve.isPending} className="webasi-button-primary min-h-9 px-3">Approve</button>}</>}<button className="flex h-8 w-8 items-center justify-center rounded-lg text-[#94A3B8] hover:bg-[#F8FAFC]" aria-label="Project options"><MoreHorizontal className="h-4 w-4" /></button></div></div>)}</div></section></div>;
}

function parseConversationMessages(raw: string) {
  try { return JSON.parse(raw) as Array<{ role: string; text: string }>; } catch { return []; }
}

function ConversationsPage() {
  const conversationsQuery = trpc.dashboard.conversations.useQuery(undefined, { refetchInterval: 10000, retry: false });
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "paused" | "needs_owner">("all");
  const pause = trpc.conversations.pause.useMutation({ onSuccess: () => { conversationsQuery.refetch(); toast.success("Conversation taken over", { description: "WEBASI is paused for this chat." }); }, onError: (error) => toast.error(error.message) });
  const resume = trpc.conversations.resume.useMutation({ onSuccess: () => { conversationsQuery.refetch(); toast.success("WEBASI resumed for this chat"); }, onError: (error) => toast.error(error.message) });
  const [ownerDraft, setOwnerDraft] = useState("");
  const ownerMessage = trpc.conversations.ownerMessage.useMutation({ onSuccess: (result) => { if (result.accepted) { setOwnerDraft(""); conversationsQuery.refetch(); toast.success("Message sent", { description: "WEBASI remains paused for this conversation." }); } else toast.error(result.reason === "whatsapp_usage_hard_stop" ? "WhatsApp usage guard blocked this message" : "Message could not be sent"); }, onError: (error) => toast.error(error.message) });
  const rows = conversationsQuery.data ?? [];
  const filtered = rows.filter((row) => (filter === "all" || (filter === "paused" ? Boolean(row.isPaused) : row.needsOwner)) && (!search.trim() || (row.profileName ?? row.waId).toLowerCase().includes(search.toLowerCase()) || row.state.toLowerCase().includes(search.toLowerCase())));
  const selected = filtered.find((row) => row.clientId === selectedClientId) ?? filtered[0] ?? null;
  useEffect(() => { if (selected && selected.clientId !== selectedClientId) setSelectedClientId(selected.clientId); }, [selected?.clientId, selectedClientId]);
  const messages = selected ? parseConversationMessages(selected.recentMessages) : [];
  const initials = (selected?.profileName ?? selected?.waId ?? "?").split(/\\s+/).map((part: string) => part[0]).slice(0, 2).join("").toUpperCase();
  const lastActivity = selected?.updatedAt ? new Date(selected.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "No activity yet";
  const takeoverSelected = () => { if (!selected || selected.isPaused) return; if (window.confirm("Take over this conversation? WEBASI will stop replying until you resume it.")) pause.mutate({ clientId: selected.clientId }); };
  const resumeSelected = () => { if (!selected || !selected.isPaused) return; if (window.confirm("Resume WEBASI automation for this chat?")) resume.mutate({ clientId: selected.clientId }); };
  const sendOwnerMessage = () => { if (!selected || !ownerDraft.trim() || ownerMessage.isPending) return; ownerMessage.mutate({ clientId: selected.clientId, text: ownerDraft.trim() }); };
  return <div className="mx-auto max-w-[1440px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9">
    <PageHeader eyebrow="Workspace / Inbox" title="Conversations" description="Review live WhatsApp chats, see owner takeover state, and resume automation when you are ready." action={<button onClick={() => conversationsQuery.refetch()} className="webasi-button-secondary" disabled={conversationsQuery.isFetching}><RefreshCw className={cn("h-4 w-4", conversationsQuery.isFetching && "animate-spin")} />Refresh</button>} />
    <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <section className="webasi-card overflow-hidden"><div className="border-b border-[#E2E8F0] p-4"><div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-[#94A3B8]" /><input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] pl-9 pr-3 text-xs outline-none focus:border-[#2563FF]" placeholder="Search conversations" /></div><div className="mt-3 flex flex-wrap gap-1.5"><button onClick={() => setFilter("all")} className={cn("rounded-full px-2.5 py-1 text-[10px] font-bold", filter === "all" ? "bg-[#EFF6FF] text-[#1D4ED8]" : "bg-[#F8FAFC] text-[#64748B]")}>All {rows.length}</button><button onClick={() => setFilter("paused")} className={cn("rounded-full px-2.5 py-1 text-[10px] font-semibold", filter === "paused" ? "bg-[#FFF7ED] text-[#C2410C]" : "bg-[#F8FAFC] text-[#64748B]")}>Paused {rows.filter((row) => row.isPaused).length}</button><button onClick={() => setFilter("needs_owner")} className={cn("rounded-full px-2.5 py-1 text-[10px] font-semibold", filter === "needs_owner" ? "bg-[#FEF2F2] text-[#B91C1C]" : "bg-[#F8FAFC] text-[#64748B]")}>Needs owner {rows.filter((row) => row.needsOwner).length}</button></div></div><div className="divide-y divide-[#F1F5F9]">{conversationsQuery.isLoading ? <div className="p-5 text-xs text-[#94A3B8]">Loading live conversations…</div> : filtered.length === 0 ? <div className="p-5 text-xs text-[#94A3B8]">No live conversations match this search.</div> : filtered.map((item) => { const itemInitials = (item.profileName ?? item.waId).split(/\s+/).map((part: string) => part[0]).slice(0, 2).join("").toUpperCase(); return <button key={item.clientId} onClick={() => setSelectedClientId(item.clientId)} className={cn("flex w-full items-start gap-3 p-4 text-left transition", selected?.clientId === item.clientId ? "bg-[#EFF6FF]" : "hover:bg-[#FAFCFF]")}><div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold", item.isPaused ? "bg-[#FFF7ED] text-[#C2410C]" : "bg-[#DBEAFE] text-[#1D4ED8]")}>{itemInitials}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="truncate text-xs font-semibold text-[#1E293B]">{item.profileName ?? item.waId}</p><span className="shrink-0 text-[10px] text-[#94A3B8]">{new Date(item.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div><p className="mt-1 truncate text-[11px] text-[#64748B]">{parseConversationMessages(item.recentMessages).at(-1)?.text ?? "No message content"}</p><span className={cn("mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium", item.isPaused ? "bg-[#FFF7ED] text-[#C2410C]" : "bg-[#F1F5F9] text-[#64748B]")}>{item.isPaused ? "Paused by owner" : item.state.replaceAll("_", " ")}</span>{"intentScore" in item && item.intentScore && <span className={cn("ml-1.5 mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold", item.intentScore === "high" ? "bg-[#F0FDF4] text-[#15803D]" : item.intentScore === "medium" ? "bg-[#EFF6FF] text-[#1D4ED8]" : "bg-[#F1F5F9] text-[#94A3B8]")}>{item.intentScore} fit</span>}</div></button>; })}</div></section>
      <section className="webasi-card flex min-h-[600px] flex-col overflow-hidden">{selected ? <><div className="flex flex-col gap-3 border-b border-[#E2E8F0] p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className={cn("flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold", selected.isPaused ? "bg-[#FFF7ED] text-[#C2410C]" : "bg-[#DBEAFE] text-[#1D4ED8]")}>{initials}</div><div><p className="text-sm font-bold text-[#1E293B]">{selected.profileName ?? selected.waId}</p><p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#64748B]"><StatusDot color={selected.isPaused ? "#F59E0B" : "#22C55E"} />{selected.isPaused ? "Paused by owner" : "WEBASI active"} · {selected.state.replaceAll("_", " ")}</p></div></div><div className="flex items-center gap-2">{selected.isPaused ? <button onClick={resumeSelected} disabled={resume.isPending} className="webasi-button-primary min-h-9 px-3"><Play className="h-3.5 w-3.5" />{resume.isPending ? "Resuming…" : "Resume automation"}</button> : <><span className="inline-flex items-center gap-1.5 rounded-full bg-[#F0FDF4] px-2.5 py-1.5 text-[10px] font-bold text-[#15803D]"><CheckCircle2 className="h-3.5 w-3.5" />Automation active</span><button onClick={takeoverSelected} disabled={pause.isPending} className="webasi-button-secondary min-h-9 px-3"><Pause className="h-3.5 w-3.5" />{pause.isPending ? "Taking over…" : "Take over"}</button></>}</div></div><div className="flex-1 space-y-4 overflow-auto bg-[#F8FAFC] p-4 sm:p-6"><ClientInsightPanel row={selected} />{messages.length === 0 ? <div className="flex h-full items-center justify-center text-xs text-[#94A3B8]">No message history stored yet.</div> : messages.map((message, index) => <div key={"message-" + message.role + "-" + index + "-" + message.text} className={cn("flex", message.role === "assistant" ? "justify-start" : "justify-end")}><div className={cn("max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm", message.role === "assistant" ? "rounded-bl-md border border-[#E2E8F0] bg-white text-[#1E293B]" : message.role === "owner" ? "rounded-br-md bg-[#0F766E] text-white" : "rounded-br-md bg-[#2563FF] text-white")}>{message.text}<span className={cn("mt-1 block text-[10px]", message.role === "assistant" ? "text-[#94A3B8]" : "text-blue-100")}>{message.role === "assistant" ? "WEBASI" : message.role === "owner" ? "You · owner" : "Client"}</span></div></div>)}<div className="flex items-center justify-center gap-2 text-[10px] text-[#94A3B8]"><span className="h-px w-10 bg-[#E2E8F0]" />Last activity {lastActivity}<span className="h-px w-10 bg-[#E2E8F0]" /></div></div><div className="border-t border-[#E2E8F0] bg-white p-4"><div className="flex items-end gap-2 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-2"><textarea value={ownerDraft} onChange={(event) => setOwnerDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendOwnerMessage(); } }} disabled={!selected.isPaused || ownerMessage.isPending} className="min-h-10 flex-1 resize-none bg-transparent px-2 py-1 text-xs leading-5 outline-none" placeholder={selected.isPaused ? "Type an owner reply…" : "Take over this chat to reply"} /><button onClick={sendOwnerMessage} disabled={!selected.isPaused || !ownerDraft.trim() || ownerMessage.isPending} className="webasi-button-primary min-h-9 px-3"><Send className="h-3.5 w-3.5" />{ownerMessage.isPending ? "Sending…" : "Send"}</button></div><p className="mt-2 text-[10px] text-[#94A3B8]">Owner messages send through the linked WhatsApp device and keep WEBASI paused.</p></div></> : <div className="flex flex-1 items-center justify-center p-8 text-sm text-[#64748B]">No live WhatsApp conversations yet.</div>}</section>
    </div>
  </div>;
}

function OrdersPage() {
  const ordersQuery = trpc.dashboard.orders.useQuery(undefined, { refetchInterval: 10000, retry: false });
  const confirm = trpc.orders.confirm.useMutation({ onSuccess: () => { ordersQuery.refetch(); toast.success("Deposit marked as confirmed", { description: "The client order is now ready for fulfillment." }); }, onError: (error) => toast.error(error.message) });
  const rows = ordersQuery.data ?? [];
  const awaiting = rows.filter((order) => order.state === "awaiting_deposit");
  const slips = rows.filter((order) => order.state === "slip_received");
  const confirmed = rows.filter((order) => order.state === "confirmed_by_owner");
  const money = (value: number) => `LKR ${value.toLocaleString()}`;
  const label = (state: string) => state === "awaiting_deposit" ? "Awaiting deposit" : state === "slip_received" ? "Slip received" : state === "confirmed_by_owner" ? "Confirmed by owner" : state.replaceAll("_", " ");
  const confirmOrder = (orderKey: string) => { if (window.confirm("Confirm this deposit only after you have verified the bank transfer and slip?")) confirm.mutate({ orderKey }); };
  return <div className="mx-auto max-w-[1440px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9"><PageHeader eyebrow="Workspace / Orders" title="Orders" description="Track deposits and confirm payments only after you verify the bank transfer manually." action={<button onClick={() => ordersQuery.refetch()} disabled={ordersQuery.isFetching} className="webasi-button-secondary"><RefreshCw className={cn("h-4 w-4", ordersQuery.isFetching && "animate-spin")} />Refresh</button>} /><div className="mb-5 grid gap-4 sm:grid-cols-3"><MetricCard label="Awaiting deposit" value={String(awaiting.length)} detail={`${money(awaiting.reduce((sum, order) => sum + order.depositAmount, 0))} total`} icon={Clock3} tone="amber" /><MetricCard label="Slips to verify" value={String(slips.length)} detail="Needs your review" icon={WalletCards} /><MetricCard label="Confirmed this month" value={String(confirmed.length)} detail={money(confirmed.reduce((sum, order) => sum + order.depositAmount, 0))} icon={CheckCircle2} tone="green" /></div><section className="webasi-card overflow-hidden"><div className="flex flex-col gap-3 border-b border-[#E2E8F0] p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-base font-bold text-[#0F172A]">Order pipeline</h2><p className="mt-1 text-xs text-[#94A3B8]">Every order is tied to a live WhatsApp conversation and active project.</p></div><span className="rounded-full bg-[#EFF6FF] px-2.5 py-1 text-[10px] font-bold text-[#1D4ED8]">All {rows.length}</span></div><div className="hidden grid-cols-[110px_1.3fr_1.3fr_130px_145px_160px] gap-4 border-b border-[#F1F5F9] bg-[#F8FAFC] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[#94A3B8] md:grid"><span>Order</span><span>Client</span><span>Package</span><span>Deposit</span><span>Status</span><span>Created</span></div><div className="divide-y divide-[#F1F5F9]">{ordersQuery.isLoading ? <div className="p-6 text-xs text-[#94A3B8]">Loading persisted orders…</div> : rows.length === 0 ? <div className="p-6 text-xs text-[#94A3B8]">No orders have been created yet.</div> : rows.map((order) => <div key={order.orderKey} className="grid gap-3 p-5 md:grid-cols-[110px_1.3fr_1.3fr_130px_145px_160px] md:items-center md:gap-4"><div><p className="text-xs font-bold text-[#1D4ED8]">{order.orderKey}</p><p className="mt-1 text-[10px] text-[#94A3B8] md:hidden">{new Date(order.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p></div><div><p className="text-xs font-semibold text-[#1E293B]">{order.clientId}</p><p className="mt-1 text-[11px] text-[#94A3B8]">WhatsApp · {order.waId}</p></div><p className="text-xs text-[#64748B]">{order.packageName}</p><p className="text-sm font-bold text-[#1E293B]">{money(order.depositAmount)}</p><div><span className={cn("inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold", order.state === "confirmed_by_owner" ? "bg-[#DCFCE7] text-[#15803D]" : order.state === "slip_received" ? "bg-[#FFF7ED] text-[#C2410C]" : "bg-[#EFF6FF] text-[#1D4ED8]")}>{label(order.state)}</span>{order.state === "slip_received" && <button onClick={() => confirmOrder(order.orderKey)} disabled={confirm.isPending} className="mt-2 block text-[10px] font-bold text-[#2563FF] hover:text-[#1D4ED8]">Verify &amp; confirm</button>}{order.notes && <p className="mt-1 text-[10px] text-[#94A3B8]">{order.notes}</p>}</div><p className="hidden text-[11px] text-[#64748B] md:block">{new Date(order.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p></div>)}</div><div className="flex items-start gap-2 border-t border-[#E2E8F0] bg-[#FFFBEB] p-4 text-[11px] leading-5 text-[#92400E]"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>WEBASI never confirms payment automatically. Only your manual action above changes an order to Confirmed by owner.</span></div></section></div>;
}

function InsightsPage() {
  const insightsQuery = trpc.dashboard.insights.useQuery(undefined, { retry: false });
  const conversationsQuery = trpc.dashboard.conversations.useQuery(undefined, { retry: false });
  const analyze = trpc.insights.analyze.useMutation({ onSuccess: () => { insightsQuery.refetch(); conversationsQuery.refetch(); toast.success("Analysis complete", { description: "Suggestions were generated for review only." }); }, onError: (error) => toast.error(error.message) });
  const approve = trpc.insights.approve.useMutation({ onSuccess: () => { insightsQuery.refetch(); toast.success("Suggestion approved", { description: "Learned answers are added to the active project's FAQs; other suggestions are notes for your training." }); }, onError: (error) => toast.error(error.message) });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const dismiss = trpc.insights.dismiss.useMutation({ onSuccess: () => { insightsQuery.refetch(); toast.success("Suggestion dismissed"); }, onError: (error) => toast.error(error.message) });
  const rows = insightsQuery.data ?? [];
  const conversations = conversationsQuery.data ?? [];
  const messages = conversations.flatMap((row) => { try { return JSON.parse(row.recentMessages) as Array<{ role?: string; text?: string }>; } catch { return []; } });
  const questions = messages.filter((message) => (message.text ?? "").includes("?")).length;
  const escalations = conversations.filter((row) => row.needsOwner).length;
  const singlish = messages.filter((message) => /\b(mata|one|puluwan|kiyada|hari|eka)\b/i.test(message.text ?? "")).length;
  const color = (category: string) => category === "Learned answer" ? "bg-[#F0FDF4] text-[#15803D]" : category === "Handover" ? "bg-[#FEF2F2] text-[#B91C1C]" : category === "Objection" ? "bg-[#FFF7ED] text-[#F59E0B]" : category === "Language" ? "bg-[#F5F3FF] text-[#7C3AED]" : "bg-[#EFF6FF] text-[#2563FF]";
  return <div className="mx-auto max-w-[1440px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9"><PageHeader eyebrow="Workspace / Insights" title="Insights" description="Spot recurring questions and drop-off patterns. Suggestions never change your knowledge automatically." action={<button onClick={() => analyze.mutate()} disabled={analyze.isPending} className="webasi-button-primary"><Sparkles className={cn("h-4 w-4", analyze.isPending && "animate-pulse")} />{analyze.isPending ? "Analyzing…" : "Run analysis"}</button>} /><div className="mb-5 grid gap-4 sm:grid-cols-3"><MetricCard label="Questions analyzed" value={String(questions)} detail={`Last ${conversations.length} conversations`} icon={MessageSquareText} /><MetricCard label="Escalations" value={String(escalations)} detail={conversations.length ? `${Math.round((escalations / conversations.length) * 100)}% of conversations` : "No live conversations"} icon={AlertCircle} tone="amber" /><MetricCard label="Language mix" value={`${Math.max(messages.length - singlish, 0)} / ${singlish}`} detail="English / Singlish markers" icon={TrendingUp} tone="violet" /></div><WeeklySummaryCard /><section className="webasi-card overflow-hidden"><div className="border-b border-[#E2E8F0] p-5"><div className="flex items-center gap-2"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EFF6FF] text-[#2563FF]"><Sparkles className="h-4 w-4" /></div><div><h2 className="text-base font-bold text-[#0F172A]">Suggestions for your project</h2><p className="mt-1 text-xs text-[#94A3B8]">Generated from recent conversations. Review each suggestion before approval.</p></div></div></div><div className="divide-y divide-[#F1F5F9]">{insightsQuery.isLoading ? <div className="p-6 text-xs text-[#94A3B8]">Loading persisted insights…</div> : rows.length === 0 ? <div className="p-6 text-xs text-[#94A3B8]">No suggestions yet. Run analysis to inspect recent conversations.</div> : rows.map((insight) => <div key={insight.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><div className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", color(insight.category))}><MessageSquareText className="h-4 w-4" /></div><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-[#1E293B]">{insight.title}</p><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", color(insight.category))}>{insight.category}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", insight.status === "approved" ? "bg-[#DCFCE7] text-[#15803D]" : "bg-[#F1F5F9] text-[#64748B]")}>{insight.status}</span></div>{insight.category === "Learned answer" && insight.status === "suggested" ? <textarea aria-label="Edit answer before adding it" value={drafts[insight.id] ?? insight.detail} onChange={(event) => setDrafts((items) => ({ ...items, [insight.id]: event.target.value }))} rows={4} className="mt-2 w-full min-w-[260px] rounded-lg border border-[#E2E8F0] bg-white p-2 text-xs leading-5 text-[#1E293B] outline-none focus:border-[#2563FF] sm:min-w-[420px]" /> : <p className="mt-1.5 whitespace-pre-line text-xs text-[#64748B]">{insight.detail}</p>}</div></div><div className="flex shrink-0 gap-2"><button onClick={() => approve.mutate({ id: insight.id, detail: drafts[insight.id] })} disabled={insight.status === "approved" || approve.isPending} className={cn("webasi-button min-h-9 shrink-0 px-3", insight.status === "approved" ? "border border-[#BBF7D0] bg-[#F0FDF4] text-[#15803D]" : "webasi-button-primary")}>{insight.status === "approved" ? <><Check className="h-3.5 w-3.5" />Approved</> : insight.category === "Learned answer" ? "Add to knowledge base" : "Approve"}</button>{insight.status !== "approved" && <button onClick={() => dismiss.mutate({ id: insight.id })} disabled={dismiss.isPending} className="webasi-button-secondary min-h-9 shrink-0 px-3">Dismiss</button>}</div></div>)}</div></section></div>;
}

function SettingsPage() {
  const settingsQuery = trpc.dashboard.settings.useQuery(undefined, { retry: false });
  const whatsappStatus = trpc.whatsapp.status.useQuery(undefined, { refetchInterval: 10000, retry: false });
  const update = trpc.settings.update.useMutation({ onSuccess: (ok) => { settingsQuery.refetch(); if (ok) toast.success("Settings saved"); else toast.error("WEBASI cannot turn on without an active approved project"); }, onError: (error) => toast.error(error.message) });
  const saved = settingsQuery.data;
  const [form, setForm] = useState({ businessName: "", bankDetails: "", notificationEmail: "", whatsappMonthlyCap: "900", geminiDailyCap: "500", webasiEnabled: false, shadowMode: false, followupsEnabled: true, weeklySummaryEnabled: true });
  useEffect(() => { if (saved) setForm({ businessName: saved.businessName, bankDetails: saved.bankDetails, notificationEmail: saved.notificationEmail ?? "", whatsappMonthlyCap: String(saved.whatsappMonthlyCap), geminiDailyCap: String(saved.geminiDailyCap), webasiEnabled: saved.webasiEnabled, shadowMode: saved.shadowMode, followupsEnabled: saved.followupsEnabled, weeklySummaryEnabled: saved.weeklySummaryEnabled }); }, [saved?.followupsEnabled, saved?.weeklySummaryEnabled, saved?.businessName, saved?.bankDetails, saved?.notificationEmail, saved?.whatsappMonthlyCap, saved?.geminiDailyCap, saved?.webasiEnabled, saved?.shadowMode]);
  const setField = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const submit = () => { if (form.webasiEnabled && !saved?.webasiEnabled && !window.confirm("Enable WEBASI live replies? This allows automated responses for the active project while WhatsApp is connected.")) return; update.mutate({ businessName: form.businessName.trim(), bankDetails: form.bankDetails.trim(), notificationEmail: form.notificationEmail.trim() || null, whatsappMonthlyCap: Number(form.whatsappMonthlyCap), geminiDailyCap: Number(form.geminiDailyCap), webasiEnabled: form.webasiEnabled, shadowMode: form.shadowMode, followupsEnabled: form.followupsEnabled, weeklySummaryEnabled: form.weeklySummaryEnabled }); };
  const toggle = (key: "followupsEnabled" | "weeklySummaryEnabled", title: string, on: string, off: string) => <button type="button" aria-pressed={form[key]} onClick={() => setField(key, !form[key])} className={cn("flex items-center justify-between rounded-xl border p-4 text-left", form[key] ? "border-[#BFDBFE] bg-[#EFF6FF]" : "border-[#E2E8F0] bg-white")}><span><span className="block text-xs font-bold text-[#1E293B]">{title}</span><span className="mt-1 block text-[11px] text-[#64748B]">{form[key] ? on : off}</span></span><span className={cn("rounded-full px-2 py-1 text-[10px] font-bold", form[key] ? "bg-[#2563FF] text-white" : "bg-[#F1F5F9] text-[#64748B]")}>{form[key] ? "ON" : "OFF"}</span></button>;
  const input = (label: string, key: "businessName" | "notificationEmail" | "whatsappMonthlyCap" | "geminiDailyCap", helper?: string) => <label className="block"><span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">{label}</span><input value={form[key]} onChange={(event) => setField(key, event.target.value)} type={key.includes("Cap") ? "number" : key === "notificationEmail" ? "email" : "text"} className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#1E293B] outline-none transition focus:border-[#2563FF] focus:ring-2 focus:ring-[#DBEAFE]" />{helper && <span className="mt-1.5 block text-[10px] text-[#94A3B8]">{helper}</span>}</label>;
  return <div className="mx-auto max-w-[1040px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9"><PageHeader eyebrow="Workspace / Settings" title="Settings" description="Control business details, notifications, usage caps, and the safety boundaries for WEBASI." action={<button onClick={submit} disabled={update.isPending || settingsQuery.isLoading} className="webasi-button-primary"><Check className="h-4 w-4" />{update.isPending ? "Saving…" : "Save changes"}</button>} /><div className="space-y-5"><SettingsSection title="Business profile" description="These details are stored in the project database and used for fixed replies and owner notifications."><div className="grid gap-4 sm:grid-cols-2">{input("Business name", "businessName")}{input("Notification email", "notificationEmail", "Used for escalations and payment-slip alerts.")}<div className="block"><span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">WhatsApp connection</span><div className="flex h-10 items-center gap-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-medium text-[#1E293B]"><StatusDot color={whatsappStatus.data?.status === "connected" ? "#22C55E" : "#DC2626"} />{whatsappStatus.data?.status === "connected" ? "Connected via Baileys" : whatsappStatus.data?.status === "reconnect_required" ? "Reconnect required" : "Connection pending"}</div><span className="mt-1.5 block text-[10px] text-[#94A3B8]">Manage pairing from Connect WhatsApp.</span></div><div className="block"><span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">Default language</span><div className="flex h-10 items-center rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-medium text-[#64748B]">English + Singlish · mirrors client style</div></div></div></SettingsSection><SettingsSection title="Payment details" description="Bank details are inserted by code into fixed templates and never sent to the model."><label className="block"><span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">Bank and payment instructions</span><textarea value={form.bankDetails} onChange={(event) => setField("bankDetails", event.target.value)} className="min-h-28 w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-xs leading-5 text-[#1E293B] outline-none focus:border-[#2563FF] focus:ring-2 focus:ring-[#DBEAFE]" placeholder="Bank name, account name, account number, branch, and payment instructions" /></label></SettingsSection><SettingsSection title="Usage guard" description="WEBASI warns at 70% and hard-stops at 90% of each configured cap."><div className="grid gap-4 sm:grid-cols-2">{input("WhatsApp monthly cap", "whatsappMonthlyCap", "Outbound messages per calendar month.")}{input("Gemini daily cap", "geminiDailyCap", "Structured model requests per day.")}</div><div className="mt-4 flex items-start gap-2 rounded-lg bg-[#EFF6FF] p-3 text-[11px] leading-5 text-[#1D4ED8]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>Caps are safety limits for the free tier. WEBASI stays silent when the hard-stop is reached until you override it.</span></div></SettingsSection><SettingsSection title="Automation safety" description="These switches control whether the assistant may send replies and whether drafts are sent to WhatsApp."><div className="grid gap-3 sm:grid-cols-2"><button onClick={() => setField("webasiEnabled", !form.webasiEnabled)} className={cn("flex items-center justify-between rounded-xl border p-4 text-left", form.webasiEnabled ? "border-[#BFDBFE] bg-[#EFF6FF]" : "border-[#E2E8F0] bg-white")}><span><span className="block text-xs font-bold text-[#1E293B]">Automation switch</span><span className="mt-1 block text-[11px] text-[#64748B]">{form.webasiEnabled ? "Replies are enabled" : "Incoming messages are logged only"}</span></span><span className={cn("rounded-full px-2 py-1 text-[10px] font-bold", form.webasiEnabled ? "bg-[#2563FF] text-white" : "bg-[#F1F5F9] text-[#64748B]")}>{form.webasiEnabled ? "ON" : "OFF"}</span></button><button onClick={() => setField("shadowMode", !form.shadowMode)} className={cn("flex items-center justify-between rounded-xl border p-4 text-left", form.shadowMode ? "border-[#FDE68A] bg-[#FFFBEB]" : "border-[#E2E8F0] bg-white")}><span><span className="block text-xs font-bold text-[#1E293B]">Shadow mode</span><span className="mt-1 block text-[11px] text-[#64748B]">{form.shadowMode ? "Draft replies only" : "Normal sending mode"}</span></span><span className={cn("rounded-full px-2 py-1 text-[10px] font-bold", form.shadowMode ? "bg-[#F59E0B] text-white" : "bg-[#F1F5F9] text-[#64748B]")}>{form.shadowMode ? "ON" : "OFF"}</span></button>{toggle("followupsEnabled", "Follow-ups", "One friendly nudge 6–23h after a client goes quiet, 9am–8pm", "No automatic follow-ups")}{toggle("weeklySummaryEnabled", "Weekly summary", "Sent to your WhatsApp every Monday 9am", "No weekly summary")}</div></SettingsSection><SettingsSection title="Keep-alive & system status" description="Render free services sleep after 15 minutes. This endpoint helps reduce cold starts."><div className="flex flex-col gap-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#DCFCE7] text-[#15803D]"><ActivityIcon /></div><div><p className="text-xs font-semibold text-[#1E293B]">Keep-alive endpoint</p><p className="mt-1 text-[11px] text-[#64748B]">Available at /api/keepalive · Render free tier</p></div></div><span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-[#DCFCE7] px-2.5 py-1 text-[10px] font-bold text-[#15803D]"><StatusDot />Operational</span></div></SettingsSection></div></div>;
}

function TrainingPage() {
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

function MetricCard({ label, value, detail, icon: Icon, tone = "blue" }: { label: string; value: string; detail: string; icon: typeof Sparkles; tone?: "blue" | "violet" | "green" | "amber" }) { const colors = { blue: "bg-[#EFF6FF] text-[#2563FF]", violet: "bg-[#F5F3FF] text-[#7C3AED]", green: "bg-[#F0FDF4] text-[#16A34A]", amber: "bg-[#FFF7ED] text-[#F59E0B]" }; return <div className="webasi-card p-4"><div className="flex items-start justify-between"><div><p className="webasi-label">{label}</p><p className="mt-2 text-[26px] font-bold tracking-[-0.05em] text-[#0F172A]">{value}</p><p className="mt-1 text-[11px] text-[#94A3B8]">{detail}</p></div><div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", colors[tone])}><Icon className="h-4 w-4" /></div></div></div>; }
function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <section className="webasi-card p-5 sm:p-6"><div className="mb-5"><h2 className="text-base font-bold text-[#0F172A]">{title}</h2><p className="mt-1.5 text-xs leading-5 text-[#64748B]">{description}</p></div>{children}</section>; }
function Field({ label, value, helper }: { label: string; value: string; helper?: string }) { return <label className="block"><span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">{label}</span><input defaultValue={value} className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#1E293B] outline-none transition focus:border-[#2563FF] focus:ring-2 focus:ring-[#DBEAFE]" />{helper && <span className="mt-1.5 block text-[10px] text-[#94A3B8]">{helper}</span>}</label>; }
function ActivityIcon() { return <span className="relative flex h-4 w-4 items-center justify-center"><span className="absolute h-2.5 w-2.5 rounded-full border-2 border-current" /><span className="absolute h-1 w-1 rounded-full bg-current" /></span>; }

export default function Home() {
  const [location] = useLocation();
  const page = useMemo(() => location || "/", [location]);
  if (page === "/projects") return <ProjectsPage />;
  if (page === "/training") return <TrainingPage />;
  if (page === "/conversations") return <ConversationsPage />;
  if (page === "/orders") return <OrdersPage />;
  if (page === "/insights") return <InsightsPage />;
  if (page === "/settings") return <SettingsPage />;
  if (page === "/test-chat") return <TestChatPage />;
  if (page === "/events") return <EventsPage />;
  if (page === "/connect-whatsapp") return <ConnectWhatsApp />;
  return <HomePage />;
}

function TestChatPage() { const projectsQuery = trpc.dashboard.projects.useQuery(undefined, { retry: false }); const projects = projectsQuery.data ?? []; const [projectKey, setProjectKey] = useState(""); const [messages, setMessages] = useState<Array<{ role: "client" | "assistant"; text: string; instant?: boolean }>>([]); const [draft, setDraft] = useState(""); const [signals, setSignals] = useState<{ intentScore?: string | null; sentiment?: string | null; objection?: string | null; language?: string | null; clientNotes?: string; needsOwner?: boolean }>({}); const turn = trpc.testChat.turn.useMutation({ onSuccess: (reply) => { setMessages((items) => [...items, { role: "assistant", text: reply.reply, instant: reply.answeredFromFaqs }]); setSignals((previous) => ({ intentScore: reply.intentScore, sentiment: reply.sentiment, objection: reply.objection, language: reply.language, clientNotes: reply.clientNotes || previous.clientNotes, needsOwner: reply.needsOwner })); }, onError: (error) => toast.error(error.message) }); useEffect(() => { if (!projectKey && projects[0]) setProjectKey(projects[0].projectKey); }, [projectKey, projects]); const selected = projects.find((project) => project.projectKey === projectKey); const send = () => { const incomingText = draft.trim(); if (!incomingText || !projectKey || turn.isPending) return; const next = [...messages, { role: "client" as const, text: incomingText }]; setMessages(next); setDraft(""); turn.mutate({ projectKey, incomingText, recentMessages: messages.map(({ role, text }) => ({ role, text })), state: "collecting", clientNotes: signals.clientNotes }); }; return <div className="mx-auto max-w-[1100px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9"><PageHeader eyebrow="Workspace / Test Chat" title="Test Chat" description="Play the role of a client against a project snapshot. This sandbox never sends WhatsApp messages, writes conversations, or uses production caps." action={<span className="inline-flex items-center gap-1.5 rounded-full bg-[#F0FDF4] px-3 py-1.5 text-xs font-bold text-[#15803D]"><StatusDot />Sandbox mode</span>} /><div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-[#E2E8F0] bg-white p-3"><span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">Project snapshot</span><select value={projectKey} onChange={(event) => { setProjectKey(event.target.value); setMessages([]); setSignals({}); }} className="h-9 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-bold text-[#1D4ED8]">{projects.map((project) => <option key={project.projectKey} value={project.projectKey}>{project.name} · v{project.version}</option>)}</select><span className="text-[11px] text-[#94A3B8]">No WhatsApp delivery · no usage count</span></div><section className="webasi-card mx-auto flex min-h-[560px] max-w-3xl flex-col overflow-hidden"><div className="flex items-center gap-3 border-b border-[#E2E8F0] p-5"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#2563FF] text-white"><Bot className="h-4 w-4" /></div><div><p className="text-sm font-bold text-[#1E293B]">WEBASI test assistant</p><p className="mt-0.5 text-[11px] text-[#64748B]">Using {selected?.name ?? "selected project"} · grounded sandbox</p></div></div><div className="flex-1 space-y-4 overflow-auto bg-[#F8FAFC] p-5 sm:p-8"><ClientInsightPanel row={signals} />{messages.length === 0 ? <div className="flex h-full min-h-[360px] items-center justify-center text-center text-xs leading-5 text-[#94A3B8]">Start with a client message to test the selected project.<br />Try a greeting, a price question, or a Singlish message.</div> : messages.map((message, index) => <div key={`${message.role}-${index}-${message.text}`} className={cn("flex", message.role === "client" ? "justify-end" : "justify-start")}><div className={cn("max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm", message.role === "client" ? "rounded-br-md bg-[#2563FF] text-white" : "rounded-bl-md border border-[#E2E8F0] bg-white text-[#1E293B]")}>{message.text}<span className={cn("mt-1 block text-[10px]", message.role === "client" ? "text-blue-100" : "text-[#94A3B8]")}>{message.role === "client" ? "You · sandbox" : message.instant ? "WEBASI · instant answer, no AI request" : "WEBASI · sandbox"}</span></div></div>)}</div><div className="border-t border-[#E2E8F0] bg-white p-4"><div className="flex gap-2"><input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && send()} disabled={turn.isPending || !projectKey} className="h-10 flex-1 rounded-lg border border-[#E2E8F0] px-3 text-xs outline-none focus:border-[#2563FF]" placeholder={turn.isPending ? "WEBASI is thinking…" : "Type a client message…"} /><button onClick={send} disabled={turn.isPending || !projectKey} className="webasi-button-primary min-h-10 px-3"><Send className="h-3.5 w-3.5" />{turn.isPending ? "Thinking…" : "Send"}</button></div></div></section></div>; }
function EventsPage() {
  const [filter, setFilter] = useState<"all" | "warning" | "error">("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const eventsQuery = trpc.dashboard.events.useQuery(undefined, { refetchInterval: 10000, retry: false });
  const events = eventsQuery.data ?? [];
  const filtered = filter === "all" ? events : events.filter((event) => event.severity === filter);
  const tone = (severity: string) => severity === "error" ? "bg-[#FEF2F2] text-[#B91C1C]" : severity === "warning" ? "bg-[#FFF7ED] text-[#D97706]" : "bg-[#EFF6FF] text-[#2563FF]";
  const selected = events.find((event) => event.id === selectedId);
  const exportEvents = (format: "csv" | "json") => {
    const safeRows = safeEventExportRows(filtered);
    const csv = ["id,eventType,severity,title,detail,clientId,createdAt", ...safeRows.map((row) => [row.id, row.eventType, row.severity, row.title, row.detail, row.clientId, row.createdAt].map(csvCell).join(","))].join("\n");
    const blob = new Blob([format === "csv" ? csv : JSON.stringify(safeRows, null, 2)], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "webasi-event-log-" + filter + "-" + new Date().toISOString().slice(0, 10) + "." + format; anchor.click(); URL.revokeObjectURL(url); toast.success("Export downloaded", { description: "Exported " + safeRows.length + " filtered event(s) without credentials or session data." });
  };
  return <div className="mx-auto max-w-[1100px] px-4 pb-12 pt-6 sm:px-6 lg:px-8 lg:pt-9"><PageHeader eyebrow="Workspace / Event log" title="Event log" description="A live trace of safety-critical actions, WhatsApp transport events, and escalations." action={<div className="flex flex-wrap gap-2"><button onClick={() => exportEvents("csv")} disabled={!filtered.length} className="webasi-button-secondary"><Download className="h-4 w-4" />CSV</button><button onClick={() => exportEvents("json")} disabled={!filtered.length} className="webasi-button-secondary"><Download className="h-4 w-4" />JSON</button><button onClick={() => eventsQuery.refetch()} disabled={eventsQuery.isFetching} className="webasi-button-secondary"><RefreshCw className={cn("h-4 w-4", eventsQuery.isFetching && "animate-spin")} />Refresh</button></div>} /><section className="webasi-card overflow-hidden"><div className="flex flex-col gap-3 border-b border-[#E2E8F0] p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-base font-bold text-[#0F172A]">System activity</h2><p className="mt-1 text-xs text-[#94A3B8]">Showing the latest 50 persisted events. Select any event for audit details.</p></div><div className="flex gap-1.5"><button onClick={() => setFilter("all")} className={cn("rounded-full px-2.5 py-1 text-[10px] font-bold", filter === "all" ? "bg-[#EFF6FF] text-[#1D4ED8]" : "text-[#64748B] hover:bg-[#F8FAFC]")}>All {events.length}</button><button onClick={() => setFilter("warning")} className={cn("rounded-full px-2.5 py-1 text-[10px] font-bold", filter === "warning" ? "bg-[#FFF7ED] text-[#C2410C]" : "text-[#64748B] hover:bg-[#F8FAFC]")}>Warnings</button><button onClick={() => setFilter("error")} className={cn("rounded-full px-2.5 py-1 text-[10px] font-bold", filter === "error" ? "bg-[#FEF2F2] text-[#B91C1C]" : "text-[#64748B] hover:bg-[#F8FAFC]")}>Errors</button></div></div><div className="divide-y divide-[#F1F5F9]">{eventsQuery.isLoading ? <div className="p-6 text-xs text-[#94A3B8]">Loading persisted events…</div> : filtered.length === 0 ? <div className="p-6 text-xs text-[#94A3B8]">No events match this filter.</div> : filtered.map((event) => <button key={event.id} onClick={() => setSelectedId(event.id)} className={cn("flex w-full gap-3 p-5 text-left transition hover:bg-[#FAFCFF]", selectedId === event.id && "bg-[#EFF6FF]")}><div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", tone(event.severity))}><FileClock className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-[#1E293B]">{event.title}</p><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", tone(event.severity))}>{event.severity}</span></div><p className="mt-1 text-xs text-[#64748B]">{event.detail}</p><p className="mt-2 text-[10px] font-medium text-[#94A3B8]">{new Date(event.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p></div><ChevronRight className={cn("mt-2 h-4 w-4 shrink-0 text-[#CBD5E1] transition-transform", selectedId === event.id && "rotate-90 text-[#2563FF]")} /></button>)}</div></section>{selected && <section className="webasi-card mt-5 border-[#C7D8FF] bg-[#EFF6FF] p-5"><div className="flex items-start justify-between gap-3"><div><p className="webasi-label mb-2 text-[#1D4ED8]">Audit details</p><h2 className="text-base font-bold text-[#0F172A]">{selected.title}</h2></div><button onClick={() => setSelectedId(null)} className="text-xs font-semibold text-[#64748B] hover:text-[#1D4ED8]">Close</button></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-lg border border-[#BFDBFE] bg-white p-3"><p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#94A3B8]">Actor</p><p className="mt-1 text-xs font-semibold text-[#1E293B]">Owner / WEBASI</p></div><div className="rounded-lg border border-[#BFDBFE] bg-white p-3"><p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#94A3B8]">Event type</p><p className="mt-1 text-xs font-semibold text-[#1E293B]">{selected.eventType}</p></div><div className="rounded-lg border border-[#BFDBFE] bg-white p-3"><p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#94A3B8]">Project / client</p><p className="mt-1 text-xs font-semibold text-[#1E293B]">{selected.clientId ?? "Active project"}</p></div></div><p className="mt-4 text-xs leading-5 text-[#1E40AF]">{selected.detail}</p><p className="mt-2 text-[10px] text-[#64748B]">Recorded {new Date(selected.createdAt).toLocaleString([], { dateStyle: "full", timeStyle: "long" })}</p></section>}</div>;
}

const signalTone: Record<string, string> = { high: "bg-[#F0FDF4] text-[#15803D]", medium: "bg-[#EFF6FF] text-[#1D4ED8]", low: "bg-[#F1F5F9] text-[#64748B]", positive: "bg-[#F0FDF4] text-[#15803D]", neutral: "bg-[#F1F5F9] text-[#64748B]", confused: "bg-[#FFF7ED] text-[#C2410C]", frustrated: "bg-[#FEF2F2] text-[#B91C1C]" };
const fieldLabel = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());

// What WEBASI has learned about the client: lead fit, mood, main objection, memory notes and collected details.
function ClientInsightPanel({ row }: { row: { intentScore?: string | null; sentiment?: string | null; objection?: string | null; language?: string | null; clientNotes?: string; extractedFields?: unknown; needsOwner?: boolean } }) {
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

// Preview of the Monday WhatsApp summary, with a manual send.
function WeeklySummaryCard() {
  const summary = trpc.summary.weekly.useQuery(undefined, { retry: false });
  const send = trpc.summary.sendWeekly.useMutation({ onSuccess: ({ delivered }) => delivered ? toast.success("Summary sent to your WhatsApp") : toast.error("Not delivered — is WhatsApp connected?"), onError: (error) => toast.error(error.message) });
  return <section className="webasi-card mb-5 p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><h2 className="text-base font-bold text-[#0F172A]">Weekly summary</h2><p className="mt-1 text-xs text-[#94A3B8]">Last 7 days. Sent automatically to your WhatsApp every Monday at 9am.</p></div>
      <button onClick={() => send.mutate()} disabled={send.isPending || !summary.data?.text} className="webasi-button-secondary min-h-9 shrink-0 px-3"><Send className="h-3.5 w-3.5" />{send.isPending ? "Sending…" : "Send now"}</button>
    </div>
    <p className="mt-4 whitespace-pre-line rounded-lg bg-[#F8FAFC] p-4 text-xs leading-6 text-[#1E293B]">{summary.isLoading ? "Loading…" : summary.data?.text ?? "The weekly summary needs the Supabase database."}</p>
  </section>;
}
