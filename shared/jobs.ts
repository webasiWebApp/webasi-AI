// The stages of a Job (a client's whole engagement, from the first chat to the close) and the one function that says
// which moves are allowed. The server asks it before every stage change and the database repeats the money-critical
// checks, so a buggy caller still cannot skip a gate. Unrelated to the AI-training "projects".
export const JOB_STAGES = ["lead", "meeting", "quoted", "approved", "active", "delivered", "closed", "lost"] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const STAGE_LABELS: Record<JobStage, string> = { lead: "Lead", meeting: "Meeting", quoted: "Quoted", approved: "Approved", active: "Active", delivered: "Delivered", closed: "Closed", lost: "Lost" };

// Once a job has started, money can be recorded against it and it can no longer be lost.
export const STARTED_STAGES: readonly JobStage[] = ["active", "delivered", "closed"];
export const isStartedStage = (stage: JobStage) => STARTED_STAGES.includes(stage);
// A proposal and contract pack needs an approved quotation behind it.
export const CONTRACT_STAGES: readonly JobStage[] = ["approved", "active", "delivered", "closed"];
export const canHaveContract = (stage: JobStage) => CONTRACT_STAGES.includes(stage);
// Only before the project starts can a job still be lost.
export const LOSABLE_STAGES: readonly JobStage[] = ["lead", "meeting", "quoted", "approved"];

export type TransitionFacts = {
  hasLiveMeeting?: boolean; // at least one meeting that is not cancelled
  hasQuotation?: boolean; // a quotation in status draft or sent
  chosenQuotationStatus?: string | null; // the quotation the owner is approving
  requiredAdvance?: number | null; // price_total x advance_percent / 100
  advanceAmount?: number | null; // what the owner is recording with Start project
  outstanding?: number | null; // price still unpaid
  unfinishedTasks?: number;
  lostFromStage?: JobStage | null; // where a lost job came from, for reopening
};

export type TransitionResult = { ok: true; warnings: string[] } | { ok: false; code: "not_allowed" | "gate"; reason: string };

const deny = (code: "not_allowed" | "gate", reason: string): TransitionResult => ({ ok: false, code, reason });
const allow = (warnings: string[] = []): TransitionResult => ({ ok: true, warnings });

export function checkTransition(from: JobStage, to: JobStage, facts: TransitionFacts = {}): TransitionResult {
  if (from === to) return deny("not_allowed", `The job is already ${STAGE_LABELS[from].toLowerCase()}.`);
  if (to === "lost") return LOSABLE_STAGES.includes(from) ? allow() : deny("not_allowed", isStartedStage(from) ? "A job that has started cannot be marked lost. Void the ledger entries that were a mistake instead." : "This job cannot be marked lost.");
  if (from === "lost") return facts.lostFromStage && to === facts.lostFromStage ? allow() : deny("not_allowed", "A lost job reopens at the stage it was lost from.");
  if (from === "approved" && to === "quoted") return allow(); // Revoke approval

  switch (`${from}>${to}`) {
    case "lead>meeting":
      return facts.hasLiveMeeting ? allow() : deny("gate", "Add a meeting first.");
    case "lead>quoted":
    case "meeting>quoted":
      return facts.hasQuotation ? allow() : deny("gate", "Generate a quotation first.");
    case "quoted>approved":
      return facts.chosenQuotationStatus === "sent" ? allow() : deny("gate", "Only a quotation marked as sent can be approved.");
    case "approved>active": {
      if (facts.requiredAdvance == null) return deny("gate", "The approved quotation has no price.");
      if (facts.advanceAmount == null || Math.round(facts.advanceAmount * 100) < Math.round(facts.requiredAdvance * 100)) return deny("gate", "The full agreed advance must be recorded to start the project (partial advances are not supported).");
      return allow();
    }
    case "active>delivered":
      return allow(facts.unfinishedTasks ? [`${facts.unfinishedTasks} task${facts.unfinishedTasks === 1 ? " is" : "s are"} not finished yet.`] : []);
    case "delivered>closed":
      return (facts.outstanding ?? 0) <= 0 ? allow() : deny("gate", "The outstanding balance must be zero before the job can be closed.");
    default:
      return deny("not_allowed", `A job cannot move from ${STAGE_LABELS[from].toLowerCase()} to ${STAGE_LABELS[to].toLowerCase()}.`);
  }
}

// The button the job page and pipeline cards put first for each stage.
export function nextAction(stage: JobStage): string {
  switch (stage) {
    case "lead": return "Book a meeting or write a quotation";
    case "meeting": return "Write a quotation";
    case "quoted": return "Send the quotation, then mark the client's approval";
    case "approved": return "Record the advance and start the project";
    case "active": return "Finish the tasks, then mark delivered";
    case "delivered": return "Collect the balance, then close the job";
    case "closed": return "Nothing left to do";
    case "lost": return "Reopen if the client comes back";
  }
}
