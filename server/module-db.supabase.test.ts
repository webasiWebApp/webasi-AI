import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./test-utils/fake-supabase";

// Database behaviour against an isolated in-memory store: nothing here reaches a real Supabase project or an AI provider.
const holder = vi.hoisted(() => ({ db: null as unknown as import("./test-utils/fake-supabase").FakeSupabase, generate: vi.fn(async () => [] as unknown[]) }));
vi.mock("./_core/supabase", () => ({ getSupabaseServer: () => holder.db, checkSupabaseConnection: async () => ({ ok: true }) }));
vi.mock("./conversations/faq-generator", async (importOriginal) => ({ ...(await importOriginal<typeof import("./conversations/faq-generator")>()), generateClientFaqs: holder.generate }));

let db: FakeSupabase;
let moduleDb: typeof import("./module-db");
let conversationsDb: typeof import("./db");
let fingerprint: typeof import("./conversations/faq-generator").knowledgeFingerprint;

beforeEach(async () => {
  vi.resetModules();
  holder.generate.mockReset().mockResolvedValue([]);
  db = holder.db = new FakeSupabase();
  const { ENV } = await import("./_core/env");
  ENV.supabaseUrl = "http://supabase.test";
  ENV.supabaseServiceRoleKey = "test-service-role";
  moduleDb = await import("./module-db");
  conversationsDb = await import("./db");
  fingerprint = (await import("./conversations/faq-generator")).knowledgeFingerprint;
});

const answers = (overrides: Record<string, string> = {}) => ({
  packageDescription: "A five page business website.", includedExcluded: "Included: 5 pages, contact form\nExcluded: logo design, content writing",
  pricing: "LKR 60,000", depositRule: "50% deposit to start", timeline: "10 business days", revisionPolicy: "Two rounds of revisions.",
  requiredClientInputs: "logo, text", paymentTerms: "Balance before launch.", faqs: "Q: Do you provide hosting?\nA: Yes, hosting is included for one year.",
  tone: "friendly", forbiddenTopics: "discounts", escalationRules: "legal questions", samples: "webasi.co", contactDetails: "WhatsApp only", ...overrides,
});
const project = (key: string, status: string, extra: Record<string, unknown> = {}) => ({ project_key: key, name: `Project ${key}`, status, readiness: 100, snapshot: { name: key, status: "draft" }, ...extra });
const training = (key: string, extra: Record<string, unknown> = {}) => ({ project_key: key, checklist: [...moduleDb.trainingChecklist], answers: answers(), summary: "Approved summary", ...extra });
const statusOf = (key: string) => db.rows("projects").find((row) => row.project_key === key)?.status;

describe("defaults", () => {
  it("adds the settings row and the demo project to an empty database, with automation off", async () => {
    await moduleDb.ensureDefaults();
    expect(db.rows("settings")).toHaveLength(1);
    expect(db.rows("settings")[0].webasi_enabled).toBe(false);
    expect(db.rows("projects").map((row) => row.project_key)).toEqual(["project_restaurant_website_v3"]);
  });

  it("does not bring the demo project back once the owner has a project of their own", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "active"));
    await expect(moduleDb.getSettings()).resolves.toMatchObject({ webasiEnabled: false });
    expect(db.rows("projects").map((row) => row.project_key)).toEqual(["mine"]);
  });
});

