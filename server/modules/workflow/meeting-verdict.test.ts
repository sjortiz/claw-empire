import { describe, expect, it, vi } from "vitest";
import {
  formatMeetingVerdict,
  meetingVerdictNeedsRevision,
  parseMeetingVerdict,
  stripMeetingVerdict,
} from "../../../src/lib/meeting-verdict.ts";
import { meetingVerdictInstruction, planningWorkFromVerdict, resolveMeetingVerdict } from "./meeting-verdict.ts";
import { createReplyCoreTools } from "./core/reply-core-tools.ts";
import { createMeetingMinutesTools } from "./orchestration/meetings/minutes.ts";

const approve = {
  verdict: "approve" as const,
  blocking_items: [],
  non_blocking_notes: ["risk remains in downstream observability"],
};
const revise = {
  verdict: "revise" as const,
  blocking_items: ["Fix response decoding"],
  non_blocking_notes: ["Monitor risk later"],
};
const reply = (verdict = approve) =>
  `Approved: #47 blocks downstream work, with risk documented.\n${formatMeetingVerdict(verdict)}`;
const core = createReplyCoreTools({
  detectLang: () => "en",
  getPreferredLanguage: () => "en",
  pickL: (pool, lang) => pool[lang as "en"][0],
  prettyStreamJson: (text) => text,
});

describe("explicit meeting verdicts", () => {
  it("approves text mentioning blocks downstream work and risk", () => {
    expect(core.classifyMeetingReviewDecision(reply())).toBe("approved");
    expect(core.classifyMeetingReviewDecision(stripMeetingVerdict(reply()))).toBe("hold");
    expect(core.wantsReviewRevision(reply())).toBe(false);
  });
  it("requires concrete blockers for revision", () => {
    expect(core.wantsReviewRevision(formatMeetingVerdict(revise))).toBe(true);
    expect(core.wantsReviewRevision(formatMeetingVerdict({ ...revise, blocking_items: ["  "] }))).toBe(false);
    expect(core.wantsReviewRevision(formatMeetingVerdict({ ...revise, verdict: "approve" }))).toBe(false);
  });
  it("validates the final block and rejects partial or malformed contracts", () => {
    expect(parseMeetingVerdict(reply())).toEqual(approve);
    expect(parseMeetingVerdict(`${formatMeetingVerdict(revise)}\n${reply()}`)).toEqual(approve);
    for (const text of [
      "Approved",
      '```json\n{"verdict":"approve"}\n```',
      reply() + " trailing prose",
      '```json\n{"verdict":"approve","blocking_items":[2],"non_blocking_notes":[]}\n```',
      "```json\nbroken\n``` ",
    ])
      expect(parseMeetingVerdict(text)).toBeNull();
    expect(stripMeetingVerdict(reply())).toBe("Approved: #47 blocks downstream work, with risk documented.");
  });
  it("does not retry a valid structured verdict", async () => {
    const retry = vi.fn();
    const fallback = vi.fn();
    const log = vi.fn();
    const result = await resolveMeetingVerdict({
      text: reply(),
      lang: "en",
      reviewer: "dev",
      phase: "review",
      retry,
      fallback,
      log,
    });
    expect(result.source).toBe("structured");
    expect(retry).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("blocking_items=0, effective=approve"));
  });
  it("retries exactly once for a missing verdict, then uses the original legacy classifier", async () => {
    const retry = vi.fn().mockResolvedValue({ text: "still missing" });
    const fallback = vi.fn((text: string) => core.wantsReviewRevision(text));
    const log = vi.fn();
    const result = await resolveMeetingVerdict({
      text: "Approve, but risk remains",
      lang: "en",
      reviewer: "dev",
      phase: "review",
      retry,
      fallback,
      log,
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0][0]).toContain("verdict block");
    expect(fallback).toHaveBeenCalledExactlyOnceWith("Approve, but risk remains");
    expect(result.source).toBe("legacy");
    expect(meetingVerdictNeedsRevision(result.verdict)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("legacy classifier fallback"));
  });
  it("uses a successful retry and falls back if the retry throws", async () => {
    const fallback = vi.fn(() => false);
    const common = { text: "Approve with risk", lang: "ja", reviewer: "dev", phase: "planned", fallback, log: vi.fn() };
    const result = await resolveMeetingVerdict({
      ...common,
      retry: vi.fn().mockResolvedValue({ text: formatMeetingVerdict(approve) }),
    });
    expect(result).toEqual({ verdict: approve, source: "retry" });
    expect(fallback).not.toHaveBeenCalled();
    const failed = await resolveMeetingVerdict({ ...common, retry: vi.fn().mockRejectedValue(new Error("offline")) });
    expect(failed.source).toBe("legacy");
  });
  it.each(["ko", "en", "ja", "zh"])("provides a localized contract for %s", (lang) => {
    expect(parseMeetingVerdict(meetingVerdictInstruction(lang))).toEqual({
      verdict: "approve",
      blocking_items: [],
      non_blocking_notes: [],
    });
  });
  it("keeps notes out of planning input and revision action memos", () => {
    const tools = createMeetingMinutesTools({
      REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 10,
      REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 4,
    } as any);
    const row = (content: string, id = "dev") => ({
      speaker_agent_id: id,
      speaker: id,
      department: id,
      role: "leader",
      content,
    });
    expect(tools.collectRevisionMemoItems([row(reply()), row(formatMeetingVerdict(revise), "qa")])).toEqual([
      "qa qa: Fix response decoding",
    ]);
    expect(tools.collectPlannedActionItems([row(reply())])).toEqual([]);
    const work = planningWorkFromVerdict(
      `Implement API\n${approve.non_blocking_notes[0]}\n${formatMeetingVerdict(approve)}`,
      approve,
    );
    expect(work).toBe("Implement API");
  });
});
