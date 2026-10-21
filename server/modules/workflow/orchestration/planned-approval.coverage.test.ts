import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { createPlannedApprovalTools } from "./planned-approval.ts";
import { createSubtaskSeedingTools } from "../agents/subtask-seeding.ts";

let db: DatabaseSync;
afterEach(() => db?.close());
function setup(outputs: string[], noLeaders = false) {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', 'P', 'P', '#111'), ('dev', 'Development', 'D', 'D', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES ('planner', 'Planner', 'planning', 'senior', 'codex', 'idle'), ('developer', 'Developer', 'dev', 'team_leader', 'codex', 'idle');
    INSERT INTO tasks (id, title, description, department_id, assigned_agent_id, status) VALUES ('root', 'Nexo', '[CEO] Fix Nexo issues #84 and #85 with tests, one branch per issue.', 'planning', 'planner', 'planned');
  `);
  const logs = vi.fn();
  const notify = vi.fn();
  const finish = vi.fn();
  const approved = vi.fn();
  const prompts: any[] = [];
  const run = vi.fn((agent: any) =>
    Promise.resolve({ text: agent.id === "planner" ? (outputs.shift() ?? "No code work") : "Department draft" }),
  );
  const leaders = db.prepare("SELECT * FROM agents").all();
  const tools = createPlannedApprovalTools({
    db,
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () => (noLeaders ? [] : leaders),
    resolveProjectPath: () => "/workspace/project",
    resolveLang: () => "en",
    beginMeetingMinutes: () => "meeting",
    isTaskWorkflowInterrupted: () => false,
    getTaskStatusById: () => "planned",
    finishMeetingMinutes: finish,
    dismissLeadersFromCeoOffice: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    getAgentDisplayName: (a: any) => a.name,
    getDeptName: (id: string) => id,
    getRoleLabel: (r: string) => r,
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: vi.fn(),
    appendMeetingMinuteEntry: vi.fn(),
    callLeadersToCeoOffice: vi.fn(),
    notifyCeo: notify,
    l: (_ko: string[], en: string[]) => en,
    pickL: (v: string[]) => v[0],
    buildMeetingPrompt: (_a: any, context: any) => {
      prompts.push(context);
      return context.turnObjective;
    },
    runAgentOneShot: run,
    chooseSafeReply: (r: any) => r.text,
    sleepMs: async () => {},
    randomDelay: () => 0,
    collectPlannedActionItems: () => [],
    appendTaskProjectMemo: vi.fn(),
    appendTaskLog: logs,
  });
  tools.startPlannedApprovalMeeting("root", "Nexo", "planning", approved);
  return { logs, notify, finish, approved, prompts, run };
}
const validGraph = {
  plan_items: [84, 85].map((issue) => ({
    key: `fix${issue}`,
    title: `Fix Nexo #${issue}`,
    description: "Change production code, add regression tests on a separate branch per issue",
    department_id: "dev",
    depends_on: [],
  })),
};

it("rejects deficient consolidation then accepts and persists only a corrected per-issue plan", async () => {
  const state = setup([
    JSON.stringify({
      plan_items: [
        {
          key: "spec",
          title: "Write implementation specifications for #84 and #85",
          department_id: "dev",
          depends_on: [],
        },
      ],
    }),
    JSON.stringify(validGraph),
  ]);
  await vi.waitFor(() => expect(state.approved).toHaveBeenCalledTimes(1));
  expect(state.logs.mock.calls.some((c) => String(c[2]).includes("Planning graph rejected"))).toBe(true);
  expect(
    state.prompts.every((context) => context.requiresImplementation && context.implementationUnits.length === 2),
  ).toBe(true);
  const summaryCalls = state.run.mock.calls.filter(([agent]) => agent.id === "planner");
  expect(summaryCalls).toHaveLength(2);
  const seed = createSubtaskSeedingTools({
    db,
    nowMs: () => 1,
    broadcast: vi.fn(),
    analyzeSubtaskDepartment: () => null,
    rerouteSubtasksByPlanningLeader: vi.fn(),
    findTeamLeader: (dept: string) => db.prepare("SELECT * FROM agents WHERE department_id = ?").get(dept),
    getDeptName: (id: string) => id,
    getPreferredLanguage: () => "en",
    resolveLang: () => "en",
    l: (_ko: string[], en: string[]) => en,
    pickL: (v: string[]) => v[0],
    appendTaskLog: vi.fn(),
    notifyCeo: vi.fn(),
  });
  seed.seedApprovedPlanSubtasks("root", "planning", state.approved.mock.calls[0][0]);
  const rows = db
    .prepare("SELECT title, target_department_id, assigned_agent_id, status FROM subtasks ORDER BY title")
    .all();
  expect(rows).toEqual(
    [84, 85].map((issue) => ({
      title: `Fix Nexo #${issue}`,
      target_department_id: "dev",
      assigned_agent_id: "developer",
      status: "pending",
    })),
  );
});
it("never approves deficient graphs after all correction attempts", async () => {
  const state = setup(["No code work", "Still no code", "No code again"]);
  await vi.waitFor(() => expect(state.finish).toHaveBeenCalledWith("meeting", "failed"));
  expect(state.approved).not.toHaveBeenCalled();
  expect(state.run.mock.calls.filter(([agent]) => agent.id === "planner")).toHaveLength(3);
  expect(state.notify.mock.calls.at(-1)?.[0]).toContain("blocked after correction attempts");
  expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "planned" });
  expect(db.prepare("SELECT COUNT(*) AS n FROM subtasks").get()).toEqual({ n: 0 });
});
it("cannot bypass coverage when no planning leader exists", async () => {
  const state = setup([], true);
  await vi.waitFor(() => expect(state.notify).toHaveBeenCalled());
  expect(state.approved).not.toHaveBeenCalled();
  expect(state.notify.mock.calls[0][0]).toContain("no eligible planning leaders");
});
