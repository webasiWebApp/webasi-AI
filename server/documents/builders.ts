import { formatLkr } from "../../shared/money";
import { dottedDate, addDays } from "../../shared/time";
import { paymentScheduleText, paymentTermsLines, type ContractPayload, type DesignDocPayload, type DocumentSettings, type InvoicePayload, type QuotationPayload, type ReceiptPayload, type TechnicalDocPayload } from "../../shared/documents";
import { BLUE, BODY_LIMIT, INK, LEFT, PAGE, RIGHT, amount, bullet, collect, drawFooter, drawLogo, newDocument, noMargins, pageWithFurniture, rule, safe, textAt, wrap, type BrandOptions } from "./brand";

// Each builder takes plain data and returns the PDF as a Buffer. Nothing is written to disk.
const BODY = { size: 9.6, spacing: 0.55 };
const SECTION_BULLET = { width: 458, size: 9.2, lineHeight: 11.8, spacing: 0.6 };
const LABEL = { font: "Sans-Bold" as const, size: 10.6, color: BLUE, spacing: 0.75 };
const date = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? dottedDate(value) : value);

type Doc = PDFKit.PDFDocument;

// The title block shared by the quotation, invoice and receipt: the registration number, the big title and the numbers on the right.
function head(doc: Doc, input: { regNo: string; title: string[]; meta: Array<{ label: string; value: string; strong?: boolean }> }) {
  if (input.regNo) {
    const value = ` ${input.regNo}`;
    doc.font("Sans").fontSize(7.2);
    const width = doc.widthOfString(value, { characterSpacing: 0.6 });
    textAt(doc, value, RIGHT, 171, { size: 7.2, spacing: 0.6, align: "right" });
    textAt(doc, "REG NO:", RIGHT - width, 171, { font: "Sans-Bold", size: 7.2, color: BLUE, spacing: 0.6, align: "right" });
  }
  input.title.forEach((line, index) => textAt(doc, line, LEFT, 204.2 + index * 42.5, { font: "Sans-Bold", size: 36, spacing: 4.1 }));
  input.meta.forEach((row, index) => {
    const baseline = 195 + index * 15;
    textAt(doc, row.value, RIGHT, baseline, { font: row.strong ? "Sans-Bold" : "Sans", size: 10.6, color: row.strong ? BLUE : INK, spacing: 0.9, align: "right" });
    textAt(doc, row.label, 486.2, baseline, { font: row.strong ? "Sans-Bold" : "Sans", size: 10.6, color: row.strong ? BLUE : INK, spacing: 0.75, align: "right" });
  });
}

// Rows of "LABEL :  value" down the left side. Returns the baseline of the last line used.
function facts(doc: Doc, startBaseline: number, rows: Array<[string, string]>): number {
  let baseline = startBaseline;
  rows.forEach(([label, value], index) => {
    textAt(doc, `${label} :`, LEFT, baseline, LABEL);
    doc.font("Sans").fontSize(10.6);
    const lines = wrap(doc, safe(doc, value), 330, 0.8);
    lines.forEach((line, i) => textAt(doc, line, 166.2, baseline + i * 12, { size: 10.6, spacing: 0.6 }));
    baseline += 16.3 + (lines.length - 1) * 12;
    void index;
  });
  return baseline - 16.3;
}

function paragraph(doc: Doc, text: string, baseline: number, width = 490): number {
  doc.font("Sans").fontSize(BODY.size);
  const lines = wrap(doc, safe(doc, text), width, BODY.spacing);
  lines.forEach((line, index) => textAt(doc, line, LEFT, baseline + index * 11.45, { ...BODY }));
  return baseline + (lines.length - 1) * 11.45;
}

type Line = { description: string; bullets?: string[]; cost: number };

