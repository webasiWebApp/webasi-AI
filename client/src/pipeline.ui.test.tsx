// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memoryLocation } from "wouter/memory-location";
import { Router } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgSupabase } from "../../server/test-utils/pg-supabase";

// The dashboard's pages, driven the way the owner drives them, on top of the real API and the real SQL (PGlite). The
// browser's calls go straight into the tRPC router in this process, so a refusal the database makes is the error text the
// owner would read on screen.
const holder = vi.hoisted(() => ({ db: null as unknown as PgSupabase }));
vi.mock("../../server/_core/supabase", () => ({ getSupabaseServer: () => holder.db, checkSupabaseConnection: async () => ({ ok: true }) }));

let shared: PgSupabase | null = null;
let caller: any;
let navigate: (path: string) => void;
let Home: typeof import("./pages/Home").default;
let ui: ReturnType<typeof userEvent.setup>;

function callerLink(): TRPCLink<any> {
  return () => ({ op }) => observable((observer) => {
    const procedure = op.path.split(".").reduce((node: any, key) => node[key], caller);
    Promise.resolve(procedure(op.input)).then((data) => { observer.next({ result: { data } }); observer.complete(); }, (error) => observer.error(TRPCClientError.from(error)));
  });
}

async function mount(path: string) {
  const { trpc } = await import("./lib/trpc");
  const { Toaster } = await import("./components/ui/sonner");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  const client = trpc.createClient({ links: [callerLink()] });
  const location = memoryLocation({ path, record: false });
  navigate = location.navigate;
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Router hook={location.hook}><Toaster /><Home /></Router>
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  if (!shared) shared = await (await import("../../server/test-utils/pg-supabase")).createPgSupabase();
  await shared.reset();
  holder.db = shared;
  const { ENV } = await import("../../server/_core/env");
  ENV.supabaseUrl = "http://supabase.test";
  ENV.supabaseServiceRoleKey = "test-service-role";
  caller = (await import("../../server/routers")).appRouter.createCaller({} as never);
  await caller.dashboard.settings();
  Home = (await import("./pages/Home")).default;
  ui = userEvent.setup({ delay: null });
}, 60_000);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const findButton = (name: string | RegExp) => screen.findByRole("button", { name });
const tab = async (name: string) => ui.click(await screen.findByRole("button", { name }));
const field = async (label: string | RegExp, scope?: HTMLElement) => (scope ? within(scope).findByLabelText(label) : screen.findByLabelText(label));
const typeInto = async (label: string | RegExp, value: string, scope?: HTMLElement) => { const input = await field(label, scope); await ui.clear(input); if (value) await ui.type(input, value); };
const stage = async (name: string) => waitFor(() => expect(screen.getByText(name, { selector: "span" })).toBeTruthy(), { timeout: 8000 });
const dialog = async () => screen.findByRole("dialog");

