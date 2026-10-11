import compression from "compression";
import express, { type Express } from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { registerWhatsAppWebhook } from "../webhooks/whatsapp";
import { ENV } from "./env";
import { checkSupabaseConnection } from "./supabase";
import { dashboardPassword, rateLimit } from "./http-guards";

export type AppOptions = {
  dashboardPassword?: string;
  apiRateLimitPerMinute?: number;
  aiRateLimitPerMinute?: number;
  production?: boolean;
  whatsappTransport?: string;
};

// Dashboard calls that spend an AI request each. They get a smaller allowance than the rest of the API: the bot
// shares the same provider quota, so flooding these would leave real clients without answers.
const AI_PROCEDURES = ["testChat.turn", "projects.regenerateInstantAnswers", "projects.approveTraining"];
const callsAi = (path: string) => decodeURIComponent(path).replace(/^\/+/, "").split(",").some((name) => AI_PROCEDURES.includes(name));

// Everything the dashboard loads is its own, apart from the Inter font from Google Fonts. Inline styles stay allowed
// because the UI components position themselves with style attributes.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Builds the HTTP application: headers, the optional dashboard password, health endpoints and the tRPC API.
 * It starts nothing (no WhatsApp connection, no timers, no listener), so tests can use it as it is.
 */
export function createApp(options: AppOptions = {}): Express {
  const password = options.dashboardPassword ?? ENV.dashboardPassword;
  const production = options.production ?? ENV.isProduction;
  const app = express();

  app.set("trust proxy", 1); // Render terminates TLS; needed for req.secure and req.ip
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      // Without a password the dashboard address is the secret, so it must stay out of search results.
      "X-Robots-Tag": "noindex, nofollow",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    });
    // Development serves the page through Vite, which needs inline scripts and a websocket.
    if (production) {
      res.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
      if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
    }
    next();
  });

  // The scripts, the stylesheet and the conversation lists the dashboard polls are all text that shrinks to about a
  // third. Hosts that already compress at their edge pass this through unchanged.
  app.use(compression());

  if (password) app.use(dashboardPassword(password));

  if ((options.whatsappTransport ?? ENV.whatsappTransport) === "cloud") registerWhatsAppWebhook(app);

  app.get("/api/keepalive", (_req, res) => res.status(200).json({ ok: true, service: "webasi", time: new Date().toISOString() }));
  app.get("/health", async (_req, res) => {
    const supabase = await checkSupabaseConnection();
    const whatsapp = await (async () => {
      // Public endpoint: expose only the connection state, never the QR/pairing code or phone number.
      try { return await import("../whatsapp/baileys").then(async ({ baileysTransport }) => ({ status: (await baileysTransport.getStatus()).status })); }
      catch { return { status: "reconnect_required" }; }
    })();
    const ok = supabase.ok && whatsapp.status !== "reconnect_required";
    res.status(ok ? 200 : 503).json({ ok, service: "webasi", supabase: { ok: supabase.ok }, whatsapp, time: new Date().toISOString() });
  });
  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

  // The dashboard only sends small JSON payloads; a large limit is a free memory-exhaustion vector.
  app.use(express.json({ limit: "100kb" }));

  app.use("/api/trpc", rateLimit({ max: options.apiRateLimitPerMinute ?? ENV.apiRateLimitPerMinute }));
  app.use("/api/trpc", rateLimit({ max: options.aiRateLimitPerMinute ?? ENV.aiRateLimitPerMinute, applies: (req) => callsAi(req.path) }));
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      // Failures the dashboard only shows as a toast are otherwise invisible on the server.
      onError: ({ path, error }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") console.error(`[API] ${path ?? "unknown"} failed:`, error.cause instanceof Error ? error.cause.message : error.message);
      },
    })
  );

  // An unknown API path is an error, not the dashboard page with a 200.
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  return app;
}
