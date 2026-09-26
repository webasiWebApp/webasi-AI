import { useState } from "react";
import { Bot, Loader2, Lock } from "lucide-react";
import { trpc } from "@/lib/trpc";

export default function Login({ configured }: { configured: boolean }) {
  const utils = trpc.useUtils();
  const [password, setPassword] = useState("");
  const login = trpc.auth.login.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (password) login.mutate({ password }); };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-4">
      <form onSubmit={submit} className="webasi-card w-full max-w-sm p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#2563FF] text-white"><Bot className="h-5 w-5" /></div>
          <div><h1 className="text-lg font-bold text-[#0F172A]">WEBASI</h1><p className="text-xs text-[#64748B]">Owner dashboard</p></div>
        </div>
        {configured ? <>
          <label htmlFor="password" className="mb-2 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#64748B]">Password</label>
          <div className="relative">
            <Lock className="absolute left-3 top-3 h-4 w-4 text-[#94A3B8]" />
            <input id="password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#2563FF] focus:ring-2 focus:ring-[#DBEAFE]" />
          </div>
          {login.error && <p role="alert" className="mt-2 text-xs text-[#B91C1C]">{login.error.message}</p>}
          <button type="submit" disabled={!password || login.isPending} className="webasi-button-primary mt-5 w-full">{login.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Log in</button>
        </> : <p role="alert" className="text-sm leading-6 text-[#64748B]">The dashboard is locked. Set <code className="rounded bg-[#F1F5F9] px-1">DASHBOARD_PASSWORD</code> in the server environment and restart it.</p>}
      </form>
    </main>
  );
}