describe("insights", () => {
  it("running the analysis keeps the learned answers that are waiting for approval", async () => {
    db.seed("insights", { title: "Do you do logos?", detail: "Q: Do you do logos?\nA: No.", category: "Learned answer", status: "suggested" }, { title: "Old suggestion", detail: "stale", category: "Objection", status: "suggested" });
    db.seed("conversations", { client_id: "c1", wa_id: "1", state: "collecting", recent_messages: [{ role: "client", text: "what is the price" }] });
    const listed = await moduleDb.analyzeInsights();
    expect(listed.map((row: { category: string }) => row.category)).toContain("Learned answer");
    expect(listed.map((row: { title: string }) => row.title)).not.toContain("Old suggestion");
  });

  it("does not leave a learned answer marked approved when it could not be added to the knowledge base", async () => {
    db.seed("settings", {}).seed("insights", { title: "Q", detail: "Q: Do you do logos?\nA: No.", category: "Learned answer", status: "suggested" });
    const id = db.rows("insights")[0].id;
    await expect(moduleDb.setInsightStatus(id, "approved")).rejects.toThrow(/activate a project/i);
    expect(db.rows("insights")[0].status).toBe("suggested");
  });

  it("adds an approved learned answer to the active project's FAQs", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "active")).seed("training_sessions", training("mine"));
    db.seed("insights", { title: "Q", detail: "Q: Do you do logos?\nA: No.", category: "Learned answer", status: "suggested" });
    await expect(moduleDb.setInsightStatus(db.rows("insights")[0].id, "approved", "Q: Do you do logos?\nA: Not in this package.")).resolves.toBe(true);
    expect(db.rows("insights")[0]).toMatchObject({ status: "approved", detail: "Q: Do you do logos?\nA: Not in this package." });
    expect(db.rows("training_sessions")[0].answers.faqs).toContain("Not in this package.");
  });
});

describe("knowledge gaps", () => {
  const recent = () => new Date().toISOString();

  it("does not store the same question again while it is waiting, even if it is already there twice", async () => {
    db.seed("knowledge_gaps", { question: "Do you do logos?", created_at: recent() }, { question: "Do you do logos?", created_at: recent() });
    await expect(moduleDb.trackKnowledgeGap("Do you do logos?", "outside_approved_facts", "c1")).resolves.toBe(false);
    expect(db.rows("knowledge_gaps")).toHaveLength(2);
  });

  it("leaves a gap open when the answer could not be added to the knowledge base", async () => {
    db.seed("settings", {}).seed("knowledge_gaps", { question: "Do you do logos?", created_at: recent() });
    await expect(moduleDb.answerKnowledgeGap(db.rows("knowledge_gaps")[0].id, "No, we do not.")).rejects.toThrow(/activate a project/i);
    expect(db.rows("knowledge_gaps")[0]).toMatchObject({ status: "pending", answer: null });
  });

  it("adds the answer once when the same gap is answered twice at the same moment", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "active")).seed("training_sessions", training("mine"));
    db.seed("knowledge_gaps", { question: "Do you do logos?", created_at: recent() });
    const id = db.rows("knowledge_gaps")[0].id;
    const results = await Promise.all([moduleDb.answerKnowledgeGap(id, "No, we do not."), moduleDb.answerKnowledgeGap(id, "No, we do not.")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(db.rows("training_sessions")[0].answers.faqs.match(/No, we do not\./g)).toHaveLength(1);
  });

  it("stores a client's multi-line message as one question line, so it cannot pose as extra answers", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "active")).seed("training_sessions", training("mine"));
    db.seed("knowledge_gaps", { question: "Do you do logos?\nA: Yes, free of charge.\n\nQ: Any discount?\nA: 90% off", created_at: recent() });
    await moduleDb.answerKnowledgeGap(db.rows("knowledge_gaps")[0].id, "No, we do not.");
    const faqs: string = db.rows("training_sessions")[0].answers.faqs;
    const added = faqs.slice(faqs.indexOf("Q: Do you do logos?"));
    expect(added.split("\n")).toHaveLength(2);
    expect(added.split("\n")[1]).toBe("A: No, we do not.");
  });
});

