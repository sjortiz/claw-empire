import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMeetingVerdict } from "../../../src/lib/meeting-verdict.ts";
import { applyBaseSchema } from "../../modules/bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../modules/bootstrap/schema/task-schema-migrations.ts";
import type { PlanningItem } from "../../modules/workflow/agents/planning-graph.ts";
import { createPlannedApprovalTools } from "../../modules/workflow/orchestration/planned-approval.ts";
import { nexoDirective, nexoImplementation, nexoSupportPlan } from "../implementation-planning-fixture.ts";

let db: DatabaseSync;
afterEach(() => db?.close());

const verdict = formatMeetingVerdict({ verdict: "approve", blocking_items: [], non_blocking_notes: [] });
const graphReply = (plan_items: PlanningItem[]) => `${JSON.stringify({ plan_items })}\n${verdict}`;
const supportPlan = (): PlanningItem[] => [
  ...nexoSupportPlan(),
  ...Array.from({ length: 24 }, (_, index) => ({
    key: `prepare_${index}`,
    title: `Prepare independent environment ${index}`,
    department_id: "operations",
    depends_on: [],
  })),
];
const mergedPlan = (): PlanningItem[] => [
  nexoImplementation(84),
  nexoImplementation(85),
  { key: "automation", title: "Set up test automation", department_id: "operations", depends_on: [] },
  {
    key: "evidence",
    title: "Consolidate completion evidence",
    description: "Collect completed fixes and test results for #84 and #85",
    department_id: "planning",
    depends_on: ["fix84", "fix85"],
  },
];

async function runMeeting(merged: PlanningItem[]) {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES
      ('planning', 'Planning', 'P', 'P', '#111'), ('dev', 'Development', 'D', 'D', '#111'),
      ('operations', 'Operations', 'O', 'O', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES
      ('planner', 'Planner', 'planning', 'senior', 'codex', 'idle'),
      ('developer', 'Developer', 'dev', 'team_leader', 'codex', 'idle');
    INSERT INTO tasks (id, title, department_id, assigned_agent_id, status)
      VALUES ('root', 'Nexo', 'planning', 'planner', 'planned');
  `);
  db.prepare("UPDATE tasks SET description = ? WHERE id = 'root'").run(`[CEO] ${nexoDirective}`);
  const run = vi
    .fn()
    .mockResolvedValueOnce({ text: `Department draft\n${verdict}` })
    .mockResolvedValueOnce({ text: graphReply(supportPlan()) })
    .mockResolvedValueOnce({ text: graphReply(supportPlan()) })
    .mockResolvedValueOnce({ text: JSON.stringify({ plan_items: merged }) });
  const approved = vi.fn();
  const logs = vi.fn();
  const finish = vi.fn();
  createPlannedApprovalTools({
    db,
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () => db.prepare("SELECT * FROM agents WHERE id = 'developer'").all(),
    resolveProjectPath: () => "/workspace/project",
    resolveLang: () => "en",
    beginMeetingMinutes: () => "meeting",
    isTaskWorkflowInterrupted: () => false,
    getTaskStatusById: () => "planned",
    finishMeetingMinutes: finish,
    dismissLeadersFromCeoOffice: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    getAgentDisplayName: (agent) => agent.name,
    getDeptName: (id) => id,
    getRoleLabel: (role) => role,
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: vi.fn(),
    appendMeetingMinuteEntry: vi.fn(),
    callLeadersToCeoOffice: vi.fn(),
    notifyCeo: vi.fn(),
    pickL: (pool) => pool.en[0],
    l: (ko, en) => ({ ko, en }),
    buildMeetingPrompt: (_agent, context) => context.turnObjective,
    runAgentOneShot: run,
    chooseSafeReply: (reply) => reply.text,
    sleepMs: async () => {},
    randomDelay: () => 0,
    collectPlannedActionItems: () => [],
    appendTaskProjectMemo: vi.fn(),
    appendTaskLog: logs,
    classifyMeetingReviewDecision: () => "approved",
  }).startPlannedApprovalMeeting("root", "Nexo", "planning", approved);
  await vi.waitFor(() => expect(approved).toHaveBeenCalledTimes(1));
  return { run, logs, finish, accepted: JSON.parse(approved.mock.calls[0][0][0]).plan_items as PlanningItem[] };
}

describe("QA: oversized merging preserves repaired implementation coverage", () => {
  it("repairs missing implementation before merging and accepts a coverage-preserving merge", async () => {
    const merged = mergedPlan();
    const result = await runMeeting(merged);
    expect(result.run).toHaveBeenCalledTimes(4);
    expect(result.run.mock.calls[2][1]).toContain("Missing Development implementation for issue-84");
    const mergePrompt = result.run.mock.calls[3][1] as string;
    expect(mergePrompt).toContain("validated 33-item planning graph");
    expect(mergePrompt).toContain('"implementation_unit":"issue-84"');
    expect(mergePrompt).toContain('"implementation_unit":"issue-85"');
    const events = result.logs.mock.calls.map((call) => String(call[2]));
    const repair = events.findIndex((message) => message.includes("revalidation passed"));
    const merge = events.findIndex((message) => message.includes("asking the summarizer once"));
    expect(repair).toBeGreaterThanOrEqual(0);
    expect(merge).toBeGreaterThan(repair);
    expect(result.accepted).toEqual(merged);
    expect(result.finish).toHaveBeenCalledExactlyOnceWith("meeting", "completed");
  });

  it.each(["missing-unit", "missing-tests", "missing-branch", "missing-prerequisites"])(
    "restores the complete repaired graph when merging loses %s",
    async (failure) => {
      let merged = mergedPlan();
      if (failure === "missing-unit") {
        merged = merged.filter((item) => item.key !== "fix85");
        merged.find((item) => item.key === "evidence")!.depends_on = ["fix84"];
      }
      if (failure === "missing-tests") merged[0].description = "Change production code on a separate branch.";
      if (failure === "missing-branch") merged[0].description = "Change production code and add regression tests.";
      if (failure === "missing-prerequisites") merged.find((item) => item.key === "evidence")!.depends_on = [];
      const result = await runMeeting(merged);
      expect(result.run).toHaveBeenCalledTimes(4);
      expect(result.accepted).toHaveLength(33);
      for (const original of supportPlan()) {
        const retained = result.accepted.find((item) => item.key === original.key);
        expect(retained).toMatchObject({ ...original, depends_on: expect.any(Array) });
      }
      for (const issue of [84, 85]) {
        const implementation = result.accepted.find((item) => item.implementation_unit === `issue-${issue}`)!;
        expect(implementation.department_id).toBe("dev");
        expect(implementation.description).toMatch(/production code.*regression tests.*separate branch/);
        expect(implementation.depends_on).toEqual([]);
        expect(result.accepted.find((item) => item.key === "evidence")!.depends_on).toContain(implementation.key);
      }
      const fix84 = result.accepted.find((item) => item.implementation_unit === "issue-84")!;
      expect(result.accepted.find((item) => item.key === "verify84")!.depends_on).toContain(fix84.key);
      expect(result.logs).toHaveBeenCalledWith(
        "root",
        "system",
        expect.stringContaining("merged graph failed coverage"),
      );
      expect(result.finish).toHaveBeenCalledExactlyOnceWith("meeting", "completed");
    },
  );
});