describe("the main path through the dashboard", () => {
  it("takes a client from a new job to a closed one, with every gate showing", async () => {
    await mount("/pipeline");

    // A new job from the pipeline.
    await ui.click(await findButton(/create job/i));
    let modal = await dialog();
    await typeInto("Client name", "Prablo 360", modal);
    await typeInto("What is the job", "Company website", modal);
    await ui.click(within(modal).getByRole("button", { name: /create job/i }));
    expect(await screen.findByRole("heading", { name: "Prablo 360" })).toBeTruthy();
    await stage("Lead");

    // A lead has nothing it can skip to: the later actions are not offered.
    expect(screen.queryByRole("button", { name: /start project/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /mark delivered/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /close job/i })).toBeNull();
    await tab("Documents");
    expect((await findButton(/proposal & contract pack/i)).hasAttribute("disabled")).toBe(true);
    expect((await findButton(/invoice: advance/i)).hasAttribute("disabled")).toBe(true);
    await tab("Money");
    expect((await findButton(/record payment/i)).hasAttribute("disabled")).toBe(true);
    expect(await screen.findByText(/money can only be recorded once the project has started/i)).toBeTruthy();

    // A quotation, typed by hand.
    await tab("Documents");
    await ui.click(await findButton(/^quotation$/i));
    modal = await dialog();
    await typeInto("Client name", "Prablo 360", modal);
    await typeInto("Project name", "chandranath & company", modal);
    await typeInto("Intro paragraph", "All sections requested in the RFQ.", modal);
    await typeInto("Description", "Website Design & Development", modal);
    await typeInto(/cost \(lkr\)/i, "40000", modal);
    expect(within(modal).getByText("Total LKR 40,000")).toBeTruthy();
    await ui.click(within(modal).getByRole("button", { name: /create quotation/i }));
    expect(await screen.findByText(/Quotation · 09248/)).toBeTruthy();
    // Draft: it cannot be approved before it was sent.
    expect(screen.queryByRole("button", { name: /client approved/i })).toBeNull();
    await ui.click(await findButton(/^mark as sent$/i));
    await ui.click(await findButton(/client approved/i));
    await tab("Overview");
    await stage("Approved");
    const stat = async (label: RegExp) => (await screen.findByText(label, { selector: "p" })).parentElement!;
    expect(within(await stat(/^Price$/)).getByText("LKR 40,000")).toBeTruthy();
    expect(within(await stat(/^Advance \(40%\)$/)).getByText("LKR 16,000")).toBeTruthy(); // the 40% advance

    // Start project: the full advance is required, and the form says so.
    await ui.click(await findButton(/^start project$/i));
    modal = await dialog();
    expect((within(modal).getByLabelText(/advance received/i) as HTMLInputElement).value).toBe("16000");
    await typeInto(/advance received/i, "15000", modal);
    expect(await within(modal).findByText(/must be at least LKR 16,000/)).toBeTruthy();
    expect((within(modal).getByRole("button", { name: /record advance and start/i }) as HTMLButtonElement).disabled).toBe(true);
    await typeInto(/advance received/i, "16000", modal);
    await ui.click(within(modal).getByRole("button", { name: /record advance and start/i }));
    await stage("Active");
    expect(await screen.findByRole("button", { name: /mark delivered/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start project/i })).toBeNull();

    // The 16-task checklist exists and ticks.
    await tab("Tasks");
    expect(await screen.findByText(/Tasks · 0 \/ 16/)).toBeTruthy();
    await ui.click(await screen.findByLabelText("Done: Requirement gathering (finalise SRS)"));
    expect(await screen.findByText(/Tasks · 1 \/ 16/)).toBeTruthy();

    // Delivered with a balance: closing is blocked and says why.
    await tab("Overview");
    await ui.click(await findButton(/mark delivered/i));
    await stage("Delivered");
    expect((await findButton(/close job/i)).hasAttribute("disabled")).toBe(true);
    expect(await screen.findByText(/LKR 24,000 is still outstanding/)).toBeTruthy();

    // The payment, then the job can close.
    await tab("Money");
    await ui.click(await findButton(/record payment/i));
    modal = await dialog();
    await typeInto(/amount \(lkr\)/i, "24000", modal);
    await ui.click(within(modal).getByLabelText(/make the receipt pdf now/i)); // off: no download in a test
    await ui.click(within(modal).getByRole("button", { name: /record payment/i }));
    expect(await screen.findByText(/\+LKR 24,000/)).toBeTruthy();
    await tab("Overview");
    const close = await findButton(/close job/i);
    await waitFor(() => expect(close.hasAttribute("disabled")).toBe(false));
    await ui.click(close);
    await stage("Closed");
    expect(screen.queryByRole("button", { name: /close job/i })).toBeNull();
  }, 90_000);

  it("shows the server's own sentence when a button is pressed on stale data", async () => {
    const job = await caller.jobs.create({ clientName: "Nimali", title: "Portal" });
    const doc = await caller.documents.createQuotation({ jobId: job.id, quotation: { clientName: "Nimali", projectName: "Portal", intro: "x", items: [{ description: "Build", bullets: [], cost: 10_000 }] } });
    await caller.documents.markSent({ id: doc.id });
    await mount(`/jobs/${job.id}`);
    await tab("Documents");
    const approve = await findButton(/client approved/i);
    await caller.jobs.markLost({ jobId: job.id, reason: "went elsewhere" }); // the page does not know yet
    await ui.click(approve);
    expect(await screen.findByText(/a lost job reopens at the stage it was lost from/i, {}, { timeout: 8000 })).toBeTruthy();
    await tab("Overview");
    await stage("Lost");
    expect(await screen.findByText(/lost from quoted: went elsewhere/i)).toBeTruthy();
  }, 60_000);

  it("a started job offers no way to be lost, and a lost one can be reopened", async () => {
    const job = await caller.jobs.create({ clientName: "Kamal", title: "Shop" });
    await mount(`/jobs/${job.id}`);
    await ui.click(await findButton(/mark lost/i));
    const modal = await dialog();
    await typeInto("Why", "Budget cut", modal);
    await ui.click(within(modal).getByRole("button", { name: /^mark lost$/i }));
    await stage("Lost");
    await ui.click(await findButton(/reopen at lead/i));
    await stage("Lead");
  }, 60_000);
});

