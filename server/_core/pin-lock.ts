import crypto from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { isCrossSiteWrite, sameSecret } from "./http-guards";

export const SESSION_COOKIE = "webasi_session";
export const SESSION_MS = 7 * 24 * 3_600_000;

// Answer without the PIN: uptime checks, Meta's webhook (it proves itself with a signature) and the lock screen's own calls.
const OPEN_PATHS = ["/health", "/healthz", "/api/keepalive"];
const isOpenPath = (path: string) => OPEN_PATHS.includes(path) || path.startsWith("/api/webhooks/") || path.startsWith("/api/auth/");

// The signature covers the PIN too, so changing DASHBOARD_PIN signs everyone out.
const mac = (secret: string, pin: string, expiresAt: number) => crypto.createHmac("sha256", secret).update(`${expiresAt}:${crypto.createHmac("sha256", secret).update(`pin:${pin}`).digest("hex")}`).digest("hex");

export function signSession(secret: string, pin: string, expiresAt: number) {
  return `${expiresAt}.${mac(secret, pin, expiresAt)}`;
}

export function verifySession(secret: string, pin: string, token: string | undefined, now = Date.now()) {
  if (!token) return false;
  const [expires, signature, ...rest] = token.split(".");
  const expiresAt = Number(expires);
  if (rest.length || !signature || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const expected = Buffer.from(mac(secret, pin, expiresAt));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function cookieFrom(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

/**
 * Wrong-PIN bookkeeping per address. The first few wrong tries are free; from then on every further wrong try locks the
 * address out for twice as long as the last time (a minute, two, four ... up to an hour). A right PIN while locked out
 * is still refused, and a right PIN otherwise clears the record.
 */
export function createPinGuard({ pin, now = Date.now, freeAttempts = 5, baseLockMs = 60_000, maxLockMs = 3_600_000 }: { pin: string; now?: () => number; freeAttempts?: number; baseLockMs?: number; maxLockMs?: number }) {
  const records = new Map<string, { fails: number; lockedUntil: number; lastFailAt: number }>();
  return {
    attempt(key: string, given: string): { ok: true } | { ok: false; retryAfterMs: number } {
      const at = now();
      let record = records.get(key);
      if (record && at - record.lastFailAt > maxLockMs) { records.delete(key); record = undefined; }
      if (record && record.lockedUntil > at) return { ok: false, retryAfterMs: record.lockedUntil - at };
      if (sameSecret(given, pin)) { records.delete(key); return { ok: true }; }
      const fails = (record?.fails ?? 0) + 1;
      const lockMs = fails >= freeAttempts ? Math.min(baseLockMs * 2 ** (fails - freeAttempts), maxLockMs) : 0;
      records.set(key, { fails, lockedUntil: at + lockMs, lastFailAt: at });
      return { ok: false, retryAfterMs: lockMs };
    },
  };
}

export type PinLockOptions = { pin: string; secret: string; production: boolean };

/**
 * The lock screen's server side. With DASHBOARD_PIN set, the API and the document routes need a signed session cookie
 * that POST /api/auth/login hands out for the right PIN. The page itself and its scripts hold no data, so they load
 * and show the PIN screen. Without a PIN, production refuses to serve anything but the open paths.
 */
export function registerPinLock(app: Express, { pin, secret, production }: PinLockOptions) {
  // A development run with no JWT_SECRET still gets working sessions, which end when the process does.
  const key = secret || (production ? "" : crypto.randomBytes(32).toString("hex"));
  const guard = createPinGuard({ pin });
  const authed = (req: Request) => Boolean(pin) && Boolean(key) && verifySession(key, pin, cookieFrom(req, SESSION_COOKIE));
  let warned = false;

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isOpenPath(req.path)) { next(); return; }
    if (production && !pin) { res.status(503).json({ error: "The dashboard is locked until DASHBOARD_PIN is set in the server environment." }); return; }
    if (production && !key) { res.status(503).json({ error: "The dashboard is locked until JWT_SECRET is set in the server environment." }); return; }
    if (!pin) {
      if (!warned) { warned = true; console.warn("[Auth] DASHBOARD_PIN is not set: the dashboard is open. Set it before deploying."); }
      next();
      return;
    }
    if (req.path.startsWith("/api/")) {
      if (!authed(req)) { res.status(401).json({ error: "Locked. Enter the PIN to continue." }); return; }
      if (isCrossSiteWrite(req)) { res.status(403).json({ error: "Cross-site request refused." }); return; }
    }
    next();
  });

  app.get("/api/auth/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ pinRequired: Boolean(pin), authenticated: !pin || authed(req) });
  });

  app.post("/api/auth/login", express.json({ limit: "1kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!pin || !key) { res.status(503).json({ error: "DASHBOARD_PIN is not set." }); return; }
    if (isCrossSiteWrite(req)) { res.status(403).json({ error: "Cross-site request refused." }); return; }
    const given = typeof req.body?.pin === "string" ? req.body.pin : "";
    const result = guard.attempt(req.ip ?? req.socket.remoteAddress ?? "unknown", given);
    if (!result.ok) {
      if (result.retryAfterMs > 0) {
        res.set("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        res.status(429).json({ error: "Too many wrong PINs. Try again later." });
      } else {
        res.status(401).json({ error: "Wrong PIN." });
      }
      return;
    }
    const expiresAt = Date.now() + SESSION_MS;
    res.cookie(SESSION_COOKIE, signSession(key, pin, expiresAt), { httpOnly: true, sameSite: "lax", secure: production, maxAge: SESSION_MS, path: "/" });
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: production, path: "/" });
    res.json({ ok: true });
  });
}
