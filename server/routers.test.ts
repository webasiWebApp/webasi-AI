import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./test-utils/fake-supabase";

// The dashboard API end to end against an in-memory database, with WhatsApp and the AI replaced by stand-ins.
const world = vi.hoisted(() => ({
  db: null as unknown as import("./test-utils/fake-supabase").FakeSupabase,
  sendText: vi.fn(),
  runTurn: vi.fn(),
  generate: vi.fn(async () => [] as unknown[]),
}));
vi.mock("./_core/supabase", () => ({ getSupabaseServer: () => world.db, checkSupabaseConnection: async () => ({ ok: true }) }));
vi.mock("./whatsapp/baileys", () => ({ baileysTransport: { sendText: world.sendText, sendToSelf: async () => true, isConnected: () => true, getStatus: async () => ({ status: "connected", hasSession: true, updatedAt: "" }) } }));
vi.mock("./conversations/engine", async (importOriginal) => ({ ...(await importOriginal<typeof import("./conversations/engine")>()), createConversationEngine: () => ({ runTurn: world.runTurn }) }));
vi.mock("./conversations/faq-generator", async (importOriginal) => ({ ...(await importOriginal<typeof import("./conversations/faq-generator")>()), generateClientFaqs: world.generate }));

let db: FakeSupabase;
let api: ReturnType<typeof import("./routers").appRouter.createCaller>;

beforeEach(async () => {
  vi.resetModules();
  db = world.db = new FakeSupabase();
  world.sendText.mockReset().mockResolvedValue({ accepted: true, messageId: "wamid.owner-1", parts: 1 });
  world.runTurn.mockReset().mockResolvedValue({ reply: "From the engine.", extractedFields: {}, intent: "question", needsOwner: false, needsOwnerReason: null, reliedOnFacts: [] });
  world.generate.mockReset().mockResolvedValue([]);
  const { ENV } = await import("./_core/env");
  ENV.supabaseUrl = "http://supabase.test";
  ENV.supabaseServiceRoleKey = "test-service-role";
  const { appRouter } = await import("./routers");
  api = appRouter.createCaller({ req: {} as never, res: {} as never });
});

const answers = { packageDescription: "A five page business website.", includedExcluded: "Included: 5 pages\nExcluded: logo design", pricing: "LKR 60,000", depositRule: "50% deposit", timeline: "10 business days", revisionPolicy: "Two rounds.", requiredClientInputs: "logo", paymentTerms: "Balance before launch.", faqs: "Q: Do you provide hosting?\nA: Yes, hosting is included for one year.", tone: "friendly", forbiddenTopics: "discounts", escalationRules: "legal questions", samples: "webasi.co", contactDetails: "WhatsApp only" };
const chat = (extra: Record<string, unknown> = {}) => ({ client_id: "c1", wa_id: "94770001111", profile_name: "Nimal", state: "collecting", ...extra });
const thisMonth = new Date().toISOString().slice(0, 7);

