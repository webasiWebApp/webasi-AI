import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import LockScreen from "./components/LockScreen";
import { useDashboardLock } from "./hooks/useDashboardLock";
import Home from "./pages/Home";

function App() {
  const lock = useDashboardLock();
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster position="bottom-right" />
          {lock.state === "loading" ? <div className="min-h-screen bg-[#F8FAFC]" /> : lock.state === "locked" ? (
            <LockScreen onUnlocked={lock.unlocked} />
          ) : (
            <DashboardLayout onLock={lock.pinRequired ? lock.lock : undefined}>
              <Home />
            </DashboardLayout>
          )}
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