// The cost table: a bold description with its cost on the right, then its bullets. Flows onto a new page when it must.
function table(doc: Doc, brand: BrandOptions, input: { header: string; costHeader: [string, string]; items: Line[]; startBaseline: number }): number {
  textAt(doc, input.header, LEFT, input.startBaseline, LABEL);
  textAt(doc, input.costHeader[0], 489.5, input.startBaseline - 8.6, { ...LABEL, align: "center", spacing: 0.9 });
  textAt(doc, input.costHeader[1], 489.5, input.startBaseline + 3, { ...LABEL, align: "center", spacing: 0.9 });
  rule(doc, input.startBaseline + 9.8, LEFT, 512.4);
  let baseline = input.startBaseline + 35.4;
  const room = 735;
  for (const item of input.items) {
    const blocks = [...(item.bullets ?? [])];
    if (baseline + 16.4 + Math.min(blocks.length, 3) * 10.5 > room) { pageWithFurniture(doc, brand); baseline = 180; }
    textAt(doc, item.description, 64.8, baseline, { font: "Sans-Bold", size: 9.6, spacing: 0.9 });
    textAt(doc, amount(item.cost), 506.5, baseline, { size: 9.6, spacing: 0.9, align: "right" });
    baseline += 16.4;
    for (const text of blocks) {
      if (baseline > room) { pageWithFurniture(doc, brand); baseline = 180; }
      baseline = bullet(doc, text, 64.1, baseline, { width: 430, size: 9.6, lineHeight: 10.5, spacing: 0.9 }) + 10.5;
    }
    baseline += 8;
  }
  return baseline;
}

function totals(doc: Doc, brand: BrandOptions, input: { after: number; rows: Array<{ label: string; value: number; blue?: boolean }> }) {
  let ruleY = Math.max(input.after + 6, 732.3);
  let newPage = false;
  if (ruleY + 19 + (input.rows.length - 1) * 24.8 > BODY_LIMIT) { pageWithFurniture(doc, brand); ruleY = 180; newPage = true; }
  rule(doc, ruleY, 59.5, 516.3, 0.8, "#000000");
  input.rows.forEach((row, index) => {
    const baseline = ruleY + 19 + index * 24.8;
    textAt(doc, row.label, row.blue ? 62.8 : 438.4, baseline, { font: "Sans-Bold", size: 10.6, color: row.blue ? BLUE : INK, spacing: 0.9, align: row.blue ? "left" : "right" });
    textAt(doc, amount(row.value), 505.2, baseline, { font: "Sans-Bold", size: 10.6, spacing: 1, align: "right" });
  });
  return { ruleY, newPage, end: ruleY + 19 + (input.rows.length - 1) * 24.8 };
}

// A heading, its rule and its lines, as on the second page of the quotation. Returns the next heading's baseline.
function section(doc: Doc, brand: BrandOptions, state: { baseline: number }, title: string, build: (at: number) => number) {
  if (state.baseline > 700) { pageWithFurniture(doc, brand); state.baseline = 196.3; }
  textAt(doc, title, 58.2, state.baseline, LABEL);
  rule(doc, state.baseline + 13.1, 58.2, 515);
  const last = build(state.baseline + 30);
  state.baseline = last + 41;
}

