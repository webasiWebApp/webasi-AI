import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import PDFDocument from "pdfkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOCUMENT_SETTINGS, quotationTotals, type ContractPayload, type InvoicePayload, type QuotationPayload, type ReceiptPayload } from "../shared/documents";
import { assetPath } from "./documents/brand";
import { contractPdf, credentialsPdf, designDocPdf, invoicePdf, quotationPdf, receiptPdf, technicalDocPdf } from "./documents/builders";
import type { PgSupabase } from "./test-utils/pg-supabase";

// PDF generation, the download routes, and the guarantee that credentials are never kept. Real Postgres (PGlite) for the
// routes; the builders are also tested on their own by recording every line of text they draw.
const holder = vi.hoisted(() => ({ db: null as unknown as PgSupabase }));
vi.mock("./_core/supabase", () => ({ getSupabaseServer: () => holder.db, checkSupabaseConnection: async () => ({ ok: true }) }));

const d = DEFAULT_DOCUMENT_SETTINGS;
const items = [{ description: "Website Design & Development", cost: 40_000, bullets: ["Responsive design (Mobile, Tablet & Desktop)", "Up to 10 main pages", "Hosting for 1 year", "Domain for 1 year"] }];
const quotation = (over: Partial<QuotationPayload> = {}): QuotationPayload => ({
  clientName: "Prablo 360", projectName: "chandranath & company", date: "2026-10-16", dueDate: "2026-11-16", advancePercent: 40, items, ...quotationTotals(items), intro: "The website will include all sections requested in the RFQ.",
  infrastructure: d.infrastructure, afterService: d.afterService, timelineDuration: d.timelineDuration, milestones: d.milestones, portfolioMain: d.portfolioMain, portfolioLinks: d.portfolioLinks, footerLinks: d.footerLinks, ...over,
});
const invoice: InvoicePayload = { basis: "advance", clientName: "Prablo 360", clientPhone: "+94 77 000 0000", projectName: "Site", date: "2026-10-20", dueDate: "2026-11-03", paymentMethod: "Bank Transfer", lines: [{ description: "Advance payment", amount: 16_000 }], total: 16_000 };
const receipt: ReceiptPayload = { clientName: "Prablo 360", projectName: "Site", date: "2026-10-21", amount: 16_000, method: "bank_transfer", category: "advance", balanceAfter: 24_000, note: "" };
const contract: ContractPayload = { title: d.contractTitle, projectName: "Site", clientName: "Prablo 360", dateOfDelivery: "2026-11-05", agreementDate: "2026-10-21", startDate: "2026-10-21", completionDate: "2026-11-01", paymentMethod: "Bank Transfer", scope: ["Website Design & Development", "  – Responsive design"], receivingParty: d.receivingParty, supportPeriod: d.supportPeriod, supportContact: d.supportContact };
const brand = { footerLinks: d.footerLinks };

