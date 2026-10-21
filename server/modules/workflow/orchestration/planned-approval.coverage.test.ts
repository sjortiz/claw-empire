import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { createPlannedApprovalTools } from "./planned-approval.ts";
import { createSubtaskSeedingTools } from "../agents/subtask-seeding.ts";
import { createMeetingLeaderSelectionTools } from "./meetings/leader-selection.ts";
import { hasUnfinishedDependencies } from "../../routes/collab/subtask-dependencies.ts";
import { nexoDirective, nexoImplementation, nexoSupportPlan } from "../../../test/implementation-planning-fixture.ts";

let db: DatabaseSync;
afterEach(() => db?.close());
function setup(outputs: string[], noLeaders = false, options: { holdDrafts?: boolean; description?: string } = {}) {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', 'P', 'P', '#111'), ('dev', 'Development', 'D', 'D', '#111'), ('operations', 'Operations', 'O', 'O', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES ('planner', 'Planner', 'planning', 'senior', 'codex', 'idle'), ('developer', 'Developer', 'dev', 'team_leader', 'codex', 'idle'), ('operator', 'Operator', 'operations', 'team_leader', 'codex', 'idle');
    INSERT INTO tasks (id, title, description, department_id, assigned_agent_id, status) VALUES ('root', 'Nexo', '[CEO] Fix Nexo issues #84 and #85 with tests, one branch per issue.', 'planning', 'planner', 'planned');
  `);
  const logs = vi.fn();
  const notify = vi.fn();
  const finish = vi.fn();
  const approved = vi.fn();
  const prompts: any[] = [];
  db.prepare("UPDATE tasks SET description = ? WHERE id = 'root'").run(options.description ?? `[CEO] ${nexoDirective}`);
  const releases = new Map<string, (result: { text: string }) => void>();
  const run = vi.fn((agent: any, _prompt?: string) => {
    if (agent.id === "planner") return Promise.resolve({ text: outputs.shift() ?? "No code work" });
    if (options.holdDrafts) return new Promise<{ text: string }>((resolve) => releases.set(agent.id, resolve));
    return Promise.resolve({ text: "Department draft" });
  });
  const selection = createMeetingLeaderSelectionTools({
    db,
    findTeamLeader: (dept) => db.prepare("SELECT * FROM agents WHERE department_id = ?").get(dept) as any,
    detectTargetDepartments: () => ["operations"],
  });
  const tools = createPlannedApprovalTools({
    db,
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () =>
      noLeaders ? [] : selection.getTaskReviewLeaders("root", "planning", { fallbackAll: false }),
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
  return { logs, notify, finish, approved, prompts, run, releases };
}
function seedingTools() {
  return createSubtaskSeedingTools({
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
}
const validGraph = { plan_items: [nexoImplementation(84), nexoImplementation(85)] };

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
  const seed = seedingTools();
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
  const state = setup(["No code work", "Still no code"]);
  await vi.waitFor(() => expect(state.finish).toHaveBeenCalledWith("meeting", "failed"));
  expect(state.approved).not.toHaveBeenCalled();
  expect(state.run.mock.calls.filter(([agent]) => agent.id === "planner")).toHaveLength(2);
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

it("reprompts once with specific violations, then repairs and materializes Nexo owners and consuming dependencies", async () => {
  const supportOnly = JSON.stringify({ plan_items: nexoSupportPlan() });
  const state = setup([supportOnly, supportOnly]);
  await vi.waitFor(() => expect(state.approved).toHaveBeenCalledTimes(1));
  const calls = state.run.mock.calls.filter(([agent]) => agent.id === "planner");
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toContain("Missing Development implementation for issue-84");
  expect(calls[1][1]).toContain("Missing Development implementation for issue-85");
  expect(calls[1][1]).toContain("observability: dangling implementation-owner handoff");
  expect(state.logs.mock.calls.some((call) => String(call[2]).includes("revalidation passed"))).toBe(true);
  seedingTools().seedApprovedPlanSubtasks("root", "planning", state.approved.mock.calls[0][0]);
  const rows = db.prepare("SELECT * FROM subtasks").all() as any[];
  expect(rows).toHaveLength(9);
  const fixes = rows.filter((row) => row.target_department_id === "dev").sort((a, b) => a.title.localeCompare(b.title));
  expect(fixes).toHaveLength(2);
  expect(fixes.map((row) => row.assigned_agent_id)).toEqual(["developer", "developer"]);
  for (const fix of fixes) {
    expect(fix.description).toMatch(/production code.*regression tests.*separate branch/);
    expect(JSON.parse(fix.depends_on)).toEqual([]);
    expect(hasUnfinishedDependencies(db, fix)).toBe(false);
  }
  const verify = rows.find((row) => row.title === "Verify completed fix #84");
  const evidence = rows.find((row) => row.title === "Consolidate completion evidence");
  expect(JSON.parse(verify.depends_on)).toEqual([fixes[0].id]);
  expect(JSON.parse(evidence.depends_on)).toEqual(fixes.map((row) => row.id));
  expect(hasUnfinishedDependencies(db, verify)).toBe(true);
  expect(hasUnfinishedDependencies(db, evidence)).toBe(true);
  for (const row of rows.filter((row) => row !== verify && row !== evidence))
    expect(hasUnfinishedDependencies(db, row)).toBe(false);
  // A reported subtask completion alone does not prove implementation integration.
  db.prepare("UPDATE subtasks SET status = 'done' WHERE id = ?").run(fixes[0].id);
  expect(hasUnfinishedDependencies(db, verify)).toBe(true);
  db.exec("INSERT INTO tasks (id, title, department_id, status) VALUES ('fix84-child', 'Fix #84', 'dev', 'done')");
  db.prepare("UPDATE subtasks SET delegated_task_id = 'fix84-child' WHERE id = ?").run(fixes[0].id);
  expect(hasUnfinishedDependencies(db, verify)).toBe(false);
  expect(hasUnfinishedDependencies(db, evidence)).toBe(true);
});

it("drafts Operations and Development concurrently from Operations-only inference and accepts a valid plan unchanged", async () => {
  const state = setup([JSON.stringify(validGraph)], false, { holdDrafts: true });
  expect([...state.releases.keys()].sort()).toEqual(["developer", "operator"]);
  expect(state.run.mock.calls.some(([agent]) => agent.id === "planner")).toBe(false);
  state.releases.get("operator")!({ text: "Independent test automation setup" });
  await Promise.resolve();
  expect(state.approved).not.toHaveBeenCalled();
  state.releases.get("developer")!({ text: "Two code fixes with regression tests and separate branches" });
  await vi.waitFor(() => expect(state.approved).toHaveBeenCalledTimes(1));
  expect(JSON.parse(state.approved.mock.calls[0][0][0])).toEqual(validGraph);
  expect(state.run.mock.calls.filter(([agent]) => agent.id === "planner")).toHaveLength(1);
  expect(state.logs.mock.calls.some((call) => String(call[2]).includes("repaired"))).toBe(false);
});

it.each(["unknown-department", "cycle", "dangling-key", "no-tests"])(
  "keeps an unsafe %s graph unaccepted after repair with actionable feedback",
  async (failure) => {
    const graph = structuredClone(validGraph.plan_items);
    if (failure === "unknown-department") graph[0].department_id = "missing_department";
    if (failure === "no-tests") graph[0].description = "Change production code without tests on a separate branch";
    if (failure === "dangling-key") graph[0].depends_on = ["missing_owner"];
    if (failure === "cycle") {
      graph[0].depends_on = ["verify"];
      graph.push({ key: "verify", title: "Verify completed fix #84", department_id: "operations", depends_on: [] });
    }
    const output = JSON.stringify({ plan_items: graph });
    const state = setup([output, output]);
    await vi.waitFor(() => expect(state.finish).toHaveBeenCalledWith("meeting", "failed"));
    expect(state.approved).not.toHaveBeenCalled();
    expect(state.run.mock.calls.filter(([agent]) => agent.id === "planner")).toHaveLength(2);
    expect(state.notify.mock.calls.at(-1)?.[0]).toMatch(
      {
        "unknown-department": /missing_department.*fix84/,
        cycle: /cycle.*fix84.*verify/,
        "dangling-key": /fix84.*missing_owner/,
        "no-tests": /fix84.*regression tests/,
      }[failure]!,
    );
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "planned" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM subtasks").get()).toEqual({ n: 0 });
  },
);

it("passes a non-code plan unchanged without requiring Development", async () => {
  const graph = {
    plan_items: [{ key: "docs", title: "Write API documentation", department_id: "planning", depends_on: [] }],
  };
  const state = setup([JSON.stringify(graph)], false, { description: "[CEO] Write API documentation" });
  await vi.waitFor(() => expect(state.approved).toHaveBeenCalledTimes(1));
  expect(JSON.parse(state.approved.mock.calls[0][0][0])).toEqual(graph);
  expect(state.run.mock.calls.map(([agent]) => agent.id)).toEqual(["operator", "planner"]);
  seedingTools().seedApprovedPlanSubtasks("root", "planning", state.approved.mock.calls[0][0]);
  expect(db.prepare("SELECT target_department_id, assigned_agent_id FROM subtasks").all()).toEqual([
    { target_department_id: "planning", assigned_agent_id: "planner" },
  ]);
});
