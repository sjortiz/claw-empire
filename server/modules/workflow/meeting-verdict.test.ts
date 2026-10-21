import { describe, expect, it, vi } from "vitest";
import {
  formatMeetingVerdict,
  meetingVerdictNeedsRevision,
  parseMeetingVerdict,
  parseStoredMeetingVerdict,
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
    expect(core.classifyMeetingReviewDecision(stripMeetingVerdict(reply()))).toBe("reviewing");
    expect(core.wantsReviewRevision(reply())).toBe(false);
  });
  it("reads the verdict before an API provider's Done footer", () => {
    const withFooter = `${reply()}\n---\n[api:ollama] Done.\n`;
    expect(parseMeetingVerdict(withFooter)?.verdict).toBe("approve");
    expect(core.classifyMeetingReviewDecision(withFooter)).toBe("approved");
    expect(parseMeetingVerdict(`${formatMeetingVerdict(revise)}\n---\n[copilot] Done.`)?.verdict).toBe("revise");
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
  it("reads only the final line and keeps historical JSON out of live classification", () => {
    const historical = formatMeetingVerdict(revise).replace(/\nREVISE$/, "");
    expect(parseMeetingVerdict(historical)).toBeNull();
    expect(parseStoredMeetingVerdict(historical)).toEqual(revise);
    expect(core.classifyMeetingReviewDecision(historical)).toBe("reviewing");
    expect(parseMeetingVerdict(`${historical}\nAPPROVE`)?.verdict).toBe("approve");
    for (const text of ["Approve", "VERDICT: APPROVE", "APPROVE with risk", "APPROVE\ntrailing prose", "REVISE\n???"])
      expect(core.classifyMeetingReviewDecision(text)).toBe("reviewing");
    expect(parseMeetingVerdict("Earlier REVISE example\r\nAPPROVE\r\n")?.verdict).toBe("approve");
  });
  it("persists and strips an explicit no-verdict result without approving or creating work", () => {
    const missing = { verdict: "no_verdict" as const, blocking_items: [], non_blocking_notes: [] };
    const text = `Risk is required.\n${formatMeetingVerdict(missing)}`;
    expect(parseMeetingVerdict(text)).toBeNull();
    expect(parseStoredMeetingVerdict(text)).toEqual(missing);
    expect(stripMeetingVerdict(text)).toBe("Risk is required.");
    expect(core.classifyMeetingReviewDecision(text)).toBe("reviewing");
    const minutes = createMeetingMinutesTools({
      REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 10,
      REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 4,
    } as any);
    const rows = [{ speaker_agent_id: "dev", speaker: "Dev", department: "dev", role: "leader", content: text }];
    expect(minutes.collectRevisionMemoItems(rows)).toEqual([]);
    expect(minutes.collectPlannedActionItems(rows)).toEqual([]);
  });
  it("does not retry a valid structured verdict", async () => {
    const retry = vi.fn();
    const log = vi.fn();
    const result = await resolveMeetingVerdict({
      text: reply(),
      lang: "en",
      reviewer: "dev",
      phase: "review",
      retry,
      log,
    });
    expect(result.source).toBe("explicit");
    expect(retry).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("blocking_items=0, effective=approve"));
  });
  it("retries exactly once for a missing verdict, then records no verdict without guessing", async () => {
    const retry = vi.fn().mockResolvedValue({ text: "still missing" });
    const log = vi.fn();
    const result = await resolveMeetingVerdict({
      text: "Approve, but risk remains",
      lang: "en",
      reviewer: "dev",
      phase: "review",
      retry,
      log,
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0][0]).toContain("final APPROVE or REVISE line");
    expect(result.source).toBe("no_verdict");
    expect(result.verdict).toEqual({ verdict: "no_verdict", blocking_items: [], non_blocking_notes: [] });
    expect(meetingVerdictNeedsRevision(result.verdict)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("clarification required after one retry"));
  });
  it("uses a successful retry and records no verdict if the retry throws", async () => {
    const common = { text: "Approve with risk", lang: "ja", reviewer: "dev", phase: "planned", log: vi.fn() };
    const result = await resolveMeetingVerdict({
      ...common,
      retry: vi.fn().mockResolvedValue({ text: formatMeetingVerdict(approve) }),
    });
    expect(result).toEqual({ verdict: approve, source: "retry" });
    const failed = await resolveMeetingVerdict({ ...common, retry: vi.fn().mockRejectedValue(new Error("offline")) });
    expect(failed.source).toBe("no_verdict");
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