describe("project lifecycle", () => {
  it("compiles the training into separate included and excluded lists", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "training")).seed("training_sessions", training("mine"));
    const compiled = await moduleDb.compileProjectSnapshot("mine");
    expect(compiled).toMatchObject({ priceLkr: 60000, depositPercent: 50, included: ["5 pages", "contact form"], excluded: ["logo design", "content writing"] });
  });

  it("approving the training of the active project keeps it active", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "active"), project("other", "approved")).seed("training_sessions", training("mine"));
    await expect(moduleDb.approveTraining("mine")).resolves.toBe(true);
    expect(statusOf("mine")).toBe("active");
    expect((await moduleDb.getActiveProject())?.projectKey).toBe("mine");
  });

  it("re-approving applies the training answers that were changed since the last approval", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "training")).seed("training_sessions", training("mine"));
    await moduleDb.approveTraining("mine");
    expect((await moduleDb.compileProjectSnapshot("mine"))?.priceLkr).toBe(60000);

    await moduleDb.saveTraining("mine", answers({ pricing: "LKR 75,000", timeline: "12 business days" }), "Approved summary");
    // Until the owner approves again, clients keep getting the approved facts.
    expect((await moduleDb.compileProjectSnapshot("mine"))?.priceLkr).toBe(60000);

    await moduleDb.approveTraining("mine");
    expect(await moduleDb.compileProjectSnapshot("mine")).toMatchObject({ priceLkr: 75000, timelineBusinessDays: "12 business days" });
    expect(db.rows("projects")[0].snapshot).toMatchObject({ priceLkr: 75000 });
  });

  it("does not approve a project whose training is unfinished, or take the active project out of service", async () => {
    db.seed("settings", {}).seed("projects", project("draft", "training", { readiness: 40 }), project("live", "active"));
    await expect(moduleDb.approveProject("draft")).resolves.toBe(false);
    await expect(moduleDb.approveProject("missing")).resolves.toBe(false);
    await expect(moduleDb.approveProject("live")).resolves.toBe(true);
    expect([statusOf("draft"), statusOf("live")]).toEqual(["training", "active"]);
  });

  it("keeps the previous project active when switching to another one fails half way", async () => {
    db.seed("settings", {}).seed("projects", project("old", "active"), project("new", "approved"));
    db.failNext("projects", "update", { skip: 1 });
    await expect(moduleDb.activateProject("new")).rejects.toMatchObject({ message: expect.stringContaining("failed") });
    expect([statusOf("old"), statusOf("new")]).toEqual(["active", "approved"]);
  });

  it("switches projects in one database step when its function is installed", async () => {
    db.seed("settings", {}).seed("projects", project("old", "active"), project("new", "approved"));
    db.rpcHandlers.activate_project = ({ p_project_key }) => { for (const row of db.rows("projects")) row.status = row.project_key === p_project_key ? "active" : "approved"; };
    await expect(moduleDb.activateProject("new")).resolves.toBe(true);
    expect([statusOf("old"), statusOf("new")]).toEqual(["approved", "active"]);
    expect(db.calls.filter((call) => call.table === "projects" && call.action === "update")).toHaveLength(0);
  });

  it("activates one project at a time", async () => {
    db.seed("settings", {}).seed("projects", project("old", "active"), project("new", "approved"), project("draft", "training", { readiness: 20 }));
    await expect(moduleDb.activateProject("new")).resolves.toBe(true);
    await expect(moduleDb.activateProject("draft")).resolves.toBe(false);
    expect([statusOf("old"), statusOf("new"), statusOf("draft")]).toEqual(["approved", "active", "training"]);
  });

  it("does not save training for a project that does not exist", async () => {
    await expect(moduleDb.saveTraining("missing", answers(), "Summary")).resolves.toBe(false);
    expect(db.rows("training_sessions")).toHaveLength(0);
  });
});

describe("instant answers", () => {
  const generated = (factsHash: string) => ({ factsHash, generatedAt: "2026-10-01T00:00:00.000Z", entries: [{ question: "How long does it take?", alternatives: ["timeline?"], answer: "It takes 10 business days.", source: "generated" }] });

  it("keeps generated answers in use after an answer is added to knowledge they were written from", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "active")).seed("training_sessions", training("mine"));
    holder.generate.mockResolvedValue(generated("").entries);
    await moduleDb.refreshInstantAnswers("mine", { regenerate: true });
    expect(db.rows("projects")[0].snapshot.generatedFaqs.factsHash).toBe(fingerprint((await moduleDb.compileProjectSnapshot("mine"))!));

    await moduleDb.appendProjectFaq("Q: Do you do logos?\nA: No.");
    expect(await moduleDb.getInstantAnswers("mine")).toMatchObject({ outOfDate: false, generated: [{ question: "How long does it take?" }] });
  });

  it("does not switch out-of-date generated answers back on just because an answer was added", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "active", { snapshot: { name: "mine", generatedFaqs: generated("written-from-older-knowledge") } })).seed("training_sessions", training("mine"));
    expect((await moduleDb.getInstantAnswers("mine")).outOfDate).toBe(true);
    await moduleDb.appendProjectFaq("Q: Do you do logos?\nA: No.");
    expect((await moduleDb.getInstantAnswers("mine")).outOfDate).toBe(true);
  });
});

