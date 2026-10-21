import { expect, it, vi } from "vitest";
import { appendMeetingVerdict, type MeetingVerdict } from "../../../../shared/meeting-verdict.ts";
import { createPlannedApprovalTools } from "./planned-approval.ts";

const approval: MeetingVerdict = {
  verdict: "approve",
  blocking_items: [],
  non_blocking_notes: ["Track downstream risk"],
};
async function planned(verdict: MeetingVerdict, opts: { graph?: boolean; missing?: boolean; empty?: boolean } = {}) {
  const planner = { id: "planner", name: "Planner", department_id: "planning", role: "team_leader" };
  const dev = { id: "dev", name: "Development", department_id: "development", role: "team_leader" };
  const appendTaskProjectMemo = vi.fn();
  const appendTaskLog = vi.fn();
  const finishMeetingMinutes = vi.fn();
  const onApproved = vi.fn();
  const collectPlannedActionItems = vi.fn((transcript: Array<{ content: string }>) =>
    transcript.map((entry) => entry.content),
  );
  const graph = {
    plan_items: [{ key: "fix", title: "Implement requested API", department_id: "development", depends_on: [] }],
  };
  const runAgentOneShot = vi.fn(async (agent, prompt) => {
    if (prompt.includes("Return ONLY")) return { text: "No verdict" };
    const text =
      agent.id === "planner" && opts.graph
        ? `\`\`\`json\n${JSON.stringify(graph)}\n\`\`\``
        : "Approved. This blocks downstream work; risk is recorded.";
    return { text: opts.empty ? "" : opts.missing ? text : appendMeetingVerdict(text, verdict) };
  });
  const deps = {
    reviewInFlight: new Set<string>(),
    reviewRoundState: new Map<string, number>(),
    db: { prepare: () => ({ get: () => ({ description: "Implement requested API", assigned_agent_id: null }) }) },
    getTaskReviewLeaders: () => [planner, dev],
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
it("planning converts only explicit blocking items into fallback actions", async () => {
  const result = await planned({
    verdict: "revise",
    blocking_items: ["Fix API"],
    non_blocking_notes: ["Track risk later"],
  });
  expect(result.onApproved).toHaveBeenCalledWith(["Fix API", "Fix API"]);
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
    "Approved. This blocks downstream work; risk is recorded.",
    "Approved. This blocks downstream work; risk is recorded.",
  ]);
});

it("planning retries empty successful replies before falling back", async () => {
  const result = await planned(approval, { empty: true });
  expect(result.runAgentOneShot.mock.calls.filter(([, prompt]) => prompt.includes("Return ONLY"))).toHaveLength(2);
  expect(result.onApproved).toHaveBeenCalledOnce();
});
