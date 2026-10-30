import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

// The look of the owner's documents, taken from his quotation PDF (docs/reference/chandranath__company.pdf): A4, the
// WEBASI logo centred at the top, letter-spaced bold blue labels, grey rules and a blue footer band. The fonts and the
// logo are files in this folder, because serverless hosting cannot fetch them and a headless browser is not available.
export const BLUE = "#0070FF";
export const INK = "#3C3B3A";
export const PAGE = { width: 595.28, height: 841.89 };
export const LEFT = 55.6;
export const RIGHT = 557.6;
export const FOOTER_TOP = 806.9;
export const BODY_LIMIT = 792;

// Where the bundled files live: next to this module when running from source, or under the project root when the server
// is the esbuild bundle (dist/index.js): next to it in the checkout (dist/../server/documents), or under the working directory.
function assetRoots() {
  return [import.meta.dirname, path.resolve(import.meta.dirname, "../server/documents"), path.resolve(process.cwd(), "server/documents")].filter(Boolean);
}
export function assetPath(relative: string): string {
  for (const root of assetRoots()) {
    const candidate = path.join(root, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Document asset ${relative} was not found. Expected it under server/documents (looked in: ${assetRoots().join(", ")}).`);
}

const cache = new Map<string, Buffer>();
const asset = (relative: string) => { let file = cache.get(relative); if (!file) { file = fs.readFileSync(assetPath(relative)); cache.set(relative, file); } return file; };

export type DocumentInfo = { title: string; author?: string; subject?: string };

export function newDocument(info: DocumentInfo, options: { margins?: { top: number; bottom: number; left: number; right: number } } = {}) {
  const doc = new PDFDocument({ size: "A4", autoFirstPage: false, margins: options.margins ?? { top: 0, bottom: 0, left: 0, right: 0 }, info: { Title: info.title, Author: info.author ?? "WEBASI", Subject: info.subject ?? info.title, Creator: "WEBASI" } });
  doc.registerFont("Sans", asset("fonts/OpenSans-Regular.ttf"));
  doc.registerFont("Sans-Bold", asset("fonts/OpenSans-Bold.ttf"));
  return doc;
}

export function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// The bundled font covers Latin, Greek and Cyrillic. Anything it has no glyph for (for example Sinhala or Tamil letters in
// a client name) would print as an empty box, so it becomes "?" instead; the line is never dropped.
export function safe(doc: PDFKit.PDFDocument, text: unknown): string {
  const value = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const font = (doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } })._font?.font;
  if (!font?.hasGlyphForCodePoint) return value;
  let out = "";
  for (const char of value) out += char === "\n" || char === "\t" || font.hasGlyphForCodePoint(char.codePointAt(0)!) ? char : "?";
  return out;
}

// Footer text is drawn below the page's bottom margin; without this pdfkit would add a page for it.
export function noMargins<T>(doc: PDFKit.PDFDocument, draw: () => T): T {
  const margins = { ...doc.page.margins };
  doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
  try { return draw(); } finally { doc.page.margins = margins; }
}

export type BrandOptions = { footerLinks: Array<{ label: string; url: string }> };

export function drawLogo(doc: PDFKit.PDFDocument) {
  doc.image(asset("assets/logo.png"), 240, 22, { width: 114 });
}

// Blue band across the bottom: the social icons and the site on the left, then the footer links.
export function drawFooter(doc: PDFKit.PDFDocument, { footerLinks }: BrandOptions) {
  noMargins(doc, () => {
    doc.save();
    doc.rect(0, FOOTER_TOP, PAGE.width, PAGE.height - FOOTER_TOP).fill(BLUE);
    doc.image(asset("assets/footer-icons.png"), 10, 811, { width: 44.6 });
    doc.restore();
    doc.font("Sans").fontSize(8.4).fillColor("#FFFFFF");
    const base = 822.4;
    const [site, ...rest] = footerLinks;
    if (site) doc.text(safe(doc, site.label), 58.6, base, { characterSpacing: 0.6, lineBreak: false, link: site.url || undefined });
    const links = rest.slice(0, 2);
    links.forEach((link, index) => {
      const label = safe(doc, link.label);
      const width = doc.widthOfString(label, { characterSpacing: 0.6 });
      const x = index === 0 ? 304.3 - width / 2 : RIGHT - 1.4 - width;
      doc.text(label, x, base, { characterSpacing: 0.6, lineBreak: false, underline: true, link: link.url || undefined });
    });
  });
}

// A page with the logo at the top and the footer band at the bottom.
export function pageWithFurniture(doc: PDFKit.PDFDocument, brand: BrandOptions) {
  doc.addPage();
  drawLogo(doc);
  drawFooter(doc, brand);
}

export const amount = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 });

// Text with its letter-spacing, drawn with the baseline at y (pdfkit positions by the top of the line).
export function textAt(doc: PDFKit.PDFDocument, text: string, x: number, baseline: number, options: { font?: "Sans" | "Sans-Bold"; size: number; color?: string; spacing?: number; align?: "left" | "right" | "center"; width?: number; underline?: boolean; link?: string }) {
  doc.font(options.font ?? "Sans").fontSize(options.size).fillColor(options.color ?? INK);
  const spacing = options.spacing ?? 0;
  const content = safe(doc, text);
  const ascent = options.size * 0.76; // Open Sans: roughly the distance from the top of the line box to the baseline
  let left = x;
  if (options.align === "right") left = x - doc.widthOfString(content, { characterSpacing: spacing }) + spacing;
  else if (options.align === "center") left = x - (doc.widthOfString(content, { characterSpacing: spacing }) - spacing) / 2;
  doc.text(content, left, baseline - ascent, { characterSpacing: spacing, lineBreak: false, underline: options.underline, link: options.link });
}

export function rule(doc: PDFKit.PDFDocument, y: number, x1: number, x2: number, width = 0.8, color = INK) {
  doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(width).strokeColor(color).stroke().restore();
}

// A bullet and its text, wrapped to a width. Returns the baseline of the last line.
export function bullet(doc: PDFKit.PDFDocument, text: string, x: number, baseline: number, options: { width: number; size?: number; lineHeight?: number; spacing?: number; marker?: string }) {
  const size = options.size ?? 9.6;
  const lineHeight = options.lineHeight ?? 10.5;
  const spacing = options.spacing ?? 0.6;
  doc.font("Sans").fontSize(size).fillColor(INK);
  const content = safe(doc, text);
  textAt(doc, options.marker ?? "•", x, baseline, { size, spacing: 0 });
  const left = x + 9.8;
  const lines = wrap(doc, content, options.width - 9.8, spacing);
  lines.forEach((line, index) => textAt(doc, line, left, baseline + index * lineHeight, { size, spacing }));
  return baseline + (lines.length - 1) * lineHeight;
}

// Words onto lines no wider than `width`, using the font as it is currently set. A word wider than the line is split.
export function wrap(doc: PDFKit.PDFDocument, text: string, width: number, spacing = 0): string[] {
  const measure = (value: string) => doc.widthOfString(value, { characterSpacing: spacing });
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let piece = word;
      while (measure(piece) > width && piece.length > 1) {
        let cut = piece.length - 1;
        while (cut > 1 && measure(piece.slice(0, cut)) > width) cut--;
        if (line) { lines.push(line); line = ""; }
        lines.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      const attempt = line ? `${line} ${piece}` : piece;
      if (measure(attempt) <= width) line = attempt;
      else { if (line) lines.push(line); line = piece; }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}