// Everything a builder draws, in order.
async function textOf(build: () => Promise<Buffer>) {
  const drawn: string[] = [];
  const original = PDFDocument.prototype.text;
  const spy = vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (this: PDFKit.PDFDocument, ...args: Parameters<typeof original>) { if (typeof args[0] === "string") drawn.push(args[0]); return original.apply(this, args); });
  try { const buffer = await build(); return { buffer, drawn, all: drawn.join("\n") }; } finally { spy.mockRestore(); }
}
const pageCount = (buffer: Buffer) => (buffer.toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length;

describe("document assets", () => {
  it("finds the bundled fonts and the logo", () => {
    for (const file of ["fonts/OpenSans-Regular.ttf", "fonts/OpenSans-Bold.ttf", "assets/logo.png", "assets/footer-icons.png"]) expect(fs.statSync(assetPath(file)).size).toBeGreaterThan(5_000);
  });
});

describe("quotation PDF", () => {
  it("reproduces the owner's quotation: two pages, every section and line of the sample", async () => {
    const { buffer, drawn, all } = await textOf(() => quotationPdf({ number: "09247", payload: quotation(), registrationNo: "260223052" }));
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.subarray(-8).toString()).toContain("%%EOF");
    expect(pageCount(buffer)).toBe(2);
    for (const text of ["REG NO:", "260223052", "PROJECT", "QUOTATION", "INVOICE NO:", "09247", "DATE:", "16.10.2026", "DUE DATE:", "16.11.2026", "PROJECT NAME :", "chandranath & company", "CLIENT NAME :", "Prablo 360",
      "DESCRIPTION (INITIAL DEVELOPMENT)", "COST", "(LKR)", "Website Design & Development", "40,000", "Responsive design (Mobile, Tablet & Desktop)", "SUBTOTAL", "TOTAL",
      "PAYMENT TERMS", "40% Advance Payment", "60% Upon Project Completion", "INFRASTRUCTURE", "Technology: Next js", "Domain: .com domain for 1 year", "Hosting: namecheap", "AFTER SERVICE", "Free 01 Year after delivery support (We charge for major updates)", "Money back guarantee",
      "TIMELINE & MILESTONES", "Estimated Duration: 7-10 Calendar Days", "RELEVANT PORTFOLIO", "https://www.theplatinuminteriors.com/", "https://www.thecircularflow.com/", "webasi.co", "Reviews", "Terms and Conditions"]) {
      expect(all, text).toContain(text);
    }
    // The sections come in the sample's order.
    const order = ["PAYMENT TERMS", "INFRASTRUCTURE", "AFTER SERVICE", "TIMELINE & MILESTONES", "RELEVANT PORTFOLIO"].map((title) => drawn.indexOf(title));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it("computes the printed payment terms from the quotation's own advance percentage", async () => {
    const { all } = await textOf(() => quotationPdf({ number: "09300", payload: quotation({ advancePercent: 25 }), registrationNo: "" }));
    expect(all).toContain("25% Advance Payment");
    expect(all).toContain("75% Upon Project Completion");
    expect(all).not.toContain("40% Advance");
    expect(all).not.toContain("REG NO"); // none set in Settings
  });

  it("flows a long quotation onto more pages without losing a line, and keeps the totals together", async () => {
    const many = Array.from({ length: 60 }, (_, index) => `Feature number ${index + 1}`);
    const payload = quotation({ items: [{ description: "Big build", cost: 120_000, bullets: many }, { description: "Second block", cost: 30_000, bullets: ["Extra A", "Extra B"] }], ...quotationTotals([{ cost: 120_000 }, { cost: 30_000 }]) });
    const { buffer, all, drawn } = await textOf(() => quotationPdf({ number: "09301", payload, registrationNo: "1" }));
    expect(pageCount(buffer)).toBeGreaterThanOrEqual(3);
    for (const line of [...many, "Second block", "Extra B", "150,000"]) expect(all, line).toContain(line);
    expect(drawn.filter((line) => line === "SUBTOTAL")).toHaveLength(1);
  });

  it("prints '?' for letters the font cannot draw instead of empty boxes", async () => {
    const { all } = await textOf(() => quotationPdf({ number: "09302", payload: quotation({ clientName: "සුනිල් Perera" }), registrationNo: "" }));
    expect(all).toContain("???? Perera".replace("????", "?????"));
    expect(all).not.toContain("සුනිල්");
  });

  it("wraps a long project name and intro instead of running off the page", async () => {
    const payload = quotation({ projectName: "An extremely long project name that goes on and on and on and on and on and on until it must wrap", intro: "word ".repeat(200).trim() });
    const { buffer } = await textOf(() => quotationPdf({ number: "09303", payload, registrationNo: "1" }));
    expect(pageCount(buffer)).toBeGreaterThanOrEqual(2);
  });
});

describe("invoice and receipt PDFs", () => {
  it("prints an invoice with its amount, due date and payment terms, on one page", async () => {
    const { buffer, all } = await textOf(() => invoicePdf({ number: "09249", payload: invoice, registrationNo: "260223052", bankDetails: "Bank: Example\nAccount: 123", footerLinks: d.footerLinks }));
    expect(pageCount(buffer)).toBe(1);
    for (const text of ["INVOICE", "INVOICE NO:", "09249", "20.10.2026", "03.11.2026", "Prablo 360", "+94 77 000 0000", "Advance payment", "16,000", "TOTAL AMOUNT DUE", "PAYMENT TERMS", "Payment Method: Bank Transfer", "Payment Due By: 03.11.2026", "Bank: Example", "Account: 123"]) expect(all, text).toContain(text);
    expect(all).not.toContain("VOID");
  });

  it("prints a receipt as proof of payment, and stamps a voided one VOID", async () => {
    const live = await textOf(() => receiptPdf({ number: "09250", payload: { ...receipt, invoiceNumber: "09249" }, registrationNo: "1", footerLinks: d.footerLinks }));
    for (const text of ["RECEIPT", "RECEIPT NO:", "09250", "RECEIVED FROM :", "Payment received – advance payment", "AMOUNT RECEIVED", "BALANCE", "24,000", "09249"]) expect(live.all, text).toContain(text);
    expect(live.all).not.toContain("VOID");
    const voided = await textOf(() => receiptPdf({ number: "09250", payload: receipt, registrationNo: "1", footerLinks: d.footerLinks, void: true }));
    expect(voided.all).toContain("VOID");
    expect(pageCount(voided.buffer)).toBe(1);
  });
});

describe("proposal and contract pack PDF", () => {
  it("states the fee and payment split from the approved quotation and never from template text", async () => {
    const { all } = await textOf(() => contractPdf({ number: "09251", payload: contract, quotation: quotation({ advancePercent: 25, ...quotationTotals([{ cost: 55_000 }]), items: [{ description: "x", cost: 55_000, bullets: [] }] }), settings: d, brand }));
    expect(all).toContain("Total Fee: LKR 55,000");
    expect(all).toContain("Payment Schedule: 25% Advance Payment / 75% Upon Project Completion");
    expect(all).not.toContain("50%");
    expect(all).not.toContain("$");
    expect(all).not.toMatch(/\{\{/);
  });

  it("carries the template's wording as written, including the three flagged inconsistencies", async () => {
    const { all, buffer } = await textOf(() => contractPdf({ number: "09251", payload: contract, quotation: quotation(), settings: d, brand }));
    expect(pageCount(buffer)).toBeGreaterThanOrEqual(4); // cover, contract, NDA, support
    for (const text of ["Project Title :", "Portfolio Web Development", "Date of Delivery :", "05.11.2026", "SERVICE CONTRACT", "1. Scope of Work", "The Freelancer agrees to develop a website as per the client's requirements. This is the requirements outline.",
      "Upon full payment, all intellectual property rights in the deliverables will transfer to the Client.", "The Freelancer warrants that the deliverables will function as specified for 30 days after delivery.",
      "NON-DISCLOSURE AGREEMENT (NDA)", "Receiving Party: Praveen Maleesha from WEBASI", "This Agreement shall remain in effect for 2 years from the date of disclosure.", "IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first above written.",
      "SUPPORT & MAINTENANCE", "Support period :", "30 days", "info@webasi.co | +94 76 066 8556"]) expect(all, text).toContain(text);
    expect(all).toContain("[30 days after delivery]"); // not resolved: the owner decides what it means
    expect(all).toContain("This Agreement is made on 21.10.2026 – [30 days after delivery] between:");
  });

  it("uses a clause the owner rewrote for this contract instead of the Settings text", async () => {
    const { all } = await textOf(() => contractPdf({ number: "09251", payload: { ...contract, clauses: [{ title: "Warranty", lines: ["Twelve months of support."] }] }, quotation: quotation(), settings: d, brand }));
    expect(all).toContain("1. Warranty");
    expect(all).toContain("Twelve months of support.");
    expect(all).not.toContain("30 days after delivery.");
  });
});

describe("technical, design and credentials PDFs", () => {
  it("builds the documentation forms with the owner's headings", async () => {
    const tech = await textOf(() => technicalDocPdf({ number: "1", clientName: "A", projectName: "B", brand, payload: { overview: "Overview text", frontend: "React", backend: "Node", database: "Postgres", installation: "pnpm i", apis: "None" } }));
    for (const text of ["TECHNICAL DOCUMENTATION", "1. Overview", "Overview text", "2. Technologies Used", "Frontend: React", "3. Installation & Deployment", "4. APIs / Plugin and Its Integrations"]) expect(tech.all, text).toContain(text);
    const design = await textOf(() => designDocPdf({ number: "2", clientName: "A", projectName: "B", brand, payload: { sitemap: "Home", figmaLink: "https://figma.com/x", primaryColor: "#0070FF", secondaryColor: "", accentColor: "", fonts: "Open Sans", responsive: "Mobile first" } }));
    for (const text of ["DESIGN DOCUMENTATION", "1. Sitemap", "2. Wireframes & UI Design", "Figma: https://figma.com/x", "3. Style Guide", "Typography: Open Sans", "4. Responsive Design"]) expect(design.all, text).toContain(text);
  });

  it("builds the credentials sheet with its table and the support section", async () => {
    const { all } = await textOf(() => credentialsPdf({ clientName: "A", projectName: "B", supportPeriod: "30 days", supportContact: "info@webasi.co", brand, rows: [{ service: "Hosting Service", url: "https://h.example", username: "owner", password: "hunter2" }] }));
    for (const text of ["CREDENTIALS & ACCESS", "Service", "URL", "UserName", "Password", "Hosting Service", "hunter2", "SUPPORT & MAINTENANCE"]) expect(all, text).toContain(text);
  });
});

// ----- The routes ---------------------------------------------------------------------------------------------------------
type Caller = ReturnType<typeof import("./routers").appRouter.createCaller>;
let api: Caller;
let shared: PgSupabase | null = null;
const closers: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  vi.resetModules();
  if (!shared) shared = await (await import("./test-utils/pg-supabase")).createPgSupabase();
  await shared.reset();
  holder.db = shared;
  const { ENV } = await import("./_core/env");
  ENV.supabaseUrl = "http://supabase.test";
  ENV.supabaseServiceRoleKey = "test-service-role";
  api = (await import("./routers")).appRouter.createCaller({} as never);
  await api.dashboard.settings();
}, 60_000);
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); vi.restoreAllMocks(); });

