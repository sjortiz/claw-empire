import { expect, it, vi } from "vitest";
import { appendMeetingVerdict, type MeetingVerdict } from "../../../../shared/meeting-verdict.ts";
import { createPlannedApprovalTools } from "./planned-approval.ts";
import { createMeetingMinutesTools } from "./meetings/minutes.ts";

const approval: MeetingVerdict = {
  verdict: "approve",
  blocking_items: [],
  non_blocking_notes: ["Track downstream risk"],
};
async function planned(
  verdict: MeetingVerdict,
  opts: {
    graph?: boolean;
    missing?: boolean;
    empty?: boolean;
    retry?: boolean;
    solo?: boolean;
    draft?: string;
    summary?: string;
  } = {},
) {
  const planner = { id: "planner", name: "Planner", department_id: "planning", role: "team_leader" };
  const dev = { id: "dev", name: "Development", department_id: "development", role: "team_leader" };
  const appendTaskProjectMemo = vi.fn();
  const appendTaskLog = vi.fn();
  const finishMeetingMinutes = vi.fn();
  const onApproved = vi.fn();
  const { collectPlannedActionItems: collectActions } = createMeetingMinutesTools({
    db: {},
    nowMs: () => 0,
    getDeptName: (id) => id,
    getRoleLabel: (role) => role,
    getAgentDisplayName: (agent) => agent.name,
    pickL: (pool) => pool.en[0],
    l: (ko, en, ja, zh) => ({ ko, en, ja, zh }),
    summarizeForMeetingBubble: (text) => text,
    appendTaskLog,
    broadcast: vi.fn(),
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 10,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 5,
  });
  const collectPlannedActionItems = vi.fn(collectActions);
  const graph = {
    plan_items: [{ key: "fix", title: "Implement requested API", department_id: "development", depends_on: [] }],
  };
  let planningTurn = 0;
  const runAgentOneShot = vi.fn(async (agent, prompt) => {
    if (prompt.includes("Return ONLY")) return { text: opts.retry ? JSON.stringify(verdict) : "No verdict" };
    const isSummary = agent.id === "planner" && (!opts.solo || planningTurn++ > 0);
    const text =
      isSummary && opts.graph
        ? `\`\`\`json\n${JSON.stringify(graph)}\n\`\`\``
        : ((isSummary ? opts.summary : opts.draft) ??
          (opts.missing ? "Approved. This blocks downstream work; risk is recorded." : ""));
    return { text: opts.empty ? "" : opts.missing || opts.retry ? text : appendMeetingVerdict(text, verdict) };
  });
  const deps = {
    reviewInFlight: new Set<string>(),
    reviewRoundState: new Map<string, number>(),
    db: { prepare: () => ({ get: () => ({ description: "Implement requested API", assigned_agent_id: null }) }) },
    getTaskReviewLeaders: () => (opts.solo ? [planner] : [planner, dev]),
    resolveProjectPath: () => "/workspace",
    resolveLang: () => "en",
    beginMeetingMinutes: () => "meeting",
    isTaskWorkflowInterrupted: () => false,
    getTaskStatusById: () => "planned",
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    getAgentDisplayName: (agent: { name: string }) => agent.name,
    getDeptName: (id: string) => id,
    getRoleLabel: (role: string) => role,
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: vi.fn(),
    appendMeetingMinuteEntry: vi.fn(),
    callLeadersToCeoOffice: vi.fn(),
    notifyCeo: vi.fn(),
    pickL: (pool: { en: string[] }) => pool.en[0],
    l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
    buildMeetingPrompt: (_agent: unknown, context: { turnObjective: string }) => context.turnObjective,
    runAgentOneShot,
    chooseSafeReply: (run: { text: string }) => run.text.slice(0, 40),
    sleepMs: async () => {},
    randomDelay: () => 0,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskLog,
  };
  createPlannedApprovalTools(deps).startPlannedApprovalMeeting("task", "Task", "planning", onApproved);
  await vi.waitFor(() => expect(finishMeetingMinutes).toHaveBeenCalled());
  return { ...deps, onApproved, graph };
}

