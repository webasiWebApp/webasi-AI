import { hasDatabase } from "./core";

// What the pipeline data layer throws for a refusal the owner should read, as opposed to a crash. The routers turn the
// code into the matching tRPC error.
export type PipelineErrorCode = "NOT_FOUND" | "PRECONDITION_FAILED" | "BAD_REQUEST" | "CONFLICT";
export class PipelineError extends Error {
  constructor(readonly code: PipelineErrorCode, message: string) { super(message); this.name = "PipelineError"; }
}

export function refuse(code: PipelineErrorCode, message: string): never { throw new PipelineError(code, message); }

// The pipeline tables and functions come from migrations the owner applies by hand. Until they are applied, Postgres or
// PostgREST says the table or function is missing, and the background jobs treat that as "this module is not installed yet".
export const isMissingSchema = (error: unknown) => ["42P01", "42883", "PGRST205", "PGRST202"].includes(String((error as { code?: string } | null)?.code ?? ""));

export function requireDb() {
  if (!hasDatabase()) refuse("PRECONDITION_FAILED", "The database is not configured on this server.");
}

// The database's own messages for broken rules are written for the owner; constraint names get a plain sentence.
const CONSTRAINTS: Record<string, string> = {
  ledger_income_has_job: "Income must belong to a job.",
  ledger_income_category: "Income must be an advance, final, renewal or extra payment.",
  ledger_void_has_reason: "A reason is required to void an entry.",
  documents_one_receipt_per_entry: "This payment already has a receipt.",
  documents_one_approved_quotation: "This job already has an approved quotation.",
  ledger_one_start_advance: "The advance for this job was already recorded.",
};

export function dbError(error: { code?: string; message: string }): never {
  const named = Object.entries(CONSTRAINTS).find(([name]) => error.message.includes(name));
  const message = named?.[1] ?? error.message;
  switch (error.code) {
    case "23514": return refuse("PRECONDITION_FAILED", message);
    case "P0002": return refuse("NOT_FOUND", message);
    case "22023": case "23503": case "22P02": case "22007": case "22008": return refuse("BAD_REQUEST", message);
    case "23505": return refuse("CONFLICT", named ? message : "That already exists.");
    default: throw new Error(error.message);
  }
}
