import type { CookieOptions, Request } from "express";

// Same-origin dashboard: Lax blocks cross-site POSTs (CSRF) and still works on plain-http localhost.
export function getSessionCookieOptions(req: Request): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure"> {
  return { httpOnly: true, path: "/", sameSite: "lax", secure: req.secure };
}
