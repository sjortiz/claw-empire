import { describe, expect, it, vi } from "vitest";
import { appendMeetingVerdict } from "../../../../../shared/meeting-verdict.ts";
import { createReplyCoreTools } from "../../core/reply-core-tools.ts";
import { createReviewConsensusTools } from "./review-consensus.ts";

const approval = { verdict: "approve" as const, blocking_items: [], non_blocking_notes: [] };

async function review(
  finalVerdict: typeof approval | { verdict: "revise"; blocking_items: string[]; non_blocking_notes: string[] },
  options: { missing?: boolean; round?: number } = {},
) {
  const leader = { id: "dev", name: "Dev", department_id: "development", role: "team_leader" };
  const appendTaskProjectMemo = vi.fn();
  const reserveReviewRevisionMemoItems = vi.fn((_id, _round, items) => ({ freshItems: items, duplicateCount: 0 }));
  const chooseSafeReply = vi.fn((run) => run.text.slice(0, 50));
  const legacy = createReplyCoreTools({
    detectLang: () => "en",
    getPreferredLanguage: () => "en",
    pickL: (lines) => lines.en[0],
    prettyStreamJson: (text) => text,
  });
  const meetingReviewDecisionByAgent = new Map();
  const finishMeetingMinutes = vi.fn();
  const appendTaskLog = vi.fn();
  const onApproved = vi.fn();
  const appendTaskReviewFinalMemo = vi.fn();
  const scheduleNextReviewRound = vi.fn();
  const runAgentOneShot = vi.fn(async (_agent, prompt) => {
    if (prompt.includes("Return ONLY")) return { text: "Still missing" };
    if (prompt === "feedback")
      return {
        text: appendMeetingVerdict("Approve with risk note.", {
          ...approval,
          non_blocking_notes: ["Watch downstream risk"],
        }),
      };
    return {
      text:
        options.missing && prompt === "approval"
          ? "Approve with no risk"
          : appendMeetingVerdict("Approved. #47 blocks downstream work; risk is documented.", finalVerdict),
    };
  });
  const round = options.round ?? 1;
  const db = {
    prepare: (sql: string) => ({
      get: () =>
        sql.includes("SELECT id, round")
          ? round > 1
            ? { round: round - 1, status: "completed" }
            : undefined
          : sql.includes("COUNT(*)")
            ? { cnt: 0 }
            : sql.includes("MAX(seq)")
              ? { max_seq: 0 }
              : { description: "Task", project_path: "/workspace", workflow_pack_key: null },
    }),
  };
  const deps = {
    db,
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () => [leader],
    getTaskStatusById: () => "review",
    getReviewRoundMode: () =>
      round === 1 ? "parallel_remediation" : round === 2 ? "merge_synthesis" : "final_decision",
    scheduleNextReviewRound,
    resolveProjectPath: () => "/workspace",
    resolveLang: () => "en",
    runAgentOneShot,
    chooseSafeReply,
    appendTaskLog,
    notifyCeo: vi.fn(),
    l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
    pickL: (pool: { en: string[] }) => pool.en[0],
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: (id: string, _seat: number, _phase: string, _task: string, text: string) =>
      meetingReviewDecisionByAgent.set(id, legacy.classifyMeetingReviewDecision(text)),
    getAgentDisplayName: (agent: { name: string }) => agent.name,
    getDeptName: (id: string) => id,
    getRoleLabel: (role: string) => role,
    appendMeetingMinuteEntry: vi.fn(),
    beginMeetingMinutes: () => "meeting",
    finishMeetingMinutes,
    callLeadersToCeoOffice: vi.fn(),
    dismissLeadersFromCeoOffice: vi.fn(),
    wantsReviewRevision: legacy.wantsReviewRevision,
    meetingReviewDecisionByAgent,
    findLatestTranscriptContentByAgent: legacy.findLatestTranscriptContentByAgent,
    isDeferrableReviewHold: () => true,
    summarizeForMeetingBubble: (text: string) => text.slice(0, 160),
    appendTaskProjectMemo,
    appendTaskReviewFinalMemo,
    collectRevisionMemoItems: vi.fn(() => ["BAD: guessed risk"]),
    reserveReviewRevisionMemoItems,
    loadRecentReviewRevisionMemoItems: () => [],
    clearTaskWorkflowState: vi.fn(),
    isTaskWorkflowInterrupted: () => false,
    randomDelay: () => 0,
    sleepMs: async () => {},
    buildMeetingPrompt: (_agent: unknown, opts: { turnObjective: string }) =>
      opts.turnObjective.includes("single-party")
        ? "feedback"
        : opts.turnObjective.includes("final approval decision for this review round") ||
            opts.turnObjective.includes("final approval decision and documentation") ||
            opts.turnObjective.includes("consolidated package is ready")
          ? "approval"
          : "other",
    REVIEW_MAX_ROUNDS: 3,
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 10,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 5,
    REVIEW_MAX_REMEDIATION_REQUESTS: 3,
    REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND: 1,
    REVIEW_MAX_REVISION_SIGNALS_PER_ROUND: 6,
  };
  createReviewConsensusTools(deps).startReviewConsensusMeeting("task", "Task", "development", onApproved);
  await vi.waitFor(() => expect(finishMeetingMinutes).toHaveBeenCalled());
  return { ...deps, onApproved };
}