// ----- Quotation -------------------------------------------------------------------------------------------------------
export async function quotationPdf(input: { number: string; payload: QuotationPayload; registrationNo: string; businessName?: string }): Promise<Buffer> {
  const { payload } = input;
  const brand: BrandOptions = { footerLinks: payload.footerLinks };
  const doc = newDocument({ title: `Quotation ${input.number}`, subject: `Quotation for ${payload.clientName}` });
  pageWithFurniture(doc, brand);
  head(doc, { regNo: input.registrationNo, title: ["PROJECT", "QUOTATION"], meta: [{ label: "INVOICE NO:", value: input.number, strong: true }, { label: "DATE:", value: date(payload.date) }, { label: "DUE DATE:", value: date(payload.dueDate) }] });
  const last = facts(doc, 306.3, [["PROJECT NAME", payload.projectName], ["CLIENT NAME", payload.clientName]]);
  const introEnd = payload.intro.trim() ? paragraph(doc, payload.intro, last + 19.3) : last;
  const bottom = table(doc, brand, { header: "DESCRIPTION (INITIAL DEVELOPMENT)", costHeader: ["COST", "(LKR)"], items: payload.items, startBaseline: introEnd + 32.7 });
  totals(doc, brand, { after: bottom, rows: [{ label: "SUBTOTAL", value: payload.subtotal, blue: true }, { label: "TOTAL", value: payload.total }] });

  pageWithFurniture(doc, brand);
  const state = { baseline: 196.3 };
  const list = (lines: string[]) => (at: number) => lines.reduce((position, line) => bullet(doc, line, 63.5, position, SECTION_BULLET) + 11.8, at) - 11.8;
  section(doc, brand, state, "PAYMENT TERMS", list(paymentTermsLines(payload.advancePercent)));
  if (payload.infrastructure.length) section(doc, brand, state, "INFRASTRUCTURE", list(payload.infrastructure.map((row) => `${row.label}: ${row.text}`)));
  if (payload.afterService.length) section(doc, brand, state, "AFTER SERVICE", list(payload.afterService));
  if (payload.timelineDuration || payload.milestones.length) {
    section(doc, brand, state, "TIMELINE & MILESTONES", (at) => {
      let position = at;
      if (payload.timelineDuration) { textAt(doc, `Estimated Duration: ${payload.timelineDuration}`, 58.2, position, { ...BODY, spacing: 0.9 }); position += 23.5; }
      return payload.milestones.reduce((cursor, row) => bullet(doc, `${row.label}: ${row.text}`, 63.5, cursor, SECTION_BULLET) + 13.7, position) - 13.7;
    });
  }
  if (payload.portfolioMain || payload.portfolioLinks.length) {
    section(doc, brand, state, "RELEVANT PORTFOLIO", (at) => {
      let position = at - 2;
      if (payload.portfolioMain) {
        textAt(doc, "Portfolio : ", 56.9, position, { ...BODY, spacing: 0.9 });
        doc.font("Sans").fontSize(9.6);
        const x = 56.9 + doc.widthOfString("Portfolio : ", { characterSpacing: 0.9 });
        textAt(doc, payload.portfolioMain, x, position, { ...BODY, spacing: 0.9, underline: true, link: /^https?:/.test(payload.portfolioMain) ? payload.portfolioMain : `https://${payload.portfolioMain}` });
        position += 13.7;
      }
      for (const link of payload.portfolioLinks) { textAt(doc, link, 56.9, position, { ...BODY, spacing: 0.9, link: /^https?:/.test(link) ? link : undefined }); position += 13.7; }
      return position - 13.7;
    });
  }
  return collect(doc);
}

// ----- Invoice, renewal invoice ------------------------------------------------------------------------------------------
export async function invoicePdf(input: { number: string; payload: InvoicePayload; registrationNo: string; bankDetails: string; footerLinks: BrandOptions["footerLinks"]; void?: boolean }): Promise<Buffer> {
  const { payload } = input;
  const brand: BrandOptions = { footerLinks: input.footerLinks };
  const doc = newDocument({ title: `Invoice ${input.number}`, subject: `Invoice for ${payload.clientName}` });
  pageWithFurniture(doc, brand);
  head(doc, { regNo: input.registrationNo, title: ["INVOICE"], meta: [{ label: "INVOICE NO:", value: input.number, strong: true }, { label: "DATE:", value: date(payload.date) }, { label: "DUE DATE:", value: date(payload.dueDate) }] });
  const last = facts(doc, 264, [["CLIENT NAME", payload.clientName], ...(payload.clientPhone ? [["PHONE", payload.clientPhone] as [string, string]] : []), ["PROJECT NAME", payload.projectName]]);
  const bottom = table(doc, brand, { header: "DESCRIPTION", costHeader: ["AMOUNT", "(LKR)"], items: payload.lines.map((line) => ({ description: line.description, cost: line.amount })), startBaseline: last + 40 });
  const placed = totals(doc, brand, { after: bottom, rows: [{ label: "TOTAL AMOUNT DUE", value: payload.total, blue: false }] });
  // The payment details go above the total when the table leaves room, below it when the table ran onto a new page, and on a
  // page of their own only when neither fits.
  const rows = [`Payment Method: ${payload.paymentMethod}`, `Payment Due By: ${date(payload.dueDate)}`, ...(input.bankDetails.trim() ? input.bankDetails.trim().split("\n").map((line) => line.trim()).filter(Boolean) : [])];
  const needed = 60 + rows.length * 12;
  const state = { baseline: 0 };
  if (!placed.newPage && bottom + 24 + needed <= placed.ruleY - 8) state.baseline = bottom + 24;
  else if (placed.newPage && placed.end + 40 + needed <= BODY_LIMIT) state.baseline = placed.end + 40;
  else { pageWithFurniture(doc, brand); state.baseline = 196.3; }
  section(doc, brand, state, "PAYMENT TERMS", (at) => rows.reduce((position, row) => bullet(doc, row, 63.5, position, SECTION_BULLET) + 11.8, at) - 11.8);
  if (input.void) stampVoid(doc);
  return collect(doc);
}

