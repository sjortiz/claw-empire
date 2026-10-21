import express from "express";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { registerDirectiveAndInboxRoutes } from "../ops/messages/directives-inbox-routes.ts";
import { createTaskDelegationHandler } from "./task-delegation.ts";
import { createPlannedApprovalTools } from "../../workflow/orchestration/planned-approval.ts";
import { createMeetingLeaderSelectionTools } from "../../workflow/orchestration/meetings/leader-selection.ts";
import { createSubtaskSeedingTools } from "../../workflow/agents/subtask-seeding.ts";
import { createMeetingMinutesTools } from "../../workflow/orchestration/meetings/minutes.ts";
import { nexoDirective, nexoSupportPlan } from "../../../test/implementation-planning-fixture.ts";

vi.mock("../../../config/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/runtime.ts")>()),
  INBOX_WEBHOOK_SECRET: "nexo-replay-test-secret",
}));

let db: DatabaseSync;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  db?.close();
});

it.each([
  nexoDirective,
  "Fix the first two open issues on Nexo, #84 and #85, add tests and documentation, one branch per issue",
])("persists executable per-issue ownership through HTTP intake: %s", async (directive) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES
      ('planning', 'Planning', 'Planning', 'P', '#111'),
      ('dev', 'Development', 'Development', 'D', '#111'),
      ('operations', 'Operations', 'Operations', 'O', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES
      ('planner', 'Planner', 'planning', 'team_leader', 'codex', 'idle'),
      ('developer', 'Developer', 'dev', 'team_leader', 'codex', 'idle'),
      ('operator', 'Operator', 'operations', 'team_leader', 'codex', 'idle');
    INSERT INTO projects (id, name, project_path, core_goal) VALUES
      ('nexo', 'Nexo', '/workspace/nexo', 'Fix the requested issues');
  `);
  const findTeamLeader = (dept: string) => db.prepare("SELECT * FROM agents WHERE department_id = ?").get(dept) as any;
  // The real pre-check is keyword inference, not an LLM call. Reproduce its Operations-only result.
  const detectTargetDepartments = vi.fn(() => ["operations"]);
  const appendTaskLog = vi.fn();
  const common = {
    db,
    nowMs: () => Date.now(),
    resolveLang: () => "en" as const,
    getDeptName: (id: string) => id,
    getRoleLabel: (role: string) => role,
    findTeamLeader,
    appendTaskLog,
    broadcast: vi.fn(),
    notifyCeo: vi.fn(),
    l: (_ko: string[], en: string[]) => en,
    pickL: (pool: string[]) => pool[0],
    isTaskWorkflowInterrupted: () => false,
  };
  const selection = createMeetingLeaderSelectionTools({ db, findTeamLeader, detectTargetDepartments });
  const supportOnly = JSON.stringify({ plan_items: nexoSupportPlan() });
  // Every department draft, consolidation and correction repeats the deficient original plan.
  // Success must come from production validation/repair, never from a helpful model stub.
  const runAgentOneShot = vi.fn(async (_agent: { id: string }, _prompt: string) => ({ text: supportOnly }));
  const appendTaskProjectMemo = vi.fn();
  const minutes = createMeetingMinutesTools({
    ...common,
    getAgentDisplayName: (agent) => agent.name,
    summarizeForMeetingBubble: (text) => text,
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 10,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 10,
  });
  const meeting = createPlannedApprovalTools({
    ...common,
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: (id, dept) => selection.getTaskReviewLeaders(id, dept, { fallbackAll: false }),
    resolveProjectPath: () => "/workspace/nexo",
    beginMeetingMinutes: () => "nexo-meeting",
    getTaskStatusById: (id: string) => db.prepare("SELECT status FROM tasks WHERE id = ?").get(id)?.status,
    finishMeetingMinutes: vi.fn(),
    dismissLeadersFromCeoOffice: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    getAgentDisplayName: (agent: any) => agent.name,
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: vi.fn(),
    appendMeetingMinuteEntry: vi.fn(),
    callLeadersToCeoOffice: vi.fn(),
    buildMeetingPrompt: (_agent, context) => context.turnObjective,
    runAgentOneShot,
    chooseSafeReply: (result) => result.text,
    sleepMs: async () => {},
    randomDelay: () => 0,
    collectPlannedActionItems: minutes.collectPlannedActionItems,
    appendTaskProjectMemo,
  });
  const seeding = createSubtaskSeedingTools({
    ...common,
    analyzeSubtaskDepartment: () => null,
    rerouteSubtasksByPlanningLeader: vi.fn(),
    getPreferredLanguage: () => "en",
  });
  const processSubtaskDelegations = vi.fn();
  const startTaskExecutionForAgent = vi.fn();
  const normalizeTextField = (value: unknown) => (typeof value === "string" ? value.trim() || null : null);
  const handleTaskDelegation = createTaskDelegationHandler({
    ...common,
    detectTargetDepartments,
    findBestSubordinate: () => null,
    normalizeTextField,
    resolveProjectFromOptions: () => ({
      id: "nexo",
      name: "Nexo",
      projectPath: "/workspace/nexo",
      coreGoal: "Fix the requested issues",
    }),
    buildRoundGoal: (_goal: string | null, message: string) => message,
    resolveDirectiveProjectPath: () => ({ projectPath: "/workspace/nexo", source: "explicit" }),
    recordTaskCreationAudit: vi.fn(),
    hasOpenForeignSubtasks: () => true,
    processSubtaskDelegations,
    startCrossDeptCooperation: vi.fn(),
    seedApprovedPlanSubtasks: seeding.seedApprovedPlanSubtasks,
    startPlannedApprovalMeeting: meeting.startPlannedApprovalMeeting,
    sendAgentMessage: vi.fn(),
    registerTaskMessengerRoute: vi.fn(),
    startTaskExecutionForAgent,
  } as any);
  const app = express();
  app.use(express.json());
  registerDirectiveAndInboxRoutes({ app, db: db as any, broadcast: common.broadcast }, {
    IdempotencyConflictError: class extends Error {},
    StorageBusyError: class extends Error {},
    enforceDirectiveProjectBinding: true,
    resolveMessageIdempotencyKey: () => null,
    recordMessageIngressAuditOr503: () => true,
    insertMessageWithIdempotency: async (input: any) => ({
      created: true,
      message: { id: "nexo-message", content: input.content, message_type: input.messageType },
    }),
    recordAcceptedIngressAuditOrRollback: async () => true,
    normalizeTextField,
    scheduleAnnouncementReplies: vi.fn(),
    analyzeDirectivePolicy: () => ({ skipPlannedMeeting: false, skipPlanSubtasks: false }),
    shouldExecuteDirectiveDelegation: () => true,
    findTeamLeader,
    handleTaskDelegation,
    scheduleAgentReply: vi.fn(),
    resetDirectChatState: vi.fn(),
    detectMentions: () => ({ deptIds: [], agentIds: [] }),
  } as any);
  const response = await request(app)
    .post("/api/inbox")
    .set("x-inbox-secret", "nexo-replay-test-secret")
    .send({
      text: `$${directive}`,
      agent_rules_version: 2,
      project_id: "nexo",
      project_path: "/workspace/nexo",
    });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ok: true, directive: true });
  await vi.advanceTimersByTimeAsync(6000);
  const root = db.prepare("SELECT * FROM tasks").get() as any;
  const rows = db.prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY rowid").all(root.id) as any[];
  const fixes = rows.filter((row) => row.target_department_id === "dev");
  // Keep a representative persisted graph in the command log, including the failing baseline.
  console.info(
    "Nexo HTTP replay graph:",
    JSON.stringify(
      rows.map((row) => ({
        title: row.title,
        owner: row.target_department_id,
        agent: row.assigned_agent_id,
        depends_on: JSON.parse(row.depends_on ?? "[]").map((id: string) => rows.find((item) => item.id === id)?.title),
      })),
    ),
  );
  expect(fixes).toHaveLength(2);
  expect(rows).toHaveLength(9);
  expect(root).toMatchObject({ department_id: "planning", project_id: "nexo", status: "collaborating" });
  for (const issue of [84, 85]) {
    const fix = fixes.find((row) => row.title.includes(`#${issue}`));
    expect(fix).toMatchObject({ assigned_agent_id: "developer", status: "pending" });
    expect(fix.description).toContain(`production code for #${issue}`);
    expect(fix.description).toContain("regression tests");
    expect(fix.description).toContain("separate branch for this issue");
    expect(JSON.parse(fix.depends_on)).toEqual([]);
  }
  for (const support of nexoSupportPlan()) expect(rows.some((row) => row.title === support.title)).toBe(true);
  const fix84 = fixes.find((row) => row.title.includes("#84"));
  const verify84 = rows.find((row) => row.title === "Verify completed fix #84");
  const evidence = rows.find((row) => row.title === "Consolidate completion evidence");
  const observability = rows.find((row) => row.title === "Configure observability");
  expect(verify84).toMatchObject({ target_department_id: "operations", assigned_agent_id: "operator" });
  expect(JSON.parse(verify84.depends_on)).toEqual([fix84.id]);
  expect(JSON.parse(evidence.depends_on)).toEqual(fixes.map((row) => row.id));
  // The preparation handoff has real implementation owners; preparation can remain parallel.
  expect(observability.description).toContain("left to the implementation owner");
  expect(JSON.parse(observability.depends_on)).toEqual([]);
  expect(fixes.every((row) => findTeamLeader(row.target_department_id)?.id === row.assigned_agent_id)).toBe(true);
  expect(fix84.status).toBe("pending");
  for (const title of [
    "Set up test automation",
    "Prepare CI/CD readiness",
    "Issue separate implementation specifications",
  ])
    expect(JSON.parse(rows.find((row) => row.title === title).depends_on)).toEqual([]);
  const logText = appendTaskLog.mock.calls.map((call) => call[2]).join("\n");
  expect(logText).toContain("Planning pre-check related departments: operations, dev");
  expect(logText).toContain("override=added dev; inferred=operations");
  expect(logText).toContain("Planning graph rejected");
  expect(logText).toContain("revalidation passed");
  expect(runAgentOneShot.mock.calls.map((call) => call[0].id)).toContain("developer");
  const summaries = runAgentOneShot.mock.calls.filter((call) => call[0].id === "planner");
  expect(summaries).toHaveLength(2);
  expect(summaries[1][1]).toContain("Missing Development implementation for issue-84");
  expect(summaries[1][1]).toContain("Missing Development implementation for issue-85");
  expect(summaries[1][1]).toContain("dangling implementation-owner handoff");
  expect(appendTaskProjectMemo).toHaveBeenCalled();
  expect(processSubtaskDelegations).toHaveBeenCalledWith(root.id);
  expect(startTaskExecutionForAgent).not.toHaveBeenCalled();
});