describe("review meeting structured decisions", () => {
  it("approves risk/blocks wording and retains earlier notes after final approval", async () => {
    const result = await review(approval);
    expect(result.onApproved).toHaveBeenCalledOnce();
    expect(result.finishMeetingMinutes).toHaveBeenCalledWith("meeting", "completed");
    expect(result.reserveReviewRevisionMemoItems).not.toHaveBeenCalled();
    expect(result.appendTaskProjectMemo).toHaveBeenCalledWith(
      "task",
      "review",
      1,
      ["Dev: Watch downstream risk"],
      "en",
      "non_blocking",
    );
  });
  it("only explicit blocking items request revision, even if legacy deferral says monitoring", async () => {
    const result = await review({
      verdict: "revise",
      blocking_items: ["Fix monitoring API before approval"],
      non_blocking_notes: ["Consider risk later"],
    });
    expect(result.onApproved).not.toHaveBeenCalled();
    expect(result.finishMeetingMinutes).toHaveBeenCalledWith("meeting", "revision_requested");
    expect(result.reserveReviewRevisionMemoItems).toHaveBeenCalledWith("task", 1, [
      "development Dev: Fix monitoring API before approval",
    ]);
    expect(result.collectRevisionMemoItems).not.toHaveBeenCalled();
  });
  it("treats revise with zero blocking items as approval", async () => {
    const result = await review({ ...approval, verdict: "revise" });
    expect(result.onApproved).toHaveBeenCalledOnce();
  });
  it("retries a missing verdict once then logs classifier fallback", async () => {
    const result = await review(approval, { missing: true });
    expect(result.runAgentOneShot.mock.calls.filter(([, prompt]) => prompt.includes("Return ONLY"))).toHaveLength(1);
    expect(result.appendTaskLog).toHaveBeenCalledWith(
      "task",
      "system",
      expect.stringContaining("legacy classifier fallback"),
    );
    expect(result.onApproved).toHaveBeenCalledOnce();
  });
  it("keeps round two's existing transition to final round", async () => {
    const result = await review(approval, { round: 2 });
    expect(result.scheduleNextReviewRound).toHaveBeenCalledWith("task", "Task", 2, "en");
    expect(result.onApproved).not.toHaveBeenCalled();
  });
  it("keeps final round forced residual-risk approval without remediation", async () => {
    const result = await review({ ...approval, verdict: "revise", blocking_items: ["Blocking item"] }, { round: 3 });
    expect(result.finishMeetingMinutes).toHaveBeenCalledWith("meeting", "completed");
    expect(result.appendTaskReviewFinalMemo).toHaveBeenCalledWith("task", 3, expect.any(Array), "en", true);
    expect(result.onApproved).toHaveBeenCalledOnce();
  });
});
