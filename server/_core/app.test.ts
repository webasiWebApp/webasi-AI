import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppOptions } from "./app";
import { ENV } from "./env";

// The HTTP layer on a local port, with no database configured: the API answers with its empty defaults and nothing
// leaves this machine.
ENV.supabaseUrl = "";
ENV.supabaseServiceRoleKey = "";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

async function serve(options: AppOptions = {}) {
  const server = createApp({ dashboardPin: "", production: false, whatsappTransport: "baileys", ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    get: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers }),
    mutate: (procedure: string, input: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/trpc/${procedure}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ json: input }) }),
  };
}

describe("HTTP hardening", () => {
  it("sends the security headers and keeps the dashboard out of search engines", async () => {
    const response = await (await serve()).get("/healthz");
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({ "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-robots-tag": "noindex, nofollow" });
    expect(response.headers.has("x-powered-by")).toBe(false);
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("adds a content security policy in production, and HSTS only over HTTPS", async () => {
    const app = await serve({ production: true });
    const plain = await app.get("/healthz");
    expect(plain.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(plain.headers.has("strict-transport-security")).toBe(false);
    expect((await app.get("/healthz", { "x-forwarded-proto": "https" })).headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("answers an unknown API path with a 404, not with the dashboard page", async () => {
    const response = await (await serve()).get("/api/webhooks/whatsapp");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("compresses larger responses for clients that accept it", async () => {
    const app = await serve();
    const calls = Array.from({ length: 12 }, () => "projects.training").join(",");
    const input = encodeURIComponent(JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index, { json: { projectKey: `project-${index}` } }]))));
    const response = await app.get(`/api/trpc/${calls}?batch=1&input=${input}`, { "accept-encoding": "gzip" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await response.json()).toHaveLength(12);
    expect((await app.get("/healthz", { "accept-encoding": "gzip" })).headers.has("content-encoding")).toBe(false); // too small to be worth it
  });

  it("reports health without exposing the QR code or phone number", async () => {
    const response = await (await serve()).get("/health");
    const body = await response.json();
    expect(response.status).toBe(503); // no database configured here
    expect(Object.keys(body).sort()).toEqual(["ok", "service", "supabase", "time", "whatsapp"]);
    expect(Object.keys(body.whatsapp)).toEqual(["status"]);
  });
});

describe("API input validation", () => {
  it("serves empty defaults when no database is configured", async () => {
    const response = await (await serve()).get("/api/trpc/dashboard.conversations");
    expect(response.status).toBe(200);
    expect((await response.json()).result.data.json).toEqual([]);
  });

  it.each([
    ["settings.update", { whatsappMonthlyCap: 0 }],
    ["settings.update", { notificationEmail: "not-an-email" }],
    ["settings.updateProvider", { provider: "openai" }],
    ["projects.create", { projectKey: "../etc", name: "Site", snapshot: "{}" }],
    ["projects.create", { projectKey: "site-1", name: "Site", snapshot: "not json" }],
    ["projects.create", { projectKey: "site-1", name: "Site", snapshot: "[1,2]" }],
    ["conversations.ownerMessage", { clientId: "c1", text: "   " }],
    ["conversations.ownerMessage", { clientId: "c1", text: "x".repeat(2001) }],
    ["testChat.turn", { projectKey: "p", incomingText: "", recentMessages: [] }],
    ["knowledgeGaps.answer", { id: "1", answer: "no" }],
  ])("rejects %s with %j as a bad request", async (procedure, input) => {
    const response = await (await serve()).mutate(procedure, input);
    expect(response.status).toBe(400);
    expect((await response.json()).error.json.data.code).toBe("BAD_REQUEST");
  });

  it("refuses a request body over 100 kB", async () => {
    const response = await (await serve()).mutate("projects.saveTraining", { projectKey: "p", answers: { faqs: "x".repeat(150_000) }, summary: "" });
    expect(response.status).toBe(413);
  });

  it("tells the dashboard when a change was refused instead of reporting success", async () => {
    const app = await serve();
    const approve = await app.mutate("projects.approve", { projectKey: "missing" });
    expect(approve.status).toBe(412);
    expect((await approve.json()).error.json.message).toMatch(/training/i);
    expect((await app.mutate("projects.saveTraining", { projectKey: "missing", answers: {}, summary: "" })).status).toBe(404);
    expect((await app.mutate("orders.confirm", { orderKey: "WA-404" })).status).toBe(412);
  });
});

describe("rate limiting", () => {
  it("stops one address after its allowance for the minute and says when to retry", async () => {
    const app = await serve({ apiRateLimitPerMinute: 3 });
    const statuses = [];
    for (let request = 0; request < 4; request++) statuses.push((await app.get("/api/trpc/dashboard.conversations")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const refused = await app.get("/api/trpc/dashboard.conversations");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await app.get("/healthz")).status).toBe(200);
  });

  it("gives the calls that spend AI requests a smaller allowance of their own", async () => {
    const app = await serve({ aiRateLimitPerMinute: 1 });
    const turn = { projectKey: "missing", incomingText: "hi", recentMessages: [] };
    expect((await app.mutate("testChat.turn", turn)).status).toBe(404); // counted, then refused by the router: no such project
    expect((await app.mutate("testChat.turn", turn)).status).toBe(429);
    expect((await app.get("/api/trpc/dashboard.conversations")).status).toBe(200);
  });
});
