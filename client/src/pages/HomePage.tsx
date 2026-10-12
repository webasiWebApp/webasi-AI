import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { parseProjectSnapshot, usagePercent, usageResetLabel } from "@shared/webasi";
import { AlertCircle, ArrowUpRight, Bell, Check, CheckCircle2, ChevronRight, Eye, Info, MessageCircle, MoreHorizontal, Pause, RefreshCw, Settings2, ShieldCheck, Sparkles, TrendingUp, WalletCards, Zap } from "lucide-react";
import { cn, StatusDot } from "@/components/dashboard/shared";

function UsageMeter({ label, value, limit, unit, resets, icon: Icon, tone = "blue" }: { label: string; value: number; limit: number; unit: string; resets: string; icon: typeof MessageCircle; tone?: "blue" | "violet" }) {
  const percent = usagePercent(value, limit);
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5"><div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", tone === "blue" ? "bg-[#EFF6FF] text-[#2563FF]" : "bg-[#F5F3FF] text-[#7C3AED]")}><Icon className="h-4 w-4" /></div><div><p className="text-xs font-semibold text-[#1E293B]">{label}</p><p className="mt-0.5 text-[11px] text-[#94A3B8]">{unit}</p></div></div>
        <span className="text-lg font-bold tracking-[-0.03em] text-[#0F172A]">{value.toLocaleString()}<span className="text-xs font-medium text-[#94A3B8]"> / {limit.toLocaleString()}</span></span>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#F1F5F9]"><div className={cn("h-full rounded-full transition-all", percent >= 70 ? "bg-[#F59E0B]" : tone === "blue" ? "bg-[#2563FF]" : "bg-[#8B5CF6]")} style={{ width: `${percent}%` }} /></div>
      <div className="mt-2 flex items-center justify-between text-[10px] font-medium"><span className={percent >= 70 ? "text-[#D97706]" : "text-[#64748B]"}>{percent}% used</span><span className="text-[#94A3B8]">{resets}</span></div>
    </div>
  );
}

export default function HomePage() {
  const [isOn, setIsOn] = useState(false);
  const [, setLocation] = useLocation();
  const overview = trpc.dashboard.overview.useQuery(undefined, { retry: false });
  const whatsappStatus = trpc.whatsapp.status.useQuery(undefined, { refetchInterval: 8000, retry: false });
  const settings = overview.data?.settings;
  const statusKnown = Boolean(settings);
  const activeProject = overview.data?.activeProject ?? null;
  const snapshot = activeProject ? parseProjectSnapshot(activeProject.snapshot) : null;

  const recentConversations = (overview.data?.conversations ?? []).slice(0, 4).map((row) => {
    const name = row.profileName ?? row.waId;
    const initials = name.split(/\s+/).map((part: string) => part[0]).slice(0, 2).join("").toUpperCase();
    const message: string = row.lastMessage?.text || "No message history yet";

    return {
      id: row.clientId as string,
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
            <StatusDot color={statusKnown && isOn ? "#22C55E" : "#94A3B8"} />
            <span className="text-xs font-semibold text-[#1E293B]">{!statusKnown ? (overview.isError ? "Status unavailable" : "Checking status…") : isOn ? "WEBASI is live" : "WEBASI is off"}</span>
            <span className="ml-1 text-[11px] text-[#94A3B8]">{!statusKnown ? "" : isOn ? "Live" : "Replies paused"}</span>
            <span className="h-4 w-px bg-[#E2E8F0]" />
            <StatusDot color={whatsappLabel === "connected" ? "#22C55E" : whatsappLabel === "reconnect required" ? "#DC2626" : "#F59E0B"} />
            <span className={cn("text-[11px] font-semibold", whatsappLabel === "reconnect required" ? "text-[#B91C1C]" : "text-[#64748B]")}>WhatsApp {whatsappLabel}</span>
            <span className="h-4 w-px bg-[#E2E8F0]" />
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

          <button onClick={toggleBot} disabled={!statusKnown || updateSettings.isPending} className={cn("relative h-12 w-[104px] shrink-0 rounded-full p-1 transition-colors focus-visible:ring-2 focus-visible:ring-[#2563FF] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60", isOn ? "bg-[#2563FF]" : "bg-[#CBD5E1]")} aria-pressed={isOn} aria-label={isOn ? "Turn WEBASI off" : "Turn WEBASI on"}>
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
            <UsageMeter label="WhatsApp messages" value={usage.outboundWhatsApp} limit={settings?.whatsappMonthlyCap ?? 900} unit="Outbound this month" resets={usageResetLabel("month")} icon={MessageCircle} />
            <UsageMeter label="Gemini requests" value={usage.geminiRequests} limit={settings?.geminiDailyCap ?? 500} unit="Requests today" resets={usageResetLabel("day")} icon={Sparkles} tone="violet" />
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
            {attentionItems.length ? attentionItems.map((item, index) => {
              const Icon = item.icon;
              const colors = item.tone === "blue" ? "bg-[#EFF6FF] text-[#2563FF]" : item.tone === "amber" ? "bg-[#FFF7ED] text-[#F59E0B]" : "bg-[#F5F3FF] text-[#7C3AED]";

              return (
                <button key={item.path + "-" + index} onClick={() => setLocation(item.path)} className="group flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-[#F8FAFC]">
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
            <button key={conversation.id} onClick={() => setLocation("/conversations")} className="flex w-full items-center gap-3 py-3 text-left transition first:pt-0 last:pb-0 hover:bg-[#FAFCFF]">
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