// ----- Receipt -------------------------------------------------------------------------------------------------------
const CATEGORY_TEXT: Record<string, string> = { advance: "advance payment", final: "final payment", extra: "extra work", renewal: "renewal" };
export async function receiptPdf(input: { number: string; payload: ReceiptPayload; registrationNo: string; footerLinks: BrandOptions["footerLinks"]; void?: boolean }): Promise<Buffer> {
  const { payload } = input;
  const brand: BrandOptions = { footerLinks: input.footerLinks };
  const doc = newDocument({ title: `Receipt ${input.number}`, subject: `Receipt for ${payload.clientName}` });
  pageWithFurniture(doc, brand);
  head(doc, { regNo: input.registrationNo, title: ["RECEIPT"], meta: [{ label: "RECEIPT NO:", value: input.number, strong: true }, { label: "DATE:", value: date(payload.date) }, ...(payload.invoiceNumber ? [{ label: "INVOICE NO:", value: payload.invoiceNumber }] : [])] });
  const last = facts(doc, 264, [["RECEIVED FROM", payload.clientName], ["PROJECT NAME", payload.projectName]]);
  const method = payload.method.replace("_", " ");
  const bottom = table(doc, brand, { header: "DESCRIPTION", costHeader: ["AMOUNT", "(LKR)"], items: [{ description: `Payment received – ${CATEGORY_TEXT[payload.category] ?? payload.category}`, bullets: [`Method: ${method}`, ...(payload.note ? [payload.note] : [])], cost: payload.amount }], startBaseline: last + 40 });
  totals(doc, brand, { after: bottom, rows: [{ label: "AMOUNT RECEIVED", value: payload.amount, blue: true }, { label: "BALANCE", value: payload.balanceAfter }] });
  if (input.void) stampVoid(doc);
  return collect(doc);
}

// A voided receipt stays on file and downloadable, stamped across the page.
function stampVoid(doc: Doc) {
  const range = doc.bufferedPageRange?.();
  const mark = () => {
    doc.save();
    doc.rotate(-32, { origin: [PAGE.width / 2, PAGE.height / 2] });
    doc.fillColor("#DC2626").opacity(0.2).font("Sans-Bold").fontSize(140);
    const width = doc.widthOfString("VOID", { characterSpacing: 10 });
    noMargins(doc, () => doc.text("VOID", (PAGE.width - width) / 2, PAGE.height / 2 - 70, { characterSpacing: 10, lineBreak: false }));
    doc.restore();
  };
  void range;
  mark();
}

// ----- Proposal and contract pack -----------------------------------------------------------------------------------------
const fill = (text: string, values: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key] ?? "").replace(/\[Start Date\]/g, values.startDate ?? "[Start Date]").replace(/\[Client Name\]/g, values.clientName ?? "[Client Name]");