async function serve() {
  const { createApp } = await import("./_core/app");
  const server = createApp({ dashboardPin: "", production: false, whatsappTransport: "baileys" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, get: (url: string) => fetch(base + url), post: (url: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(base + url, { method: "POST", headers, body }) };
}
const quotationInput = { clientName: "Prablo 360", projectName: "Site", intro: "Intro", items: [{ description: "Website", bullets: ["Responsive"], cost: 40_000 }] };
async function startedJob(cost = 40_000) {
  const job = await api.jobs.create({ clientName: "Prablo 360", title: "Company website" });
  const doc = await api.documents.createQuotation({ jobId: job.id, quotation: { ...quotationInput, items: [{ description: "Website", bullets: [], cost }] } });
  await api.documents.markSent({ id: doc.id });
  await api.jobs.approveQuotation({ quotationId: doc.id });
  await api.jobs.startProject({ jobId: job.id, amount: cost * 0.4, idempotencyKey: `start-${job.id}` });
  return { job, doc };
}

describe("PDF download routes", () => {
  it("downloads a quotation as an attachment that is never cached", async () => {
    const { doc } = await startedJob();
    const app = await serve();
    const response = await app.get(`/api/documents/${doc.id}/pdf`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="Quotation-09248.pdf"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("builds every kind of stored document, the voided ones stamped", async () => {
    const { job } = await startedJob();
    const app = await serve();
    const contractDoc = await api.documents.createContract({ jobId: job.id, contract: {} });
    const advance = await api.documents.createInvoice({ jobId: job.id, basis: "balance" });
    const [start] = await api.ledger.list({ jobId: job.id });
    const receiptDoc = await api.documents.createReceipt({ ledgerEntryId: start.id });
    const tech = await api.documents.saveTechnical({ jobId: job.id, overview: "o", frontend: "f", backend: "b", database: "d", installation: "i", apis: "a" });
    const design = await api.documents.saveDesign({ jobId: job.id, sitemap: "s", figmaLink: "", primaryColor: "", secondaryColor: "", accentColor: "", fonts: "", responsive: "" });
    for (const doc of [contractDoc, advance, receiptDoc, tech, design]) {
      const response = await app.get(`/api/documents/${doc.id}/pdf`);
      expect(response.status, doc.kind).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), doc.kind).toBe("%PDF-");
    }
    await api.ledger.void({ id: start.id, reason: "recorded twice" });
    const voided = await app.get(`/api/documents/${receiptDoc.id}/pdf`); // a voided receipt stays downloadable
    expect(voided.status).toBe(200);
  });

  it("answers an unknown or malformed id with a plain error, and a contract whose approval was revoked with a refusal", async () => {
    const app = await serve();
    expect((await app.get("/api/documents/11111111-1111-4111-8111-111111111111/pdf")).status).toBe(404);
    expect((await app.get("/api/documents/not-an-id/pdf")).status).toBe(400);
    const job = await api.jobs.create({ clientName: "A", title: "B" });
    const q = await api.documents.createQuotation({ jobId: job.id, quotation: quotationInput });
    await api.documents.markSent({ id: q.id });
    await api.jobs.approveQuotation({ quotationId: q.id });
    const contractDoc = await api.documents.createContract({ jobId: job.id, contract: {} });
    await api.jobs.revokeApproval({ jobId: job.id });
    const response = await app.get(`/api/documents/${contractDoc.id}/pdf`);
    expect(response.status).toBe(412);
    expect((await response.json()).error).toMatch(/approved quotation/);
  });

  it("exports the ledger as CSV, ignoring a malformed month", async () => {
    const { job } = await startedJob();
    await api.ledger.recordExpense({ jobId: job.id, category: "hosting", amount: 9_000, note: "=1+1" });
    const app = await serve();
    const response = await app.get("/api/finance/ledger.csv?month=not-a-month");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="ledger-all-time.csv"');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // a byte-order mark, so a spreadsheet reads it as UTF-8
    const text = bytes.toString("utf8");
    expect(text).toContain('"date","type"');
    expect(text).toContain("\"'=1+1\"");
  });
});

// ----- Credentials ---------------------------------------------------------------------------------------------------------
describe("credentials PDF", () => {
  const SENTINEL = "SENTINEL-s3cr3t-Pa55word-7f3a91";
  const rows = [{ service: "Hosting Service", url: "https://host.example", username: `user-${SENTINEL}`, password: SENTINEL }, { service: "Domain Registrar", url: "", username: "", password: `${SENTINEL}-2` }];

  // Everything the process printed while a request ran.
  function captureOutput() {
    const seen: string[] = [];
    const record = (...args: unknown[]) => { seen.push(args.map((arg) => (typeof arg === "string" ? arg : (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })())).join(" ")); };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(record);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { record(String(chunk)); return true; }) as never);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { record(String(chunk)); return true; }) as never);
    return { seen, stop: () => { out.mockRestore(); err.mockRestore(); } };
  }
  async function everythingStored() {
    const tables = (await holder.db.pg.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")).rows.map((row) => row.tablename);
    let dump = "";
    for (const table of tables) dump += JSON.stringify((await holder.db.pg.query(`select to_jsonb(t) as row from public."${table}" t`)).rows) + "\n";
    return dump;
  }

  it("returns a PDF with the values in it, and keeps them nowhere", async () => {
    const { job } = await startedJob();
    await api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 24_000 }); // fully paid
    const app = await serve();
    const output = captureOutput();
    let response: Response;
    try { response = await app.post("/api/documents/credentials/pdf", JSON.stringify({ jobId: job.id, rows })); } finally { output.stop(); }
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="Credentials-Access-/);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

    expect(await everythingStored()).not.toContain("SENTINEL");
    expect(output.seen.join("\n")).not.toContain("SENTINEL");
    const events = (await holder.db.pg.query<{ event_type: string; detail: string }>("select event_type, detail from event_log where event_type like 'credentials%'")).rows;
    expect(events.map((event) => event.event_type)).toEqual(["credentials_pdf"]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });

  it("refuses while a balance is outstanding, and with the owner's confirmation logs the override without the values", async () => {
    const { job } = await startedJob();
    const app = await serve();
    const refused = await app.post("/api/documents/credentials/pdf", JSON.stringify({ jobId: job.id, rows }));
    expect(refused.status).toBe(412);
    const body = await refused.json();
    expect(body).toMatchObject({ code: "BALANCE_OUTSTANDING", outstanding: 24_000 });
    expect(JSON.stringify(body)).not.toContain("SENTINEL");
    expect((await holder.db.pg.query("select 1 from event_log where event_type like 'credentials%'")).rows).toHaveLength(0);

    const output = captureOutput();
    let allowed: Response;
    try { allowed = await app.post("/api/documents/credentials/pdf", JSON.stringify({ jobId: job.id, rows, confirmUnpaid: true })); } finally { output.stop(); }
    expect(allowed.status).toBe(200);
    const events = (await holder.db.pg.query<{ event_type: string; severity: string; detail: string }>("select event_type, severity, detail from event_log where event_type like 'credentials%' order by created_at")).rows;
    expect(events.map((event) => event.event_type)).toEqual(["credentials_override", "credentials_pdf"]);
    expect(events[0]).toMatchObject({ severity: "warning" });
    expect(events[0].detail).toContain("24000.00 unpaid");
    expect(await everythingStored()).not.toContain("SENTINEL");
    expect(output.seen.join("\n")).not.toContain("SENTINEL");
  });

  it("does not echo or log the values when the request is malformed, too large, or the server fails", async () => {
    const { job } = await startedJob();
    await api.ledger.recordPayment({ jobId: job.id, category: "final", amount: 24_000 });
    const app = await serve();
    const output = captureOutput();
    const answers: string[] = [];
    try {
      // Not valid JSON: the parser's own message would quote part of the body.
      const broken = await app.post("/api/documents/credentials/pdf", `{"jobId":"${job.id}","rows":[{"password":"${SENTINEL}", oops`);
      answers.push(`${broken.status} ${await broken.text()}`);
      expect(broken.status).toBe(400);
      // Too large.
      const huge = await app.post("/api/documents/credentials/pdf", JSON.stringify({ jobId: job.id, rows: [{ password: SENTINEL, service: "x".repeat(40_000) }] }));
      answers.push(`${huge.status} ${await huge.text()}`);
      expect(huge.status).toBeGreaterThanOrEqual(400);
      // A failure inside the server while the values are in memory.
      const original = holder.db.from.bind(holder.db);
      vi.spyOn(holder.db, "from").mockImplementation((table: string) => { if (table === "ledger_entries") throw new Error("database exploded"); return original(table); });
      const failed = await app.post("/api/documents/credentials/pdf", JSON.stringify({ jobId: job.id, rows }));
      answers.push(`${failed.status} ${await failed.text()}`);
      expect(failed.status).toBe(500);
    } finally { output.stop(); }
    expect(answers.join("\n")).not.toContain("SENTINEL");
    expect(output.seen.join("\n")).not.toContain("SENTINEL");
    expect(await everythingStored()).not.toContain("SENTINEL");
  });

  it("answers bad requests clearly, and only for a started job", async () => {
    const app = await serve();
    expect((await app.post("/api/documents/credentials/pdf", JSON.stringify({ rows: [] }))).status).toBe(400);
    expect((await app.post("/api/documents/credentials/pdf", JSON.stringify({ jobId: "11111111-1111-4111-8111-111111111111", rows: [] }))).status).toBe(404);
    const lead = await api.jobs.create({ clientName: "A", title: "B" });
    expect((await app.post("/api/documents/credentials/pdf", JSON.stringify({ jobId: lead.id, rows: [] }))).status).toBe(412);
  });

  it("has no place in the schema for a credential value", async () => {
    const columns = (await holder.db.pg.query<{ table_name: string; column_name: string }>("select table_name, column_name from information_schema.columns where table_schema = 'public'")).rows;
    expect(columns.filter((column) => /passw|credential|secret/i.test(column.column_name) && !["baileys_auth_state"].includes(column.table_name))).toEqual([]);
    const migrations = fs.readdirSync(path.resolve(import.meta.dirname, "../supabase/migrations")).filter((name) => name >= "20261029");
    for (const name of migrations) expect(fs.readFileSync(path.resolve(import.meta.dirname, "../supabase/migrations", name), "utf8").replace(/--.*$/gm, ""), name).not.toMatch(/password/i); // the task "Credentials handover" is only a title; no column or value holds a secret
  });

  it("keeps credential values out of every piece of client code that could store them", () => {
    const root = path.resolve(import.meta.dirname, "../client/src");
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(tsx?|ts)$/.test(entry.name)) files.push(full); } };
    walk(root);
    const handlesPasswords = files.filter((file) => /credentials\/pdf/.test(fs.readFileSync(file, "utf8")));
    expect(handlesPasswords.map((file) => path.basename(file))).toEqual(["DocumentsTab.tsx"]);
    for (const file of handlesPasswords) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      const modal = source.slice(source.indexOf("function CredentialsModal"));
      expect(modal).not.toMatch(/useMutation|useQuery|trpc\./); // a tRPC mutation would keep its variables in the query cache
      expect(modal).toMatch(/fetch\("\/api\/documents\/credentials\/pdf"/);
      expect(modal).toMatch(/cache: "no-store"/);
    }
  });
});
