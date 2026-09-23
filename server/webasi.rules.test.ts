import { describe, expect, it } from "vitest";
import { canActivateProject, nextOrderState, shouldSendReply, trainingReadiness, usagePercent } from "../shared/webasi";

describe("WEBASI safety rules", () => {
  it("clamps usage percentages to a safe 0–100 range", () => {
    expect(usagePercent(246, 900)).toBe(27);
    expect(usagePercent(1200, 900)).toBe(100);
    expect(usagePercent(-5, 900)).toBe(0);
    expect(usagePercent(1, 0)).toBe(100);
  });

  it("only activates ready projects", () => {
    expect(canActivateProject(true)).toBe(true);
    expect(canActivateProject(false)).toBe(false);
  });

  it("never sends when WEBASI is off, outside the window, or past the hard stop", () => {
    expect(shouldSendReply({ isOn: false, withinCustomerWindow: true, monthlyOutbound: 0, monthlyCap: 900 })).toBe(false);
    expect(shouldSendReply({ isOn: true, withinCustomerWindow: false, monthlyOutbound: 0, monthlyCap: 900 })).toBe(false);
    expect(shouldSendReply({ isOn: true, withinCustomerWindow: true, monthlyOutbound: 810, monthlyCap: 900 })).toBe(false);
    expect(shouldSendReply({ isOn: true, withinCustomerWindow: true, monthlyOutbound: 809, monthlyCap: 900 })).toBe(true);
  });

  it("keeps the order lifecycle deterministic", () => {
    expect(nextOrderState("collecting", "brief_complete")).toBe("awaiting_deposit");
    expect(nextOrderState("awaiting_deposit", "slip_received")).toBe("slip_received");
    expect(nextOrderState("slip_received", "owner_confirmed")).toBe("confirmed_by_owner");
    expect(nextOrderState("collecting", "owner_confirmed")).toBe("collecting");
    expect(nextOrderState("awaiting_deposit", "pause")).toBe("paused");
    expect(nextOrderState("paused", "resume")).toBe("collecting");
  });

  it("requires every training answer and a summary before approval", () => {
    expect(trainingReadiness(["pricing", "timeline"], { pricing: "LKR 85,000" }, "Summary").complete).toBe(false);
    expect(trainingReadiness(["pricing", "timeline"], { pricing: "LKR 85,000", timeline: "14–18 days" }, "").complete).toBe(false);
    expect(trainingReadiness(["pricing", "timeline"], { pricing: "LKR 85,000", timeline: "14–18 days" }, "Approved package summary")).toMatchObject({ readiness: 100, complete: true });
  });
});
