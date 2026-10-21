import { describe, expect, it } from "vitest";
import { isTimeoutRun } from "./meeting-run.ts";

describe("meeting run timeout detection", () => {
  it.each(["timeout", "timeout after 38000ms", "timed out", "request timed out", "aborted"])(
    "does not retry successful prose containing %s",
    (text) => {
      expect(isTimeoutRun({ text: `Implement recovery for ${text} operations.` })).toBe(false);
    },
  );

  it.each(["timeout after 65000ms", "Request timed out", "The operation was aborted"])(
    "recognizes the runner error %s even with partial output",
    (error) => {
      expect(isTimeoutRun({ text: "Partial draft", error })).toBe(true);
    },
  );

  it("does not classify other runner errors or absent results as timeouts", () => {
    expect(isTimeoutRun({ error: "Provider exited with code 1" })).toBe(false);
    expect(isTimeoutRun(null)).toBe(false);
  });
});
