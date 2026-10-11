import "dotenv/config";
import { createServer } from "http";
import net from "net";
import { createApp } from "./app";
import { serveStatic, setupVite } from "./vite";
import { startBaileysTransport } from "../whatsapp/baileys";
import { startAutomation } from "../automation";

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

export const app = createApp();
export const server = createServer(app);

// On Vercel, long running background processes are not supported.
if (!process.env.VERCEL) {
  startBaileysTransport().catch((error) => console.error("[Baileys] startup failed", error));
  if (process.env.NODE_ENV !== "test") startAutomation();
}

// production mode uses static files
if (process.env.NODE_ENV !== "development") {
  serveStatic(app);
}

async function startServer() {
  // development mode uses Vite
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
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

// Only start the server if we're not in a serverless environment like Vercel
if (!process.env.VERCEL) {
  startServer().catch(console.error);
}
