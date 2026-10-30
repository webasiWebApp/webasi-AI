import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DOCUMENT_SETTINGS, quotationTotals, type ContractPayload, type InvoicePayload, type QuotationPayload, type ReceiptPayload } from "../shared/documents";
import { contractPdf, credentialsPdf, designDocPdf, invoicePdf, quotationPdf, receiptPdf, technicalDocPdf } from "../server/documents/builders";

// Writes one sample of every document the pipeline module can generate, to look at while changing the layout:
//   pnpm pdf:preview ./out
// The quotation uses the wording of the owner's sample (docs/reference/chandranath__company.pdf) so the two can be compared.
const outDir = path.resolve(process.argv[2] ?? "pdf-preview");
fs.mkdirSync(outDir, { recursive: true });
const d = DEFAULT_DOCUMENT_SETTINGS;
const brand = { footerLinks: d.footerLinks };

const items = [{ description: "Website Design & Development", cost: 40_000, bullets: ["Responsive design (Mobile, Tablet & Desktop)", "Up to 10 main pages", "Policy pages", "Image galleries", "Packages / Menu sections", "Customer Reviews", "Contact Form", "WhatsApp Integration", "Google Maps Integration", "Social Media Integration", "Basic SEO Setup", "SSL Configuration", "Google Analytics Integration", "Speed Optimization", "5 Businesses Emails", "Hosting for 1 year", "Domain for 1 year"] }];
const quotation: QuotationPayload = {
  clientName: "Prablo 360", projectName: "chandranath & company", date: "2026-10-16", dueDate: "2026-11-16", advancePercent: 40, items, ...quotationTotals(items),
  intro: "The website will include all sections requested in the RFQ, including pages content, business information, galleries, packages, contact information, Google Maps, WhatsApp integration, social media integration, and future-ready structure for additional locations.",
  infrastructure: d.infrastructure, afterService: d.afterService, timelineDuration: d.timelineDuration, milestones: d.milestones, portfolioMain: d.portfolioMain, portfolioLinks: d.portfolioLinks, footerLinks: d.footerLinks,
};
const invoice: InvoicePayload = { basis: "advance", clientName: "Prablo 360", clientPhone: "+94 77 000 0000", projectName: "chandranath & company", date: "2026-10-20", dueDate: "2026-11-03", paymentMethod: "Bank Transfer", lines: [{ description: "Advance payment (40% of the project price) – chandranath & company", amount: 16_000 }], total: 16_000 };
const receipt: ReceiptPayload = { clientName: "Prablo 360", projectName: "chandranath & company", date: "2026-10-21", amount: 16_000, method: "bank_transfer", category: "advance", balanceAfter: 24_000, invoiceNumber: "09249", note: "Slip checked" };
const contract: ContractPayload = { title: d.contractTitle, projectName: "chandranath & company", clientName: "Prablo 360", dateOfDelivery: "2026-11-05", agreementDate: "2026-10-21", startDate: "2026-10-21", completionDate: "2026-11-01", paymentMethod: "Bank Transfer", scope: items.flatMap((item) => [item.description, ...item.bullets.map((bullet) => `  – ${bullet}`)]), receivingParty: d.receivingParty, supportPeriod: d.supportPeriod, supportContact: d.supportContact };

const files: Array<[string, Promise<Buffer>]> = [
  ["quotation.pdf", quotationPdf({ number: "09247", payload: quotation, registrationNo: "260223052" })],
  ["invoice.pdf", invoicePdf({ number: "09249", payload: invoice, registrationNo: "260223052", bankDetails: "Bank: Example Bank\nAccount: 000 000 000", footerLinks: d.footerLinks })],
  ["receipt.pdf", receiptPdf({ number: "09250", payload: receipt, registrationNo: "260223052", footerLinks: d.footerLinks })],
  ["receipt-void.pdf", receiptPdf({ number: "09250", payload: receipt, registrationNo: "260223052", footerLinks: d.footerLinks, void: true })],
  ["contract.pdf", contractPdf({ number: "09251", payload: contract, quotation, settings: d, brand })],
  ["technical.pdf", technicalDocPdf({ number: "09252", clientName: "Prablo 360", projectName: "chandranath & company", brand, payload: { overview: "A Next.js site with a contact form.", frontend: "Next.js, Tailwind", backend: "Node.js", database: "None", installation: "pnpm install\npnpm build\nDeploy to Vercel.", apis: "Google Maps embed; WhatsApp click-to-chat." } })],
  ["design.pdf", designDocPdf({ number: "09253", clientName: "Prablo 360", projectName: "chandranath & company", brand, payload: { sitemap: "Home, About, Packages, Gallery, Contact", figmaLink: "https://figma.com/file/example", primaryColor: "#0070FF", secondaryColor: "#3C3B3A", accentColor: "#F59E0B", fonts: "Open Sans", responsive: "Mobile first; breakpoints at 640, 1024 and 1280 px." } })],
  ["credentials.pdf", credentialsPdf({ clientName: "Prablo 360", projectName: "chandranath & company", supportPeriod: d.supportPeriod, supportContact: d.supportContact, brand, rows: [{ service: "Hosting Service", url: "https://hosting.example", username: "owner", password: "sample-only" }, { service: "Domain Registrar", url: "", username: "", password: "" }] })],
];
for (const [name, build] of files) { const buffer = await build; fs.writeFileSync(path.join(outDir, name), buffer); console.log(`${name}  ${buffer.length} bytes`); }
