import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Activity,
  BarChart3,
  Bot,
  CalendarDays,
  CalendarCheck,
  Kanban,
  Wallet,
  FileClock,
  FolderKanban,
  LayoutDashboard,
  MessageCircle,
  MessagesSquare,
  Smartphone,
  PackageCheck,
  Settings,
  Sparkles,
  LockKeyhole,
  PanelLeft,
  UserRound,
} from "lucide-react";
import { useLocation } from "wouter";
import { CSSProperties, useEffect, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useIsMobile } from "@/hooks/useMobile";

const menuItems = [
  { icon: LayoutDashboard, label: "Home", path: "/" },
  { icon: CalendarCheck, label: "Today", path: "/today" },
  { icon: Kanban, label: "Pipeline", path: "/pipeline" },
  { icon: CalendarDays, label: "Calendar", path: "/calendar" },
  { icon: Wallet, label: "Finance", path: "/finance" },
  { icon: FolderKanban, label: "Projects", path: "/projects" },
  { icon: Sparkles, label: "Training", path: "/training" },
  { icon: Bot, label: "Test Chat", path: "/test-chat" },
  { icon: MessagesSquare, label: "Conversations", path: "/conversations" },
  { icon: MessageCircle, label: "Drafts", path: "/drafts" },
  { icon: Smartphone, label: "Connect WhatsApp", path: "/connect-whatsapp" },
  { icon: PackageCheck, label: "Orders", path: "/orders" },
  { icon: BarChart3, label: "Insights", path: "/insights" },
  { icon: Settings, label: "Settings", path: "/settings" },
  { icon: FileClock, label: "Event Log", path: "/events" },
];

const SIDEBAR_WIDTH_KEY = "webasi-sidebar-width";

export default function DashboardLayout({ children, onLock }: { children: React.ReactNode; onLock?: () => void }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : 248;
  });

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <DashboardLayoutContent onLock={onLock}>{children}</DashboardLayoutContent>
    </SidebarProvider>
  );
}

function DashboardLayoutContent({ children, onLock }: { children: React.ReactNode; onLock?: () => void }) {
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isMobile = useIsMobile();
  const activeMenuItem = menuItems.find((item) => item.path === location) ?? menuItems[0];
  void activeMenuItem;
  const displayName = "WEBASI owner";
  const displayEmail = "Local workspace";
  const initials = displayName.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();

  return (
    <>
      <Sidebar collapsible="icon" className="border-r border-[#E2E8F0] bg-white">
        <SidebarHeader className="h-[76px] border-b border-[#E2E8F0] px-4">
          <div className="flex h-full items-center gap-3">
            <button
              onClick={toggleSidebar}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#EFF6FF] text-[#2563FF] transition hover:bg-[#DBEAFE] active:scale-[0.97]"
              aria-label="Toggle navigation"
            >
              <PanelLeft className="h-[18px] w-[18px]" />
            </button>
            <div className="flex min-w-0 items-center gap-2.5 group-data-[collapsible=icon]:hidden">
              <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#2563FF] text-sm font-bold text-white shadow-[0_4px_10px_rgba(37,99,255,0.28)]">W</div>
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold tracking-[-0.02em] text-[#0F172A]">WEBASI</p>
                <p className="truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94A3B8]">Sales assistant</p>
              </div>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent className="px-3 py-5">
          <p className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8] group-data-[collapsible=icon]:hidden">Workspace</p>
          <SidebarMenu className="gap-1">
            {menuItems.map((item) => {
              const isActive = location === item.path || (item.path === "/pipeline" && location.startsWith("/jobs/"));
              return (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => setLocation(item.path)}
                    tooltip={item.label}
                    className={`h-10 rounded-[10px] px-3 text-[13px] font-medium transition-all ${isActive ? "bg-[#EFF6FF] text-[#1D4ED8] shadow-[inset_3px_0_0_#2563FF]" : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]"}`}
                  >
                    <item.icon className={`h-[17px] w-[17px] shrink-0 ${isActive ? "text-[#2563FF]" : "text-[#94A3B8]"}`} />
                    <span className="flex-1">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter className="border-t border-[#E2E8F0] p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-[#F8FAFC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563FF] group-data-[collapsible=icon]:justify-center">
                <Avatar className="h-8 w-8 shrink-0 border border-[#DBEAFE] bg-[#EFF6FF]"><AvatarFallback className="bg-[#EFF6FF] text-[11px] font-bold text-[#1D4ED8]">{initials}</AvatarFallback></Avatar>
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-xs font-semibold text-[#1E293B]">{displayName}</p>
                  <p className="truncate text-[10px] text-[#94A3B8]">{displayEmail}</p>
                </div>
                <UserRound className="h-4 w-4 text-[#CBD5E1] group-data-[collapsible=icon]:hidden" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-52 rounded-xl border-[#E2E8F0] p-1.5 shadow-[0_12px_30px_rgba(15,23,42,0.12)]">
              <DropdownMenuItem onClick={() => setLocation("/settings")} className="cursor-pointer rounded-lg text-xs"><Settings className="mr-2 h-3.5 w-3.5" />Workspace settings</DropdownMenuItem>
              {onLock && <DropdownMenuItem onClick={onLock} className="cursor-pointer rounded-lg text-xs"><LockKeyhole className="mr-2 h-3.5 w-3.5" />Lock dashboard</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-w-0 bg-[#F8FAFC]">
        {isMobile && (
          <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[#E2E8F0] bg-white/95 px-4 backdrop-blur">
            <div className="flex items-center gap-3"><SidebarTrigger className="h-9 w-9 rounded-lg border border-[#E2E8F0] bg-white" /><div className="flex items-center gap-2"><div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#2563FF] text-[10px] font-bold text-white">W</div><span className="text-sm font-bold tracking-[-0.02em] text-[#0F172A]">WEBASI</span></div></div>
            <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#22C55E]" /><span className="text-[11px] font-medium text-[#64748B]">Live</span>{onLock && <button onClick={onLock} aria-label="Lock dashboard" className="ml-2 flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2E8F0] text-[#64748B]"><LockKeyhole className="h-4 w-4" /></button>}</div>
          </div>
        )}
        <main className="min-h-screen">{children}</main>
      </SidebarInset>
    </>
  );
}