it("planning obeys the same approval parser and never turns structured approval notes into fallback work", async () => {
  const result = await planned(approval);
  expect(result.onApproved).toHaveBeenCalledWith([]);
  expect(result.collectPlannedActionItems).toHaveBeenCalledWith([], 10);
  expect(result.appendTaskProjectMemo).toHaveBeenCalledWith(
    "task",
    "planned",
    1,
    ["Development: Track downstream risk", "Planner: Track downstream risk"],
    "en",
    "non_blocking",
  );
  expect(result.appendTaskLog).toHaveBeenCalledWith("task", "system", expect.stringContaining("supplement-signals=no"));
});
it("planning retains requested implementation plan_items with an approve verdict", async () => {
  const result = await planned(approval, { graph: true });
  expect(result.onApproved).toHaveBeenCalledWith([JSON.stringify(result.graph)]);
  expect(result.collectPlannedActionItems).not.toHaveBeenCalled();
});
it.each([false, true])("planning retains executable approved prose (verdict-only retry: %s)", async (retry) => {
  const result = await planned(approval, {
    retry,
    draft: "Implement API validation and verify malformed requests return 400.",
    summary: "Add endpoint integration coverage and record the passing checks.",
  });
  expect(result.onApproved).toHaveBeenCalledWith([
    "development Development: Implement API validation and verify malformed requests return 400.",
    "planning Planner: Add endpoint integration coverage and record the passing checks.",
  ]);
  expect(result.runAgentOneShot.mock.calls.filter(([, prompt]) => prompt.includes("Return ONLY"))).toHaveLength(
    retry ? 2 : 0,
  );
});
it("planning excludes notes repeated in prose before the real extractor prioritizes risks", async () => {
  const result = await planned(approval, {
    draft: "Implement API validation and verify malformed requests return 400.\nTrack downstream risk",
    summary: "Track downstream risk",
  });
  expect(result.onApproved).toHaveBeenCalledWith([
    "development Development: Implement API validation and verify malformed requests return 400.",
  ]);
  expect(result.collectPlannedActionItems.mock.calls[0][0]).toEqual([
    expect.objectContaining({ content: "Implement API validation and verify malformed requests return 400." }),
  ]);
});
it("planning produces no work from note-only prose with a recovered standalone verdict", async () => {
  const result = await planned(approval, {
    retry: true,
    draft: "Track downstream risk",
    summary: "Track downstream risk",
  });
  expect(result.onApproved).toHaveBeenCalledWith([]);
  expect(result.collectPlannedActionItems).toHaveBeenCalledWith([], 10);
});
it("planning keeps each solo planner turn's own prose and verdict", async () => {
  const result = await planned(approval, {
    solo: true,
    draft: "Implement API validation and verify malformed requests return 400.",
    summary: "Approved",
  });
  expect(result.onApproved).toHaveBeenCalledWith([
    "planning Planner: Implement API validation and verify malformed requests return 400.",
    "planning Planner: Approved",
  ]);
});
it("planning converts only explicit blocking items into fallback actions", async () => {
  const result = await planned(
    {
      verdict: "revise",
      blocking_items: ["Implement API validation"],
      non_blocking_notes: ["Track risk later"],
    },
    {
      draft: "Also rewrite the entire endpoint unrelated to the blocker.",
      summary: "Track risk later",
    },
  );
  expect(result.onApproved).toHaveBeenCalledWith([
    "development Development: Implement API validation",
    "planning Planner: Implement API validation",
  ]);
  expect(result.appendTaskLog).toHaveBeenCalledWith(
    "task",
    "system",
    expect.stringContaining("supplement-signals=yes"),
  );
});
it("planning treats revise without blockers as approve", async () => {
  const result = await planned({ ...approval, verdict: "revise" });
  expect(result.onApproved).toHaveBeenCalledWith([]);
  expect(result.appendTaskLog).toHaveBeenCalledWith("task", "system", expect.stringContaining("supplement-signals=no"));
});
it("planning retries each missing verdict exactly once then logs its legacy fallback", async () => {
  const result = await planned(approval, { missing: true });
  expect(result.runAgentOneShot.mock.calls.filter(([, prompt]) => prompt.includes("Return ONLY"))).toHaveLength(2);
  expect(
    result.appendTaskLog.mock.calls.filter(([, , message]) => message.includes("legacy classifier fallback")),
  ).toHaveLength(2);
  expect(result.onApproved).toHaveBeenCalledWith([
    "development Development: Approved. This blocks downstream work; risk is recorded.",
  ]);
  expect(result.collectPlannedActionItems.mock.calls[0][0].map((entry) => entry.content)).toEqual([
    "Approved. This blocks downstream work; risk is recorded.",
    "Approved. This blocks downstream work; risk is recorded.",
  ]);
});

it("planning retries empty successful replies before falling back", async () => {
  const result = await planned(approval, { empty: true });
  expect(result.runAgentOneShot.mock.calls.filter(([, prompt]) => prompt.includes("Return ONLY"))).toHaveLength(2);
  expect(result.onApproved).toHaveBeenCalledOnce();
});
