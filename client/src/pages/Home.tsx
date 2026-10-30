import { lazy, Suspense } from "react";
import { useLocation } from "wouter";
import HomePage from "./HomePage";
import JobPage from "./JobPage";

// One file per page. Everything but the landing page is loaded when it is first opened, so a visit downloads the
// code for the pages it actually shows.
const pages = {
  "/today": lazy(() => import("./TodayPage")),
  "/pipeline": lazy(() => import("./PipelinePage")),
  "/calendar": lazy(() => import("./CalendarPage")),
  "/finance": lazy(() => import("./FinancePage")),
  "/projects": lazy(() => import("./ProjectsPage")),
  "/training": lazy(() => import("./TrainingPage")),
  "/test-chat": lazy(() => import("./TestChatPage")),
  "/conversations": lazy(() => import("./ConversationsPage")),
  "/drafts": lazy(() => import("./DraftsPage")),
  "/connect-whatsapp": lazy(() => import("./ConnectWhatsApp")),
  "/orders": lazy(() => import("./OrdersPage")),
  "/insights": lazy(() => import("./InsightsPage")),
  "/settings": lazy(() => import("./SettingsPage")),
  "/events": lazy(() => import("./EventsPage")),
};

export default function Home() {
  const [location] = useLocation();
  if (location.startsWith("/jobs/")) return <JobPage />;
  const Page = pages[location as keyof typeof pages];
  if (!Page) return <HomePage />;
  return <Suspense fallback={<div className="p-8 text-xs text-[#94A3B8]">Loading…</div>}><Page /></Suspense>;
}
