import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

// Counts events per key in fixed windows. In memory and per process: enough to stop one address from flooding a
// single server, not a distributed limit.
export function createWindowCounter(windowMs: number) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweepAt = 0;
  return {
    // Adds one event for the key and returns the count in its current window, with the time the window ends.
    hit(key: string, now = Date.now()) {
      if (now >= nextSweepAt) {
        // Expired windows are dropped once per window, so the map holds only addresses seen recently.
        windows.forEach((entry, entryKey) => { if (entry.resetAt <= now) windows.delete(entryKey); });
        nextSweepAt = now + windowMs;
      }
      const entry = windows.get(key);
      if (!entry || entry.resetAt <= now) {
        const fresh = { count: 1, resetAt: now + windowMs };
        windows.set(key, fresh);
        return fresh;
      }
      entry.count += 1;
      return entry;
    },
    peek(key: string, now = Date.now()) {
      const entry = windows.get(key);
      return entry && entry.resetAt > now ? entry.count : 0;
    },
    size: () => windows.size,
  };
}

const clientKey = (req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown";

export function rateLimit({ windowMs = 60_000, max, applies = () => true }: { windowMs?: number; max: number; applies?: (req: Request) => boolean }): RequestHandler {
  const counter = createWindowCounter(windowMs);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!applies(req)) { next(); return; }
    const { count, resetAt } = counter.hit(clientKey(req));
    if (count <= max) { next(); return; }
    res.set("Retry-After", String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
    res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
  };
}

export const sameSecret = (given: string, expected: string) => {
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
};

// A browser sends its cookies with any request to the site, including a form another site submits.
// A request that changes something must therefore come from the dashboard's own pages.
export function isCrossSiteWrite(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  const hosts = [req.headers.host, req.headers["x-forwarded-host"]].flat().filter(Boolean);
  try { return !hosts.includes(new URL(origin).host); } catch { return true; }
}
