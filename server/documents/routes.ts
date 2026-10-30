import express, { type Express, type Request, type Response } from "express";
import { jobMoney } from "../../shared/finance";
import { PipelineError, refuse } from "../data/errors";
import { recordEvent } from "../data/events";
import { ledgerExport } from "../data/finance";
import { getJob } from "../data/jobs";
import { listLedger } from "../data/ledger";
import { getSettings } from "../data/settings";
import { hasDatabase } from "../data/core";
import { credentialsPdf, type CredentialRow } from "./builders";
import { rateLimit } from "../_core/http-guards";
import { ENV } from "../_core/env";
import { renderDocument } from "./render";

const STATUS: Record<string, number> = { NOT_FOUND: 404, PRECONDITION_FAILED: 412, BAD_REQUEST: 400, CONFLICT: 409 };

function sendError(res: Response, error: unknown) {
  if (error instanceof PipelineError) { res.status(STATUS[error.code] ?? 400).json({ error: error.message }); return; }
  // Not the error's own message: for these routes it could contain a piece of the request.
  console.error("[Documents] request failed:", error instanceof Error ? error.name : "unknown error");
  res.status(500).json({ error: "The document could not be built." });
}

const noStore = (res: Response) => res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
const attachment = (res: Response, filename: string, type: string) => res.set({ "Content-Type": type, "Content-Disposition": `attachment; filename="${filename}"` });

// The PDF and CSV downloads and the credentials sheet. They live under /api, so the PIN lock guards them like the rest of
// the dashboard API.
export function registerDocumentRoutes(app: Express) {
  // Building a PDF costs CPU, so these share the API's per-address allowance.
  app.use(["/api/documents", "/api/finance"], rateLimit({ max: ENV.apiRateLimitPerMinute }));

  app.get("/api/documents/:id/pdf", async (req: Request, res: Response) => {
    try {
      if (!hasDatabase()) refuse("PRECONDITION_FAILED", "The database is not configured on this server.");
      const { filename, buffer } = await renderDocument(String(req.params.id));
      noStore(res);
      attachment(res, filename, "application/pdf");
      res.status(200).send(buffer);
    } catch (error) { sendError(res, error); }
  });

  app.get("/api/finance/ledger.csv", async (req: Request, res: Response) => {
    try {
      const month = typeof req.query.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : undefined;
      const csv = await ledgerExport(month);
      noStore(res);
      attachment(res, `ledger-${month ?? "all-time"}.csv`, "text/csv; charset=utf-8");
      res.status(200).send(`﻿${csv}`);
    } catch (error) { sendError(res, error); }
  });

  // Credentials & Access. The values arrive in the body of this one request, go into a PDF built in memory, and leave in
  // the response. They are not stored in the database, the event log, a file or the client's cache, and this route
  // parses its own body so that a malformed one fails here with a generic answer and never reaches a logger.
  app.post(
    "/api/documents/credentials/pdf",
    express.json({ limit: "32kb" }),
    async (req: Request, res: Response) => {
      noStore(res);
      try {
        const body = (req.body ?? {}) as { jobId?: unknown; rows?: unknown; confirmUnpaid?: unknown };
        if (typeof body.jobId !== "string" || !Array.isArray(body.rows)) refuse("BAD_REQUEST", "Send the job and the credential rows.");
        const rows: CredentialRow[] = (body.rows as unknown[]).slice(0, 40).map((row) => {
          const value = (row ?? {}) as Record<string, unknown>;
          const text = (field: string) => (typeof value[field] === "string" ? (value[field] as string).slice(0, 300) : "");
          return { service: text("service"), url: text("url"), username: text("username"), password: text("password") };
        });
        const job = await getJob(body.jobId as string);
        if (!job) refuse("NOT_FOUND", "That job does not exist.");
        if (!job!.startedAt) refuse("PRECONDITION_FAILED", "Credentials are handed over once the project has started.");
        const outstanding = jobMoney(job!, await listLedger({ jobId: job!.id })).outstanding;
        if (outstanding > 0) {
          if (body.confirmUnpaid !== true) { res.status(412).json({ error: `LKR ${outstanding.toLocaleString("en-US")} is still outstanding on this job.`, code: "BALANCE_OUTSTANDING", outstanding }); return; }
          // Only the fact of the override is recorded, never any of the rows.
          await recordEvent({ eventType: "credentials_override", severity: "warning", title: "Credentials issued with a balance outstanding", detail: `Credentials PDF generated for job ${job!.id} (${job!.clientName}) with LKR ${outstanding.toFixed(2)} unpaid, after the owner confirmed.`, clientId: job!.conversationClientId ?? undefined });
        }
        const settings = await getSettings();
        const buffer = await credentialsPdf({ clientName: job!.clientName, projectName: job!.title, rows: rows.length ? rows : [{ service: "Hosting Service", url: "", username: "", password: "" }, { service: "Domain Registrar", url: "", username: "", password: "" }], supportPeriod: settings.documentSettings.supportPeriod, supportContact: settings.documentSettings.supportContact, brand: { footerLinks: settings.documentSettings.footerLinks } });
        await recordEvent({ eventType: "credentials_pdf", title: "Credentials PDF generated", detail: `Credentials PDF generated for job ${job!.id} (${job!.clientName}).`, clientId: job!.conversationClientId ?? undefined });
        attachment(res, `Credentials-Access-${job!.id.slice(0, 8)}.pdf`, "application/pdf");
        res.status(200).send(buffer);
      } catch (error) { sendError(res, error); }
    },
    // A body that is not valid JSON, or too large: answered here, generically, before anything can log it.
    (_error: unknown, _req: Request, res: Response, _next: express.NextFunction) => { res.status(400).json({ error: "The request could not be read." }); },
  );

}
