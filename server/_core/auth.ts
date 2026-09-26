import crypto from "node:crypto";
import { ENV } from "./env";

// Single-owner dashboard: one password from DASHBOARD_PASSWORD, one HMAC-signed session cookie.
// The signing key is derived from the password, so changing the password logs every session out.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;

const sessionKey = () => crypto.createHash("sha256").update(`webasi-session:${ENV.dashboardPassword}:${ENV.cookieSecret}`).digest();
const sign = (payload: string) => crypto.createHmac("sha256", sessionKey()).update(payload).digest("hex");
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && crypto.timingSafeEqual(a, b);

export function createSessionToken(now = Date.now()) {
  const expiresAt = String(now + SESSION_TTL_MS);
  return `${expiresAt}.${sign(expiresAt)}`;
}

export function isValidSessionToken(token: string | undefined, now = Date.now()) {
  if (!token || !ENV.dashboardPassword) return false;
  const [expiresAt, signature] = token.split(".");
  if (!expiresAt || !signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return sameBytes(Buffer.from(signature, "hex"), Buffer.from(sign(expiresAt), "hex")) && Number(expiresAt) > now;
}

export function passwordMatches(input: string) {
  if (!ENV.dashboardPassword) return false;
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest();
  return sameBytes(digest(input), digest(ENV.dashboardPassword));
}

// ponytail: in-memory per-IP limiter; resets on restart, fine for a single-instance deployment.
const attempts = new Map<string, { count: number; resetAt: number }>();
export function allowLoginAttempt(ip: string, now = Date.now()) {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) { attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS }); return true; }
  entry.count += 1;
  return entry.count <= MAX_LOGIN_ATTEMPTS;
}