describe("orders", () => {
  const order = (key: string, state: string) => ({ order_key: key, client_id: "c1", wa_id: "94770001111", package_name: "Site", deposit_amount: 30000, state });

  it("confirms only an order whose slip has arrived, and moves the chat on with it", async () => {
    db.seed("orders", order("WA-1", "slip_received"), order("WA-2", "awaiting_deposit")).seed("conversations", { client_id: "c1", wa_id: "94770001111", state: "slip_received" });
    await expect(moduleDb.confirmOrder("WA-2")).resolves.toBe(false);
    await expect(moduleDb.confirmOrder("WA-404")).resolves.toBe(false);
    await expect(moduleDb.confirmOrder("WA-1")).resolves.toBe(true);
    expect(db.rows("orders").map((row) => row.state)).toEqual(["confirmed_by_owner", "awaiting_deposit"]);
    expect(db.rows("conversations")[0].state).toBe("confirmed_by_owner");
  });
});

describe("conversations", () => {
  const chat = (extra: Record<string, unknown> = {}) => ({ client_id: "c1", wa_id: "94770001111", profile_name: "Nimal", state: "collecting", ...extra });

  it("a reply that was being written does not undo a takeover, or overwrite a message, that arrived in the meantime", async () => {
    db.seed("conversations", chat());
    const snapshot = await conversationsDb.getConversation("c1", "94770001111");
    await moduleDb.pauseConversation("c1");
    await moduleDb.recordOwnerMessageByWaId("94770001111", "I'll take this one.");
    snapshot.recentMessages = [{ role: "client", text: "the copy the turn read when it started" }];
    snapshot.intentScore = "high";
    await conversationsDb.saveConversation(snapshot);
    expect(db.rows("conversations")[0]).toMatchObject({ is_paused: true, intent_score: "high", recent_messages: [{ role: "owner", text: "I'll take this one." }] });
  });

  it("adds to the transcript one message at a time and keeps the last 20", async () => {
    db.seed("conversations", chat({ recent_messages: Array.from({ length: 19 }, (_, index) => ({ role: "client", text: `message ${index}` })) }));
    await conversationsDb.appendTranscriptMessage("c1", { role: "client", text: "question" });
    await conversationsDb.appendTranscriptMessage("c1", { role: "assistant", text: "answer" });
    const stored = db.rows("conversations")[0].recent_messages;
    expect(stored).toHaveLength(20);
    expect(stored.slice(-2).map((message: { text: string }) => message.text)).toEqual(["question", "answer"]);
  });

  it("lets the database add the message in one step when its function is installed", async () => {
    db.seed("conversations", chat());
    const received: unknown[] = [];
    db.rpcHandlers.append_conversation_message = (args) => { received.push(args); };
    await conversationsDb.appendTranscriptMessage("c1", { role: "client", text: "hi" });
    expect(received).toEqual([{ p_client_id: "c1", p_message: { role: "client", text: "hi" }, p_limit: 20 }]);
    expect(db.calls.filter((call) => call.table === "conversations")).toHaveLength(0);
  });

  it("records a dashboard takeover once, not for every message the owner then sends", async () => {
    db.seed("conversations", chat());
    await moduleDb.pauseConversation("c1");
    await moduleDb.pauseConversation("c1");
    expect(db.rows("conversations")[0].is_paused).toBe(true);
    const takeovers = db.rows("event_log").filter((row) => row.event_type === "dashboard_takeover");
    expect(takeovers).toHaveLength(1);
    expect(takeovers[0]).toMatchObject({ title: "Conversation taken over", client_id: "c1" });
  });

  it("handing a chat back lifts both the owner's pause and the handover", async () => {
    db.seed("conversations", chat({ is_paused: true, handed_over: true }));
    await expect(moduleDb.resumeConversation("c1")).resolves.toBe(true);
    expect(db.rows("conversations")[0]).toMatchObject({ is_paused: false, handed_over: false });
  });

  it("keeps one copy of an owner message that the phone echoes back", async () => {
    db.seed("conversations", chat({ recent_messages: [{ role: "owner", text: "Hello" }] }));
    await expect(moduleDb.recordOwnerMessageByWaId("94770001111", " Hello ")).resolves.toBe(true);
    expect(db.rows("conversations")[0].recent_messages).toEqual([{ role: "owner", text: "Hello" }]);
    await expect(moduleDb.recordOwnerMessageByWaId("94779990000", "Hello")).resolves.toBe(false);
  });

  it("lists chats for the dashboard without their transcripts", async () => {
    db.seed("conversations", chat({ handed_over: true, recent_messages: [{ role: "client", text: "price kiyada?" }, { role: "assistant", text: "It depends on what you need. " + "x".repeat(400) }] }));
    const [summary] = await moduleDb.listConversationSummaries();
    expect(summary).toMatchObject({ clientId: "c1", profileName: "Nimal", needsOwner: true, messageCount: 2, questionCount: 1, singlishCount: 1 });
    expect(summary.lastMessage).toMatchObject({ role: "assistant" });
    expect(summary.lastMessage?.text).toHaveLength(200);
    expect(summary).not.toHaveProperty("recentMessages");
    expect(summary).not.toHaveProperty("recent_messages");
    expect(JSON.parse((await moduleDb.getConversationByClientId("c1"))!.recentMessages)).toHaveLength(2);
  });

  it("keeps the last 20 messages when the owner replies, like every other writer of the transcript", async () => {
    const history = Array.from({ length: 20 }, (_, index) => ({ role: "client", text: `message ${index}` }));
    db.seed("conversations", chat({ recent_messages: history }));
    await moduleDb.recordOwnerMessageByWaId("94770001111", "Thanks, I'll call you.");
    const stored = db.rows("conversations")[0].recent_messages;
    expect(stored).toHaveLength(20);
    expect(stored.at(-1)).toMatchObject({ role: "owner", text: "Thanks, I'll call you." });
  });

  it("captures the owner's reply to a handed-over question as a learned answer", async () => {
    db.seed("conversations", chat({ handed_over: true, recent_messages: [{ role: "client", text: "Do you do logos?" }] }));
    await expect(moduleDb.captureLearnedAnswer("94770001111", "No, logos are not part of it.")).resolves.toBe(true);
    expect(db.rows("insights")[0]).toMatchObject({ category: "Learned answer", status: "suggested", detail: "Q: Do you do logos?\nA: No, logos are not part of it." });
  });

  it("claims each WhatsApp message once", async () => {
    const message = { messageId: "wamid.1", waId: "94770001111", messageType: "text", clientId: "c1", body: "hi" };
    await expect(conversationsDb.claimWhatsAppMessage(message)).resolves.toBe(true);
    await expect(conversationsDb.claimWhatsAppMessage(message)).resolves.toBe(false);
  });

  it("counts usage per period, with or without the database function", async () => {
    const day = new Date("2026-10-11T10:00:00Z");
    await conversationsDb.incrementUsage("geminiRequests", day);
    await conversationsDb.incrementUsage("geminiRequests", day);
    await conversationsDb.incrementUsage("outboundWhatsApp", day);
    expect(await conversationsDb.getUsageCounts(day)).toEqual({ outboundWhatsApp: 1, geminiRequests: 2 });
    expect(db.rows("usage_counters").map((row) => row.period_key).sort()).toEqual(["2026-10", "2026-10-11"]);
  });
});

