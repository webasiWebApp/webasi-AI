import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerWhatsAppWebhook } from "../webhooks/whatsapp";
import { startBaileysTransport } from "../whatsapp/baileys";
import { ENV } from "./env";
import { checkSupabaseConnection } from "./supabase";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.set("trust proxy", 1); // Render terminates TLS; needed for req.secure and req.ip
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({ "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    next();
  });
  if (ENV.whatsappTransport === "cloud") registerWhatsAppWebhook(app);
  startBaileysTransport().catch((error) => console.error("[Baileys] startup failed", error));
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
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
