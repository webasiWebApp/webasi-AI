import { describe, expect, it } from "vitest";
import { formatAutomationAudit } from "../shared/webasi";

describe("automation audit details", () => {
  it("records actor, project, and previous/new state values", () => {
    expect(formatAutomationAudit({ actor: "owner", project: "Restaurant Website Package", previous: "OFF", next: "ON", detail: "Live replies are permitted." })).toBe("Actor: owner. Project: Restaurant Website Package. Previous: OFF. New: ON. Live replies are permitted.");
  });

  it("supports shadow-mode transitions with the same auditable shape", () => {
    const detail = formatAutomationAudit({ actor: "owner", project: "Restaurant Website Package", previous: "NORMAL", next: "SHADOW", detail: "Replies remain drafts." });
    expect(detail).toContain("Previous: NORMAL");
    expect(detail).toContain("New: SHADOW");
    expect(detail).toContain("Replies remain drafts.");
  });
});
