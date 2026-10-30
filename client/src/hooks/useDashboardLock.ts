import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

export const LOCKED_EVENT = "webasi:locked";
type LockState = "loading" | "locked" | "open";

// Whether the dashboard is showing the PIN screen. The server is the judge: it answers /api/auth/status, and any API
// call it refuses with 401 (an expired session) sends the page back to the lock screen through LOCKED_EVENT.
export function useDashboardLock() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LockState>("loading");
  const [pinRequired, setPinRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/status", { credentials: "include" })
      .then((response) => response.json())
      .then((status: { pinRequired: boolean; authenticated: boolean }) => {
        if (cancelled) return;
        setPinRequired(status.pinRequired);
        setState(status.authenticated ? "open" : "locked");
      })
      // The status check itself failed: show the dashboard and let its own requests report the problem.
      .catch(() => { if (!cancelled) setState("open"); });
    const onLocked = () => { setPinRequired(true); setState("locked"); };
    window.addEventListener(LOCKED_EVENT, onLocked);
    return () => { cancelled = true; window.removeEventListener(LOCKED_EVENT, onLocked); };
  }, []);

  const lock = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    queryClient.clear(); // nothing from this session stays in memory behind the lock screen
    setState("locked");
  }, [queryClient]);

  const unlocked = useCallback(() => { queryClient.clear(); setState("open"); }, [queryClient]);

  return { state, pinRequired, lock, unlocked };
}
