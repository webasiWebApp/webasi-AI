import { toCents, fromCents } from "./money";

// Document kinds, their payloads and the wording the owner's templates start from. The wording comes from the owner's
// own quotation PDF and contract DOCX (docs/reference). It is data, not code: every line is editable in Settings and
// again per document, so nothing here is "improved" or rewritten.
export const DOCUMENT_KINDS = ["quotation", "contract", "invoice", "receipt", "renewal_invoice", "technical_doc", "design_doc"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const KIND_LABELS: Record<DocumentKind, string> = { quotation: "Quotation", contract: "Proposal & contract pack", invoice: "Invoice", receipt: "Receipt", renewal_invoice: "Renewal invoice", technical_doc: "Technical documentation", design_doc: "Design documentation" };

export const QUOTATION_STATUSES = ["draft", "sent", "approved", "superseded", "rejected"] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export type QuotationItem = { description: string; bullets: string[]; cost: number };
export type LabelledLine = { label: string; text: string };
export type DocumentSettings = {
  infrastructure: LabelledLine[];
  afterService: string[];
  timelineDuration: string;
  milestones: LabelledLine[];
  portfolioMain: string;
  portfolioLinks: string[];
  footerLinks: Array<{ label: string; url: string }>;
  quotationDueDays: number;
  invoiceDueDays: number;
  paymentMethodText: string;
  supportPeriod: string;
  supportContact: string;
  contractTitle: string;
  receivingParty: string;
  contractClauses: Array<{ title: string; lines: string[] }>;
  ndaClauses: Array<{ title: string; lines: string[] }>;
  ndaIntro: string;
  ndaClosing: string;
  agreementIntro: string;
  warrantyNote: string;
};

// Copied from chandranath__company.pdf and webasi_portfolio_project_doc.docx.
export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  infrastructure: [
    { label: "Technology", text: "Next js" },
    { label: "Domain", text: ".com domain for 1 year" },
    { label: "Hosting", text: "namecheap" },
  ],
  afterService: ["Free 01 Year after delivery support (We charge for major updates)", "Money back guarantee"],
  timelineDuration: "7-10 Calendar Days",
  milestones: [
    { label: "Requirement Gathering", text: "Finalizing the SRS (Software Requirements Specification) document." },
    { label: "UI/UX Design", text: "Creating the visual layout for client approval." },
    { label: "Development", text: "Backend and frontend coding (commences after design approval)." },
    { label: "Testing & Delivery", text: "Final quality checks and deployment to the live server." },
  ],
  portfolioMain: "webasi.co",
  portfolioLinks: ["https://www.theplatinuminteriors.com/", "https://www.donovanwashington.com/", "https://4elementsboxing.com/", "https://www.prablo360.com/", "https://www.avix.one/", "https://www.thecircularflow.com/"],
  footerLinks: [{ label: "webasi.co", url: "https://webasi.co" }, { label: "Reviews", url: "" }, { label: "Terms and Conditions", url: "https://praveen.webasi.co/terms-and-conditions" }],
  quotationDueDays: 30,
  invoiceDueDays: 14,
  paymentMethodText: "Bank Transfer",
  supportPeriod: "30 days",
  supportContact: "info@webasi.co | +94 76 066 8556",
  contractTitle: "Portfolio Web Development",
  receivingParty: "Praveen Maleesha from WEBASI",
  agreementIntro: "This Agreement is made on [Start Date] – [30 days after delivery] between:",
  contractClauses: [
    { title: "Scope of Work", lines: ["The Freelancer agrees to develop a website as per the client's requirements. This is the requirements outline."] },
    { title: "Deliverables", lines: ["Source files (If use WordPress/CMS don’t provide source code)", "Credentials", "Domain Name", "Hosting Service", "Admin Panel"] },
    // {{totalFee}} and {{paymentSchedule}} are filled from the approved quotation, never typed into the contract.
    { title: "Payment Terms", lines: ["Total Fee: {{totalFee}}", "Payment Schedule: {{paymentSchedule}}", "Payment Method: {{paymentMethod}}", "Advance payment is required to initiate the project.", "Remaining balance due upon final delivery."] },
    { title: "Timeline", lines: ["Project start date: {{startDate}}", "Estimated completion date: {{completionDate}}"] },
    { title: "Intellectual Property", lines: ["Upon full payment, all intellectual property rights in the deliverables will transfer to the Client."] },
    { title: "Confidentiality", lines: ["Both parties agree to keep confidential information private as per the attached NDA."] },
    { title: "Warranty", lines: ["The Freelancer warrants that the deliverables will function as specified for 30 days after delivery."] },
  ],
  ndaIntro: "This Non-Disclosure Agreement (\"Agreement\") is entered into as of [Start Date] – [30 days after delivery], by and between:",
  ndaClauses: [
    { title: "Definition of Confidential Information", lines: ["\"Confidential Information\" means any data or information, oral or written, disclosed by the Disclosing Party to the Receiving Party that is not generally known to the public. Ex : service credentials"] },
    { title: "Obligations of Receiving Party", lines: ["Maintain confidentiality of the Confidential Information.", "Use the information solely for the purpose of project.", "Not disclose Confidential Information to any third party without prior written consent."] },
    { title: "Exclusions", lines: ["Confidential Information does not include information that:", "Is or becomes publicly available without breach of this Agreement.", "Was known to the Receiving Party prior to disclosure.", "Is independently developed by the Receiving Party."] },
    { title: "Term", lines: ["This Agreement shall remain in effect for 2 years from the date of disclosure."] },
    { title: "Return of Materials", lines: ["Upon request, the Receiving Party shall return or destroy all Confidential Information."] },
  ],
  ndaClosing: "IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first above written.",
  warrantyNote: "",
};

