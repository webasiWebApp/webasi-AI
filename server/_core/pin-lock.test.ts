import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppOptions } from "./app";
import { ENV } from "./env";
import { createPinGuard, signSession, verifySession } from "./pin-lock";

ENV.supabaseUrl = "";
ENV.supabaseServiceRoleKey = "";

const PIN = "482915";
const SECRET = "test-session-secret";
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

async function serve(options: AppOptions = {}) {
  const server = createApp({ dashboardPin: PIN, sessionSecret: SECRET, production: false, whatsappTransport: "baileys", ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const login = async (pin = PIN) => {
    const response = await post("/api/auth/login", { pin });
    const cookie = (response.headers.getSetCookie?.()[0] ?? "").split(";")[0];
    return { response, cookie };
  };
  return { base, post, login, get: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers }) };
}

describe("PIN lock", () => {
  it("refuses the API and the document routes without the session cookie, and keeps the uptime checks open", async () => {
    const app = await serve();
    expect((await app.get("/api/trpc/dashboard.conversations")).status).toBe(401);
    expect((await app.get("/api/documents/anything/pdf")).status).toBe(401);
    expect((await app.get("/healthz")).status).toBe(200);
    expect((await app.get("/api/keepalive")).status).toBe(200);
    expect((await app.get("/api/webhooks/whatsapp")).status).toBe(404); // not blocked by the lock: it answers for itself
  });

  it("lets the right PIN in with a httpOnly, SameSite=Lax cookie, and the cookie opens the API", async () => {
    const app = await serve();
    const { response, cookie } = await app.login();
    expect(response.status).toBe(200);
    const header = response.headers.getSetCookie()[0];
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toMatch(/Secure/i); // development over plain http
    expect((await app.get("/api/trpc/dashboard.conversations", { cookie })).status).toBe(200);
    expect(await (await app.get("/api/auth/status", { cookie })).json()).toEqual({ pinRequired: true, authenticated: true });
    expect(await (await app.get("/api/auth/status")).json()).toEqual({ pinRequired: true, authenticated: false });
  });

  it("marks the cookie Secure in production", async () => {
    const app = await serve({ production: true });
    expect((await app.login()).response.headers.getSetCookie()[0]).toMatch(/Secure/i);
  });

  it("refuses a wrong PIN without setting a cookie", async () => {
    const app = await serve();
    const { response } = await app.login("000000");
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("locks an address out after repeated wrong PINs, even for the right one", async () => {
    const app = await serve();
    for (let attempt = 0; attempt < 4; attempt++) expect((await app.login(`wrong-${attempt}`)).response.status).toBe(401);
    const fifth = await app.login("wrong-4");
    expect(fifth.response.status).toBe(429);
    expect(Number(fifth.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await app.login()).response.status).toBe(429);
  });

  it("rejects a tampered, forged or expired cookie", async () => {
    const app = await serve();
    const { cookie } = await app.login();
    const [name, value] = cookie.split("=");
    const [expires, signature] = value.split(".");
    const status = async (token: string) => (await app.get("/api/trpc/dashboard.conversations", { cookie: `${name}=${token}` })).status;
    expect(await status(value)).toBe(200);
    expect(await status(`${Number(expires) + 1000}.${signature}`)).toBe(401);
    expect(await status(`${expires}.${signature.replace(/.$/, signature.endsWith("0") ? "1" : "0")}`)).toBe(401);
    expect(await status("garbage")).toBe(401);
    expect(await status(signSession("another-secret", PIN, Date.now() + 60_000))).toBe(401);
    expect(await status(signSession(SECRET, PIN, Date.now() - 1000))).toBe(401);
  });

  it("signs everyone out when the PIN changes", () => {
    const old = signSession(SECRET, PIN, Date.now() + 60_000);
    expect(verifySession(SECRET, PIN, old)).toBe(true);
    expect(verifySession(SECRET, "999999", old)).toBe(false);
  });

  it("logs out by clearing the cookie", async () => {
    const app = await serve();
    const response = await app.post("/api/auth/logout", {});
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()[0]).toMatch(/webasi_session=;/);
  });

  it("refuses a change submitted from another site even with a valid cookie", async () => {
    const app = await serve();
    const { cookie } = await app.login();
    const response = await app.post("/api/trpc/settings.update", { json: { shadowMode: true } }, { cookie, origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });
});

describe("PIN lock when no PIN is configured", () => {
  it("serves nothing but the health checks in production, with a clear message", async () => {
    const app = await serve({ dashboardPin: "", production: true });
    for (const path of ["/api/trpc/dashboard.conversations", "/"]) {
      const response = await app.get(path);
      expect(response.status, path).toBe(503);
      expect((await response.json()).error).toMatch(/DASHBOARD_PIN/);
    }
    expect((await app.get("/healthz")).status).toBe(200);
    expect((await app.get("/api/keepalive")).status).toBe(200);
  });

  it("refuses in production when there is a PIN but no JWT secret to sign sessions with", async () => {
    const app = await serve({ production: true, sessionSecret: "" });
    const response = await app.get("/api/trpc/dashboard.conversations");
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/JWT_SECRET/);
  });

  it("stays open in development", async () => {
    const app = await serve({ dashboardPin: "" });
    expect((await app.get("/api/trpc/dashboard.conversations")).status).toBe(200);
    expect(await (await app.get("/api/auth/status")).json()).toEqual({ pinRequired: false, authenticated: true });
  });
});

describe("pin guard", () => {
  it("doubles the lockout with each wrong PIN after the free attempts, and forgives after a quiet hour", () => {
    let now = 1_000_000;
    const guard = createPinGuard({ pin: "1234", now: () => now });
    for (let attempt = 0; attempt < 4; attempt++) expect(guard.attempt("ip", "bad")).toEqual({ ok: false, retryAfterMs: 0 });
    expect(guard.attempt("ip", "bad")).toEqual({ ok: false, retryAfterMs: 60_000 });
    now += 60_001;
    expect(guard.attempt("ip", "bad")).toEqual({ ok: false, retryAfterMs: 120_000 });
    now += 120_001;
    expect(guard.attempt("ip", "bad")).toEqual({ ok: false, retryAfterMs: 240_000 });
    now += 3_700_000;
    expect(guard.attempt("ip", "1234")).toEqual({ ok: true });
  });

  it("tracks each address on its own", () => {
    const guard = createPinGuard({ pin: "1234", freeAttempts: 1 });
    expect(guard.attempt("a", "bad").ok).toBe(false);
    expect(guard.attempt("b", "1234")).toEqual({ ok: true });
  });
});
