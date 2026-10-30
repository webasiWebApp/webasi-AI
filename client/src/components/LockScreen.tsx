import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock } from "lucide-react";
import { FormEvent, useState } from "react";

export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
      if (response.ok) { setPin(""); onUnlocked(); return; }
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not unlock. Try again.");
      setPin("");
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-4">
      <form onSubmit={submit} className="w-full max-w-[340px] rounded-2xl border border-[#E2E8F0] bg-white p-6 shadow-[0_12px_30px_rgba(15,23,42,0.08)]">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#EFF6FF] text-[#2563FF]"><Lock className="h-5 w-5" /></div>
          <div>
            <p className="text-[15px] font-bold tracking-[-0.02em] text-[#0F172A]">WEBASI</p>
            <p className="text-xs text-[#64748B]">Enter your PIN to continue</p>
          </div>
        </div>
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          autoFocus
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          aria-label="PIN"
          placeholder="PIN"
          className="h-11 text-center text-lg tracking-[0.3em]"
        />
        {error && <p role="alert" className="mt-3 text-xs text-[#DC2626]">{error}</p>}
        <Button type="submit" disabled={!pin || busy} className="mt-4 h-11 w-full">{busy ? "Checking…" : "Unlock"}</Button>
      </form>
    </main>
  );
}