// Flowing text with automatic page breaks. Every page, including the ones pdfkit adds itself, gets the logo and the footer.
function flowing(info: { title: string; subject: string }, brand: BrandOptions) {
  const doc = newDocument(info, { margins: { top: 146, bottom: 62, left: 56, right: 56 } });
  doc.on("pageAdded", () => { const x = doc.x, y = doc.y; drawLogo(doc); drawFooter(doc, brand); doc.x = x; doc.y = y; });
  const width = PAGE.width - 112;
  const api = {
    doc,
    newPage() { doc.addPage(); },
    title(text: string) { doc.font("Sans-Bold").fontSize(15).fillColor(BLUE).text(safe(doc, text.toUpperCase()), 56, doc.y, { width, characterSpacing: 2 }); doc.moveDown(0.8); },
    heading(text: string) { doc.moveDown(0.5); doc.font("Sans-Bold").fontSize(10.6).fillColor(INK).text(safe(doc, text), 56, doc.y, { width, characterSpacing: 0.5 }); doc.moveDown(0.25); },
    para(text: string, options: { bold?: boolean; indent?: number; tight?: boolean } = {}) { doc.font(options.bold ? "Sans-Bold" : "Sans").fontSize(9.8).fillColor(INK).text(safe(doc, text), 56 + (options.indent ?? 0), doc.y, { width: width - (options.indent ?? 0), characterSpacing: 0.3, lineGap: 2 }); doc.moveDown(options.tight ? 0.12 : 0.3); },
    kv(label: string, value: string) { doc.font("Sans-Bold").fontSize(10.6).fillColor(BLUE).text(safe(doc, `${label} :`), 56, doc.y, { width, continued: true, characterSpacing: 1.2 }); doc.font("Sans").fillColor(INK).text(safe(doc, `  ${value}`), { characterSpacing: 0.5 }); doc.moveDown(0.45); },
    signature(left: string, right: string) {
      if (doc.y > PAGE.height - 160) doc.addPage();
      const y = doc.y + 34;
      for (const [x, label] of [[56, left], [310, right]] as const) { rule(doc, y, x, x + 190, 0.7); doc.font("Sans").fontSize(9).fillColor(INK).text(safe(doc, label), x, y + 4, { width: 190, lineBreak: false }); }
      doc.y = y + 30;
    },
  };
  return api;
}

export async function contractPdf(input: { number: string; payload: ContractPayload; quotation: QuotationPayload; settings: DocumentSettings; brand: BrandOptions }): Promise<Buffer> {
  const { payload, quotation, settings } = input;
  const f = flowing({ title: `Proposal & contract ${input.number}`, subject: `Contract for ${payload.clientName}` }, input.brand);
  const { doc } = f;
  const values = {
    totalFee: formatLkr(quotation.total), paymentSchedule: paymentScheduleText(quotation.advancePercent), paymentMethod: payload.paymentMethod,
    startDate: date(payload.startDate), completionDate: date(payload.completionDate), clientName: payload.clientName,
  };

  // Cover
  doc.addPage();
  doc.y = 250;
  f.kv("Project Title", payload.title);
  f.kv("Project Name", payload.projectName);
  f.kv("Client Name", payload.clientName);
  f.kv("Date of Delivery", date(payload.dateOfDelivery));

  // Service contract
  f.newPage();
  f.title("Service Contract");
  f.para(fill(payload.agreementIntro ?? settings.agreementIntro, values));
  f.para(`The Freelancer: ${payload.receivingParty}`, { bold: true });
  f.para(`The Client: ${payload.clientName}`, { bold: true });
  (payload.clauses ?? settings.contractClauses).forEach((clause, index) => {
    f.heading(`${index + 1}. ${clause.title}`);
    clause.lines.forEach((line) => f.para(fill(line, values), { tight: clause.lines.length > 1 }));
    // The scope of work is the quotation's line items unless the owner changed it.
    if (/scope/i.test(clause.title)) payload.scope.forEach((line) => { const sub = line.startsWith("  "); f.para(sub ? `– ${line.trim().replace(/^[–-]\s*/, "")}` : line, { indent: sub ? 14 : 0, tight: true }); });
  });
  f.signature("The Freelancer", "The Client");

  // Non-disclosure agreement
  f.newPage();
  f.title("Non-Disclosure Agreement (NDA)");
  f.para(fill(payload.ndaIntro ?? settings.ndaIntro, values));
  f.para(`Disclosing Party: ${payload.clientName}`, { bold: true });
  f.para(`Receiving Party: ${payload.receivingParty}`, { bold: true });
  (payload.ndaClauses ?? settings.ndaClauses).forEach((clause, index) => {
    f.heading(`${index + 1}. ${clause.title}`);
    clause.lines.forEach((line) => f.para(fill(line, values), { tight: clause.lines.length > 1 }));
  });
  f.para(payload.ndaClosing ?? settings.ndaClosing);
  f.signature("Disclosing Party", "Receiving Party");

  // Support and maintenance
  f.newPage();
  f.title("Support & Maintenance");
  f.kv("Support period", payload.supportPeriod);
  f.kv("Contact for support", payload.supportContact);
  return collect(doc);
}