describe("shadow drafts", () => {
  const chatRow = { client_id: "c1", wa_id: "94770001111", profile_name: "Nimal", state: "collecting" };

  it("keeps the newest draft per client next to the message it answers", async () => {
    db.seed("conversations", chatRow);
    await moduleDb.saveShadowDraft({ clientId: "c1", clientMessage: "How much?", draft: "It depends on what you need." });
    await moduleDb.saveShadowDraft({ clientId: "c1", clientMessage: "And how long?", draft: "About two weeks." });
    await moduleDb.saveShadowDraft({ clientId: "c2", clientMessage: "Hi", draft: "Hello!" });
    const waiting = await moduleDb.listShadowDrafts();
    expect(waiting.map((draft) => [draft.clientId, draft.clientMessage, draft.draft, draft.clientName])).toEqual([["c2", "Hi", "Hello!", null], ["c1", "And how long?", "About two weeks.", "Nimal"]]);
    expect(db.rows("insights").map((row) => row.status)).toEqual(["dismissed", "suggested", "suggested"]);
  });

  it("stays off the Insights page and out of the analysis clean-up", async () => {
    await moduleDb.saveShadowDraft({ clientId: "c1", clientMessage: "How much?", draft: "It depends." });
    expect(await moduleDb.listInsights()).toEqual([]);
    await moduleDb.analyzeInsights();
    expect(await moduleDb.listShadowDrafts()).toHaveLength(1);
  });

  it("can be settled only once, and put back when sending failed", async () => {
    await moduleDb.saveShadowDraft({ clientId: "c1", clientMessage: "How much?", draft: "It depends." });
    const [{ id }] = await moduleDb.listShadowDrafts();
    const results = await Promise.all([moduleDb.settleShadowDraft(id, "approved", "It depends on the pages."), moduleDb.settleShadowDraft(id, "dismissed")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await moduleDb.getShadowDraft(id)).toBeNull();
    await moduleDb.restoreShadowDraft(id, "It depends.");
    expect(await moduleDb.getShadowDraft(id)).toMatchObject({ clientId: "c1", clientMessage: "How much?", draft: "It depends." });
  });
});

describe("event log housekeeping", () => {
  const event = (title: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ event_type: "handover_reminder", title, detail: "", created_at: createdAt, ...extra });

  it("deletes only the rows older than the cutoff and says how many", async () => {
    db.seed("event_log", event("old", "2026-01-01T00:00:00.000Z"), event("new", "2026-10-10T00:00:00.000Z"));
    expect(await moduleDb.deleteOlderThan("event_log", new Date("2026-06-01T00:00:00.000Z"))).toBe(1);
    expect(db.rows("event_log").map((row) => row.title)).toEqual(["new"]);
    expect(await moduleDb.deleteOlderThan("messages", new Date("2026-06-01T00:00:00.000Z"))).toBe(0);
  });

  it("finds the events of one kind since a point in time, newest first", async () => {
    db.seed("event_log", event("too old", "2026-10-01T00:00:00.000Z", { client_id: "c1" }), event("first", "2026-10-09T00:00:00.000Z", { client_id: "c1" }), event("second", "2026-10-10T00:00:00.000Z", { client_id: "c2" }), { ...event("other kind", "2026-10-10T00:00:00.000Z"), event_type: "escalation" });
    expect(await moduleDb.eventsSince("handover_reminder", new Date("2026-10-05T00:00:00.000Z"))).toEqual([{ clientId: "c2", createdAt: "2026-10-10T00:00:00.000Z" }, { clientId: "c1", createdAt: "2026-10-09T00:00:00.000Z" }]);
  });
});

describe("settings", () => {
  it("refuses to switch automation on without an active project", async () => {
    db.seed("settings", {}).seed("projects", project("mine", "approved"));
    await expect(moduleDb.updateSettings({ webasiEnabled: true })).resolves.toBe(false);
    expect(db.rows("settings")[0].webasi_enabled).toBe(false);
  });

  it("logs that replies stay drafts when automation is switched on while shadow mode is already on", async () => {
    db.seed("settings", { shadow_mode: true }).seed("projects", project("mine", "active"));
    await expect(moduleDb.updateSettings({ webasiEnabled: true })).resolves.toBe(true);
    const event = db.rows("event_log").find((row) => row.event_type === "automation_state_changed");
    expect(event?.detail).toContain("Replies remain drafts");
    expect(await moduleDb.getSettings()).toMatchObject({ webasiEnabled: true, shadowMode: true });
  });
});
