import { describe, expect, it, vi } from "vitest";
import {
  appendMeetingVerdict,
  effectiveMeetingVerdict,
  meetingVerdictInstruction,
  parseMeetingVerdict,
} from "../../../../shared/meeting-verdict.ts";
import { resolveMeetingVerdict } from "./meeting-verdict.ts";
import { createMeetingPresenceTools } from "../orchestration/meetings/presence.ts";
import { createReplyCoreTools } from "./reply-core-tools.ts";

const approve = { verdict: "approve" as const, blocking_items: [], non_blocking_notes: ["Watch risk after merge"] };
const legacy = createReplyCoreTools({
  detectLang: () => "en",
  getPreferredLanguage: () => "en",
  pickL: (lines) => lines.en[0],
  prettyStreamJson: (text) => text,
});

describe("structured meeting verdicts", () => {
  it("approves blocks/risk wording when the explicit final verdict approves", () => {
    const text = appendMeetingVerdict("Approved. #47 blocks downstream work and carries risk.", approve);
    expect(legacy.classifyMeetingReviewDecision(text)).toBe("approved");
    expect(legacy.classifyMeetingReviewDecision("Approved. #47 blocks downstream work and carries risk.")).toBe("hold");
  });
  it("revises only for nonempty blocking items and ignores blank strings", () => {
    expect(effectiveMeetingVerdict({ ...approve, verdict: "revise", blocking_items: ["Fix API"] })).toBe("revise");
    expect(effectiveMeetingVerdict({ ...approve, blocking_items: ["Document risk"] })).toBe("approve");
    const parsed = parseMeetingVerdict(
      appendMeetingVerdict("", { ...approve, verdict: "revise", blocking_items: ["  "] }),
    )!;
    expect(effectiveMeetingVerdict(parsed)).toBe("approve");
  });
  it.each([
    '```json\n{"verdict":"approve","blocking_items":[],"non_blocking_notes":[]}\n```\ntrailing text',
    '{"verdict":"approve","blocking_items":"none","non_blocking_notes":[]}',
    '{"verdict":"approve","blocking_items":[]}',
    '{"verdict":"approve","blocking_items":[1],"non_blocking_notes":[]}',
    '{"verdict":"hold","blocking_items":[],"non_blocking_notes":[]}',
  ])("rejects malformed or non-final verdicts: %s", (text) => expect(parseMeetingVerdict(text)).toBeNull());
  it("uses the final verdict fence after an independent planning graph", () => {
    const text = '```json\n{"plan_items":[]}\n```\n' + appendMeetingVerdict("", approve);
    expect(parseMeetingVerdict(text)).toEqual(approve);
  });
  it("does not retry valid verdicts and logs count", async () => {
    const retry = vi.fn();
    const log = vi.fn();
    const resolved = await resolveMeetingVerdict({
      text: appendMeetingVerdict("risk", approve),
      lang: "en",
      retry,
      fallback: () => true,
      log,
    });
    expect(retry).not.toHaveBeenCalled();
    expect(resolved.source).toBe("structured");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("blocking_items=0, source=structured"));
  });
  it("retries missing verdict once and obeys the returned approval", async () => {
    const retry = vi.fn().mockResolvedValue({ text: JSON.stringify(approve) });
    const fallback = vi.fn();
    const resolved = await resolveMeetingVerdict({ text: "risk", lang: "en", retry, fallback, log: vi.fn() });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(expect.stringContaining("Return ONLY"));
    expect(resolved.source).toBe("retry");
    expect(parseMeetingVerdict(resolved.content)).toEqual(approve);
    expect(fallback).not.toHaveBeenCalled();
  });
  it.each(["invalid", "exception", "error"])("falls back once when retry is %s", async (mode) => {
    const retry =
      mode === "exception"
        ? vi.fn().mockRejectedValue(new Error("offline"))
        : vi.fn().mockResolvedValue({
            text: mode === "error" ? JSON.stringify(approve) : "still no verdict",
            ...(mode === "error" ? { error: "partial response" } : {}),
          });
    const log = vi.fn();
    const fallback = vi.fn((text) => legacy.wantsReviewRevision(text));
    const resolved = await resolveMeetingVerdict({ text: "risk blocks approval", lang: "en", retry, fallback, log });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledExactlyOnceWith("risk blocks approval");
    expect(resolved.source).toBe("fallback");
    expect(effectiveMeetingVerdict(resolved.verdict)).toBe("revise");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("legacy classifier fallback"));
  });
  it.each(["en", "ko", "ja", "zh"])("requires the same schema in %s", (lang) => {
    const instruction = meetingVerdictInstruction(lang);
    expect(instruction).toContain('verdict: "approve" | "revise"');
    expect(instruction).toContain("blocking_items: string[]");
    expect(instruction).toContain("non_blocking_notes: string[]");
  });
});

it("presence uses the full verdict after a long keyword-heavy preview", () => {
  const decisions = new Map<string, string>();
  const broadcast = vi.fn();
  const presence = createMeetingPresenceTools({
    db: {},
    nowMs: () => 0,
    broadcast,
    meetingPresenceUntil: new Map(),
    meetingSeatIndexByAgent: new Map(),
    meetingPhaseByAgent: new Map(),
    meetingTaskIdByAgent: new Map(),
    meetingReviewDecisionByAgent: decisions,
    summarizeForMeetingBubble: (text, maxChars) => text.slice(0, maxChars),
    classifyMeetingReviewDecision: legacy.classifyMeetingReviewDecision,
  });
  const text = appendMeetingVerdict("Risk blocks downstream work. ".repeat(20), approve);
  presence.emitMeetingSpeech("dev", 0, "review", "task", text, "en");
  expect(decisions.get("dev")).toBe("approved");
  expect(broadcast).toHaveBeenCalledWith(
    "ceo_office_call",
    expect.objectContaining({ decision: "approved", line: text.slice(0, 96) }),
  );
});
