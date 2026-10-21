import { describe, expect, it } from "vitest";
import { isMeetingRunTimeout } from "./meeting-run-timeout.ts";

describe("meeting execution timeout detection", () => {
  it("ignores timeout words in successful model output", () => {
    const run = { text: "Fix timeout after requests timed out; aborted jobs recover.", status: "completed" };
    expect(isMeetingRunTimeout(run)).toBe(false);
    expect(isMeetingRunTimeout(null)).toBe(false);
  });
  it.each([
    { error: "timeout after 65000ms" },
    { error: "Request timed out" },
    { error: "The operation was aborted" },
    { status: "timed_out" },
    { status: "timeout" },
    { timedOut: true },
  ])("recognizes execution timeout metadata: %o", (run) => {
    expect(isMeetingRunTimeout(run)).toBe(true);
  });
});
