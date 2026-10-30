import { KIND_LABELS, type ContractPayload, type DesignDocPayload, type InvoicePayload, type QuotationPayload, type ReceiptPayload, type TechnicalDocPayload } from "../../shared/documents";
import { documentContext } from "../data/documents";
import { refuse } from "../data/errors";
import { contractPdf, designDocPdf, invoicePdf, quotationPdf, receiptPdf, technicalDocPdf } from "./builders";

const safeName = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document";

// Builds the PDF for a stored document from its form data and the current settings. Nothing is cached or written: the
// same call a month later gives the same document, with any edits the owner made since.
export async function renderDocument(id: string): Promise<{ filename: string; buffer: Buffer }> {
  const { doc, job, settings, approvedQuotation, defaults } = await documentContext(id);
  const brand = { footerLinks: defaults.footerLinks };
  const filename = `${safeName(KIND_LABELS[doc.kind])}-${doc.number}.pdf`;
  const registrationNo = settings.registrationNo;
  const isVoid = doc.status === "void";
  switch (doc.kind) {
    case "quotation":
      return { filename, buffer: await quotationPdf({ number: doc.number, payload: doc.payload as QuotationPayload, registrationNo }) };
    case "invoice":
    case "renewal_invoice":
      return { filename, buffer: await invoicePdf({ number: doc.number, payload: doc.payload as InvoicePayload, registrationNo, bankDetails: settings.bankDetails ?? "", footerLinks: defaults.footerLinks, void: isVoid }) };
    case "receipt":
      return { filename, buffer: await receiptPdf({ number: doc.number, payload: doc.payload as ReceiptPayload, registrationNo, footerLinks: defaults.footerLinks, void: isVoid }) };
    case "contract": {
      if (!approvedQuotation) refuse("PRECONDITION_FAILED", "This contract needs the job's approved quotation, and the approval was revoked. Approve a quotation again to download it.");
      return { filename, buffer: await contractPdf({ number: doc.number, payload: doc.payload as ContractPayload, quotation: approvedQuotation!.payload as QuotationPayload, settings: defaults, brand }) };
    }
    case "technical_doc":
      return { filename, buffer: await technicalDocPdf({ number: doc.number, clientName: job.clientName, projectName: job.title, payload: doc.payload as TechnicalDocPayload, brand }) };
    case "design_doc":
      return { filename, buffer: await designDocPdf({ number: doc.number, clientName: job.clientName, projectName: job.title, payload: doc.payload as DesignDocPayload, brand }) };
  }
}
