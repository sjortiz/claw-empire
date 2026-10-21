import { describe, expect, it } from "vitest";
import { formatMeetingVerdict } from "../../lib/meeting-verdict";
import { getMeetingBadgeStyle, inferReviewDecision, resolveMeetingDecision } from "./themes-locale";

describe("office meeting verdicts", () => {
  it("never infers a verdict from risk or approval keywords in a preview", () => {
    expect(inferReviewDecision("Approved: #47 blocks downstream work with risk")).toBe("reviewing");
    expect(
      inferReviewDecision(
        `Risk remains\n${formatMeetingVerdict({ verdict: "approve", blocking_items: [], non_blocking_notes: [] })}`,
      ),
    ).toBe("approved");
  });
  it.each(["kickoff", "review"] as const)("uses server decisions and explicit labels for %s", (phase) => {
    expect(resolveMeetingDecision(phase, "approved", "risk and missing blockers")).toBe("approved");
    expect(resolveMeetingDecision(phase, undefined, "Approved with risk")).toBe("reviewing");
    expect(getMeetingBadgeStyle("en", phase, "approved").text).toBe("APPROVE");
    expect(getMeetingBadgeStyle("en", phase, "hold").text).toBe("REVISE");
    expect(getMeetingBadgeStyle("en", phase, "reviewing").text).toBe("NO VERDICT");
  });
});
