import { describe, expect, it } from "vitest";
import { JOB_STAGES, canHaveContract, checkTransition, isStartedStage, nextAction, type JobStage } from "./jobs";

const ok = (from: JobStage, to: JobStage, facts = {}) => checkTransition(from, to, facts).ok;

describe("job stage machine", () => {
  it("allows the main path only when each gate is met", () => {
    expect(ok("lead", "meeting")).toBe(false);
    expect(ok("lead", "meeting", { hasLiveMeeting: true })).toBe(true);
    expect(ok("lead", "quoted")).toBe(false);
    expect(ok("lead", "quoted", { hasQuotation: true })).toBe(true);
    expect(ok("meeting", "quoted", { hasQuotation: true })).toBe(true);
    expect(ok("quoted", "approved", { chosenQuotationStatus: "draft" })).toBe(false);
    expect(ok("quoted", "approved", { chosenQuotationStatus: "sent" })).toBe(true);
    expect(ok("approved", "active", { requiredAdvance: 16_000, advanceAmount: 15_999.99 })).toBe(false);
    expect(ok("approved", "active", { requiredAdvance: 16_000, advanceAmount: 16_000 })).toBe(true);
    expect(ok("approved", "active", { requiredAdvance: 16_000, advanceAmount: 20_000 })).toBe(true);
    expect(ok("approved", "active", { requiredAdvance: null, advanceAmount: 20_000 })).toBe(false);
    expect(ok("active", "delivered")).toBe(true);
    expect(ok("delivered", "closed", { outstanding: 1 })).toBe(false);
    expect(ok("delivered", "closed", { outstanding: 0 })).toBe(true);
  });

  it("compares the advance in whole cents, so a float sum cannot fool the gate", () => {
    expect(ok("approved", "active", { requiredAdvance: 0.3, advanceAmount: 0.1 + 0.2 })).toBe(true);
  });

  it("warns, without blocking, about unfinished tasks at delivery", () => {
    expect(checkTransition("active", "delivered", { unfinishedTasks: 3 })).toEqual({ ok: true, warnings: ["3 tasks are not finished yet."] });
    expect(checkTransition("active", "delivered", { unfinishedTasks: 1 })).toEqual({ ok: true, warnings: ["1 task is not finished yet."] });
    expect(checkTransition("active", "delivered")).toEqual({ ok: true, warnings: [] });
  });

  it("never skips a stage or goes backwards, except revoke approval, lost and reopen", () => {
    const allowed = new Set(["lead>meeting", "lead>quoted", "meeting>quoted", "quoted>approved", "approved>active", "active>delivered", "delivered>closed", "approved>quoted"]);
    const full = { hasLiveMeeting: true, hasQuotation: true, chosenQuotationStatus: "sent", requiredAdvance: 1, advanceAmount: 1, outstanding: 0 };
    for (const from of JOB_STAGES) for (const to of JOB_STAGES) {
      if (from === to || to === "lost" || from === "lost") continue;
      expect(ok(from, to, full), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
    }
  });

  it("can mark lost only before the project starts, and reopens only at the stage it was lost from", () => {
    for (const stage of ["lead", "meeting", "quoted", "approved"] as const) expect(ok(stage, "lost")).toBe(true);
    for (const stage of ["active", "delivered", "closed"] as const) expect(checkTransition(stage, "lost")).toMatchObject({ ok: false, code: "not_allowed" });
    expect(ok("lost", "quoted", { lostFromStage: "quoted" })).toBe(true);
    expect(ok("lost", "approved", { lostFromStage: "quoted" })).toBe(false);
    expect(ok("lost", "lead")).toBe(false);
  });

  it("knows which stages have started and which may hold a contract", () => {
    expect(JOB_STAGES.filter(isStartedStage)).toEqual(["active", "delivered", "closed"]);
    expect(JOB_STAGES.filter(canHaveContract)).toEqual(["approved", "active", "delivered", "closed"]);
    for (const stage of JOB_STAGES) expect(nextAction(stage).length).toBeGreaterThan(0);
  });
});