// Known inconsistencies in the owner's contract template. They are kept as written and shown to the owner until dismissed.
export const TEMPLATE_REVIEW_NOTES = [
  "The agreement date line reads “[Start Date] – [30 days after delivery]”, which does not say what the end date means. The contract form keeps separate agreement, start and estimated completion dates.",
  "The contract warranty is 30 days, while the quotation promises 1 year of free support after delivery. They are two separate clauses here and are never treated as the same term.",
  "The template's example payment split is 50/50, while the real one is 40/60. The contract always takes the split from the approved quotation, never from template text.",
] as const;

export function mergeDocumentSettings(stored: unknown): DocumentSettings {
  const given = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...DEFAULT_DOCUMENT_SETTINGS };
  for (const key of Object.keys(DEFAULT_DOCUMENT_SETTINGS)) if (given[key] !== undefined && typeof given[key] === typeof (DEFAULT_DOCUMENT_SETTINGS as Record<string, unknown>)[key]) merged[key] = given[key];
  return merged as DocumentSettings;
}

export function quotationTotals(items: Array<{ cost: number }>) {
  const cents = items.reduce((sum, item) => sum + toCents(item.cost), 0);
  return { subtotal: fromCents(cents), total: fromCents(cents) };
}

export const paymentTermsLines = (advancePercent: number) => [`${trimNumber(advancePercent)}% Advance Payment`, `${trimNumber(100 - advancePercent)}% Upon Project Completion`];
export const paymentScheduleText = (advancePercent: number) => paymentTermsLines(advancePercent).join(" / ");
const trimNumber = (value: number) => String(Math.round(value * 100) / 100);

export type QuotationPayload = {
  clientName: string;
  projectName: string;
  intro: string;
  date: string;
  dueDate: string;
  items: QuotationItem[];
  subtotal: number;
  total: number;
  advancePercent: number;
  infrastructure: LabelledLine[];
  afterService: string[];
  timelineDuration: string;
  milestones: LabelledLine[];
  portfolioMain: string;
  portfolioLinks: string[];
  footerLinks: Array<{ label: string; url: string }>;
};

export type InvoiceLine = { description: string; amount: number };
export type InvoicePayload = {
  basis: "advance" | "balance" | "renewal" | "custom";
  clientName: string;
  clientPhone: string;
  projectName: string;
  date: string;
  dueDate: string;
  paymentMethod: string;
  lines: InvoiceLine[];
  total: number;
  renewalId?: string;
};
export type ReceiptPayload = {
  clientName: string;
  projectName: string;
  date: string;
  amount: number;
  method: string;
  category: string;
  balanceAfter: number;
  invoiceNumber?: string;
  note: string;
};
export type ContractPayload = {
  title: string;
  projectName: string;
  clientName: string;
  dateOfDelivery: string;
  agreementDate: string;
  startDate: string;
  completionDate: string;
  paymentMethod: string;
  scope: string[];
  receivingParty: string;
  supportPeriod: string;
  supportContact: string;
  // Per-contract overrides of the default clauses in Settings; an absent key means "use Settings".
  clauses?: Array<{ title: string; lines: string[] }>;
  ndaClauses?: Array<{ title: string; lines: string[] }>;
  agreementIntro?: string;
  ndaIntro?: string;
  ndaClosing?: string;
};
export type TechnicalDocPayload = { overview: string; frontend: string; backend: string; database: string; installation: string; apis: string };
export type DesignDocPayload = { sitemap: string; figmaLink: string; primaryColor: string; secondaryColor: string; accentColor: string; fonts: string; responsive: string };