// ----- Technical and design documentation ---------------------------------------------------------------------------------
export async function technicalDocPdf(input: { number: string; clientName: string; projectName: string; payload: TechnicalDocPayload; brand: BrandOptions }): Promise<Buffer> {
  const f = flowing({ title: `Technical documentation ${input.number}`, subject: input.projectName }, input.brand);
  f.doc.addPage();
  f.title("Technical Documentation");
  f.kv("Project", input.projectName);
  f.kv("Client", input.clientName);
  f.heading("1. Overview"); f.para(input.payload.overview || "—");
  f.heading("2. Technologies Used");
  f.para(`Frontend: ${input.payload.frontend || "—"}`); f.para(`Backend: ${input.payload.backend || "—"}`); f.para(`Database: ${input.payload.database || "—"}`);
  f.heading("3. Installation & Deployment"); f.para(input.payload.installation || "—");
  f.heading("4. APIs / Plugin and Its Integrations"); f.para(input.payload.apis || "—");
  return collect(f.doc);
}

export async function designDocPdf(input: { number: string; clientName: string; projectName: string; payload: DesignDocPayload; brand: BrandOptions }): Promise<Buffer> {
  const f = flowing({ title: `Design documentation ${input.number}`, subject: input.projectName }, input.brand);
  f.doc.addPage();
  f.title("Design Documentation");
  f.kv("Project", input.projectName);
  f.kv("Client", input.clientName);
  f.heading("1. Sitemap"); f.para(input.payload.sitemap || "—");
  f.heading("2. Wireframes & UI Design"); f.para(input.payload.figmaLink ? `Figma: ${input.payload.figmaLink}` : "—");
  f.heading("3. Style Guide");
  f.para(`Colors: primary ${input.payload.primaryColor || "—"}, secondary ${input.payload.secondaryColor || "—"}, accent ${input.payload.accentColor || "—"}`);
  f.para(`Typography: ${input.payload.fonts || "—"}`);
  f.heading("4. Responsive Design"); f.para(input.payload.responsive || "—");
  return collect(f.doc);
}

// ----- Credentials & access ------------------------------------------------------------------------------------------------
// Built in memory from values typed at handover and streamed straight back. Nothing here stores or logs them.
export type CredentialRow = { service: string; url: string; username: string; password: string };
export async function credentialsPdf(input: { clientName: string; projectName: string; rows: CredentialRow[]; supportPeriod: string; supportContact: string; brand: BrandOptions }): Promise<Buffer> {
  const f = flowing({ title: "Credentials & Access", subject: input.projectName }, input.brand);
  const { doc } = f;
  doc.addPage();
  f.title("Credentials & Access");
  f.kv("Project", input.projectName);
  f.kv("Client", input.clientName);
  doc.moveDown(0.6);
  const columns = [{ title: "Service", width: 105 }, { title: "URL", width: 150 }, { title: "UserName", width: 106 }, { title: "Password", width: 122 }];
  const x0 = 56;
  const drawRow = (cells: string[], header: boolean) => {
    doc.font(header ? "Sans-Bold" : "Sans").fontSize(9.2);
    const heights = cells.map((cell, index) => doc.heightOfString(safe(doc, cell) || " ", { width: columns[index].width - 10, characterSpacing: 0.2 }));
    const height = Math.max(24, Math.max(...heights) + 12);
    if (doc.y + height > PAGE.height - 70) doc.addPage();
    const top = doc.y;
    let x = x0;
    cells.forEach((cell, index) => {
      doc.save().rect(x, top, columns[index].width, height).lineWidth(0.7).strokeColor("#94A3B8");
      if (header) doc.fillAndStroke("#EFF6FF", "#94A3B8"); else doc.stroke();
      doc.restore();
      doc.font(header ? "Sans-Bold" : "Sans").fontSize(9.2).fillColor(header ? BLUE : INK).text(safe(doc, cell), x + 5, top + 6, { width: columns[index].width - 10, characterSpacing: 0.2, lineBreak: true });
      x += columns[index].width;
    });
    doc.x = x0; doc.y = top + height;
  };
  drawRow(columns.map((column) => column.title), true);
  for (const row of input.rows) drawRow([row.service, row.url, row.username, row.password], false);
  doc.moveDown(1.2);
  doc.x = 56;
  f.title("Support & Maintenance");
  f.kv("Support period", input.supportPeriod);
  f.kv("Contact for support", input.supportContact);
  return collect(doc);
}

export { addDays };