describe("project lifecycle through the API", () => {
  it("takes a project from draft to live, and only then lets automation be switched on", async () => {
    await api.dashboard.overview(); // first visit: creates the settings row and the demo project
    await api.projects.create({ projectKey: "site-1", name: "Business website", snapshot: JSON.stringify({ name: "Business website", status: "draft" }) });
    expect((await api.dashboard.projects()).map((project) => [project.projectKey, project.status])).toContainEqual(["site-1", "training"]);

    await expect(api.projects.approve({ projectKey: "site-1" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await api.projects.activate({ projectKey: "site-1" })).toBe(false);

    await api.projects.saveTraining({ projectKey: "site-1", answers, summary: "Five page site for small businesses." });
    expect(await api.projects.approveTraining({ projectKey: "site-1" })).toBe(true);
    expect(await api.projects.activate({ projectKey: "site-1" })).toBe(true);

    const overview = await api.dashboard.overview();
    expect(overview.activeProject).toMatchObject({ projectKey: "site-1", status: "active" });
    expect(db.rows("projects").filter((row) => row.status === "active")).toHaveLength(1);
    expect(await api.settings.update({ webasiEnabled: true })).toBe(true);
    expect((await api.dashboard.settings()).webasiEnabled).toBe(true);
  });
});

describe("owner messages from the dashboard", () => {
  it("reports a conversation that does not exist without sending anything", async () => {
    db.seed("settings", {});
    expect(await api.conversations.ownerMessage({ clientId: "missing", text: "Hello" })).toEqual({ accepted: false, reason: "conversation_not_found" });
    expect(world.sendText).not.toHaveBeenCalled();
  });

  it("is held back by the monthly WhatsApp limit", async () => {
    db.seed("settings", {}).seed("projects", { project_key: "mine", name: "Mine", status: "active" }).seed("conversations", chat()).seed("usage_counters", { period_key: thisMonth, outbound_whatsapp: 810 });
    expect(await api.conversations.ownerMessage({ clientId: "c1", text: "Hello" })).toEqual({ accepted: false, reason: "whatsapp_usage_hard_stop" });
    expect(world.sendText).not.toHaveBeenCalled();
    expect(db.rows("conversations")[0].is_paused).toBe(false);
  });

  it("sends, pauses the bot for that chat, counts the message and keeps the answer as something learned", async () => {
    db.seed("settings", {}).seed("projects", { project_key: "mine", name: "Mine", status: "active" });
    db.seed("conversations", chat({ handed_over: true, recent_messages: [{ role: "client", text: "Do you do logos?" }] }));
    expect(await api.conversations.ownerMessage({ clientId: "c1", text: "  No, logos are separate.  " })).toEqual({ accepted: true, messageId: "wamid.owner-1" });

    expect(world.sendText).toHaveBeenCalledWith({ to: "94770001111", body: "No, logos are separate." });
    const stored = db.rows("conversations")[0];
    expect(stored.is_paused).toBe(true);
    expect(stored.recent_messages.at(-1)).toMatchObject({ role: "owner", text: "No, logos are separate." });
    expect(db.rows("usage_counters").find((row) => row.period_key === thisMonth)?.outbound_whatsapp).toBe(1);
    expect(db.rows("messages")[0]).toMatchObject({ message_id: "wamid.owner-1", direction: "outbound", role: "owner" });
    expect(db.rows("insights")[0]).toMatchObject({ category: "Learned answer", detail: "Q: Do you do logos?\nA: No, logos are separate." });
    expect(db.rows("event_log").map((row) => row.event_type).sort()).toEqual(["dashboard_owner_message", "dashboard_takeover"]);
  });

  it("counts and records nothing when WhatsApp does not accept the message", async () => {
    db.seed("settings", {}).seed("projects", { project_key: "mine", name: "Mine", status: "active" }).seed("conversations", chat());
    world.sendText.mockResolvedValue({ accepted: false, reason: "baileys_not_connected" });
    expect(await api.conversations.ownerMessage({ clientId: "c1", text: "Hello" })).toEqual({ accepted: false, reason: "baileys_not_connected" });
    expect(db.rows("usage_counters")).toHaveLength(0);
    expect(db.rows("messages")).toHaveLength(0);
    expect(db.rows("conversations")[0].recent_messages).toEqual([]);
  });
});

describe("test chat sandbox", () => {
  const seedProject = (status: string, approved: boolean) => db.seed("settings", {}).seed("projects", { project_key: "mine", name: "Mine", status, readiness: approved ? 100 : 40, snapshot: { name: "Mine" } }).seed("training_sessions", { project_key: "mine", answers, summary: "Summary", approved });
  const turn = (incomingText: string) => api.testChat.turn({ projectKey: "mine", incomingText, recentMessages: [] });

  it("is closed until the project's training is approved", async () => {
    seedProject("training", false);
    await expect(turn("hi")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(api.testChat.turn({ projectKey: "missing", incomingText: "hi", recentMessages: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(world.runTurn).not.toHaveBeenCalled();
  });

  it("answers a known question from the FAQs without the AI", async () => {
    seedProject("approved", true);
    expect(await turn("Do you provide hosting?")).toMatchObject({ reply: "Yes, hosting is included for one year.", answeredFromFaqs: true });
    expect(world.runTurn).not.toHaveBeenCalled();
  });

  it("runs everything else through the engine as a sandbox turn that leaves no trace", async () => {
    seedProject("approved", true);
    expect(await turn("Can I send the logo later?")).toMatchObject({ reply: "From the engine." });
    expect(world.runTurn.mock.calls[0][0]).toMatchObject({ clientId: "test-chat-sandbox", incomingText: "Can I send the logo later?", isOn: true });
    expect(world.sendText).not.toHaveBeenCalled();
    for (const table of ["conversations", "messages", "usage_counters", "orders"]) expect(db.rows(table), table).toHaveLength(0);
  });
});

describe("insights and orders through the API", () => {
  it("turns an answered knowledge gap into an FAQ the bot can use", async () => {
    db.seed("settings", {}).seed("projects", { project_key: "mine", name: "Mine", status: "active", readiness: 100, snapshot: { name: "Mine" } }).seed("training_sessions", { project_key: "mine", answers, summary: "Summary", approved: true });
    db.seed("knowledge_gaps", { question: "Do you build online shops?", created_at: new Date().toISOString() });
    const [gap] = await api.knowledgeGaps.list();
    expect(await api.knowledgeGaps.answer({ id: gap.id, answer: "Not in this package, but we can quote one separately." })).toBe(true);
    expect((await api.knowledgeGaps.list())[0]).toMatchObject({ status: "answered" });
    expect((await api.projects.instantAnswers({ projectKey: "mine" })).owner.map((entry) => entry.question)).toContain("Do you build online shops?");
  });

  it("confirms a deposit only for an order with a slip", async () => {
    db.seed("orders", { order_key: "WA-1", client_id: "c1", wa_id: "94770001111", package_name: "Site", deposit_amount: 30000, state: "awaiting_deposit" });
    await expect(api.orders.confirm({ orderKey: "WA-1" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    db.rows("orders")[0].state = "slip_received";
    expect(await api.orders.confirm({ orderKey: "WA-1" })).toBe(true);
    expect((await api.dashboard.orders())[0]).toMatchObject({ orderKey: "WA-1", state: "confirmed_by_owner" });
  });
});
