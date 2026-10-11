import { describe, expect, it } from "vitest";
import { splitIncludedExcluded, usageResetLabel } from "../shared/webasi";

describe("usage meter reset time", () => {
  it("counts the days left in the UTC month for the WhatsApp limit", () => {
    expect(usageResetLabel("month", new Date("2026-10-11T08:00:00Z"))).toBe("Resets in 21 days");
    expect(usageResetLabel("month", new Date("2026-10-31T08:00:00Z"))).toBe("Resets tomorrow");
    expect(usageResetLabel("month", new Date("2026-12-30T23:00:00Z"))).toBe("Resets in 2 days");
  });

  it("counts the hours left in the UTC day for the AI limit", () => {
    expect(usageResetLabel("day", new Date("2026-10-11T08:20:00Z"))).toBe("Resets in 16 hours");
    expect(usageResetLabel("day", new Date("2026-10-11T23:20:00Z"))).toBe("Resets within the hour");
  });
});

describe("included and excluded lists from the training answer", () => {
  it("keeps everything after an 'Excluded' label out of the included list", () => {
    expect(splitIncludedExcluded("Included: 5 pages, contact form\nExcluded: logo design, content writing")).toEqual({ included: ["5 pages", "contact form"], excluded: ["logo design", "content writing"] });
  });

  it("finds a label in the middle of a line", () => {
    expect(splitIncludedExcluded("Includes: hosting, domain. Not included: copywriting; photography")).toEqual({ included: ["hosting", "domain"], excluded: ["copywriting", "photography"] });
  });

  it("treats a plain list as included, and an answer that is only exclusions as excluded", () => {
    expect(splitIncludedExcluded("hosting, domain\nSSL")).toEqual({ included: ["hosting", "domain", "SSL"], excluded: [] });
    expect(splitIncludedExcluded("Excludes - logo design")).toEqual({ included: [], excluded: ["logo design"] });
    expect(splitIncludedExcluded("")).toEqual({ included: [], excluded: [] });
  });

  it("can switch back to included items after the exclusions", () => {
    expect(splitIncludedExcluded("Excluded: logo\nIncluded: hosting")).toEqual({ included: ["hosting"], excluded: ["logo"] });
  });
});