describe("Today, Pipeline and the Calendar", () => {
  it("lists jobs in their stage columns and links each to its page", async () => {
    await caller.jobs.create({ clientName: "Lead Client", title: "A" });
    const quoted = await caller.jobs.create({ clientName: "Quoted Client", title: "B" });
    await caller.documents.createQuotation({ jobId: quoted.id, quotation: { clientName: "Quoted Client", projectName: "B", intro: "", items: [{ description: "x", bullets: [], cost: 5_000 }] } });
    await mount("/pipeline");
    const leadColumn = await screen.findByRole("region", { name: "Lead" });
    expect(within(leadColumn).getByText("Lead Client")).toBeTruthy();
    const quotedColumn = screen.getByRole("region", { name: "Quoted" });
    expect(within(quotedColumn).getByText("Quoted Client")).toBeTruthy();
    expect(within(leadColumn).queryByText("Quoted Client")).toBeNull();
    expect(within(quotedColumn).getByText(/send the quotation, then mark the client's approval/i)).toBeTruthy();
  });

  it("shows today's meetings, what is overdue and who owes money, each row linking to its job", async () => {
    const job = await caller.jobs.create({ clientName: "Busy Client", title: "Site" });
    const now = Date.now();
    await caller.meetings.create({ jobId: job.id, title: "Kick-off call", startsAt: new Date(now + 3_600_000).toISOString(), endsAt: new Date(now + 7_200_000).toISOString() });
    await mount("/today");
    expect(await screen.findByText(/Kick-off call/)).toBeTruthy();
    const link = screen.getAllByRole("link", { name: /Busy Client/ })[0];
    expect(link.getAttribute("href")).toBe(`/jobs/${job.id}`);
    expect(screen.getByText("Nothing is due.")).toBeTruthy();
  });

  it("books a meeting on the calendar for a chosen job", async () => {
    await caller.jobs.create({ clientName: "Calendar Client", title: "Site" });
    await mount("/calendar");
    const add = await findButton(/add meeting/i);
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false)); // enabled once the job list has loaded
    await ui.click(add);
    const modal = await dialog();
    await typeInto("Title", "Design review", modal);
    const when = new Date(); when.setDate(when.getDate() + 1);
    const local = (offsetHours: number) => { const date = new Date(when.getTime() + offsetHours * 3_600_000); return `${date.toISOString().slice(0, 10)}T${String(10 + offsetHours).padStart(2, "0")}:00`; };
    await typeInto("Starts", local(0), modal);
    await typeInto("Ends", local(1), modal);
    await ui.click(within(modal).getByRole("button", { name: /book meeting/i }));
    await waitFor(async () => expect((await caller.meetings.list({})).map((meeting: { title: string }) => meeting.title)).toContain("Design review"), { timeout: 8000 });
  }, 60_000);
});

describe("Finance", () => {
  it("shows company profit as income minus project and company costs", async () => {
    const job = await caller.jobs.create({ clientName: "Rich Client", title: "Site" });
    const q = await caller.documents.createQuotation({ jobId: job.id, quotation: { clientName: "Rich Client", projectName: "Site", intro: "", items: [{ description: "x", bullets: [], cost: 100_000 }] } });
    await caller.documents.markSent({ id: q.id });
    await caller.jobs.approveQuotation({ quotationId: q.id });
    await caller.jobs.startProject({ jobId: job.id, amount: 40_000, idempotencyKey: "finance-ui-start" });
    await caller.ledger.recordExpense({ jobId: job.id, category: "hosting", amount: 9_000 });
    await caller.ledger.recordExpense({ category: "internet", amount: 4_000 });
    await mount("/finance");
    await ui.click(await findButton(/all time/i));
    const income = (await screen.findByText("Income", { selector: "p" })).parentElement!;
    expect(within(income).getByText("LKR 40,000")).toBeTruthy();
    const profit = screen.getByText("Company profit", { selector: "p" }).parentElement!;
    expect(within(profit).getByText("LKR 27,000")).toBeTruthy(); // 40,000 - 9,000 - 4,000
    expect((await screen.findAllByText(/LKR 60,000/)).length).toBeGreaterThan(0); // receivable
  }, 60_000);
});

describe("the lock screen", () => {
  it("refuses a wrong PIN with the server's message and unlocks on the right one", async () => {
    const { default: LockScreen } = await import("./components/LockScreen");
    const unlocked = vi.fn();
    const responses = [{ ok: false, json: async () => ({ error: "Wrong PIN." }) }, { ok: true, json: async () => ({ ok: true }) }];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal("fetch", fetchMock);
    render(<LockScreen onUnlocked={unlocked} />);
    const unlock = screen.getByRole("button", { name: /unlock/i }) as HTMLButtonElement;
    expect(unlock.disabled).toBe(true); // nothing typed yet
    await ui.type(screen.getByLabelText("PIN"), "000000");
    await ui.click(unlock);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Wrong PIN.");
    expect(unlocked).not.toHaveBeenCalled();
    expect((screen.getByLabelText("PIN") as HTMLInputElement).value).toBe(""); // cleared after a miss
    await ui.type(screen.getByLabelText("PIN"), "482915");
    await ui.click(screen.getByRole("button", { name: /unlock/i }));
    await waitFor(() => expect(unlocked).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, { body: string }])[1].body)).toEqual({ pin: "482915" });
  });
});
