import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { createSubtaskDelegationBatch } from "./subtask-delegation-batch.ts";
import { createSubtaskRoutingTools } from "../../workflow/agents/subtask-routing.ts";
import { selectAutoAssignableAgentForTask } from "../core/tasks/execution-run-auto-assign.ts";
import { nexoDirective, nexoImplementation } from "../../../test/implementation-planning-fixture.ts";
import { registerTaskRunRoute } from "../core/tasks/execution-run.ts";

vi.mock("../../workflow/core/agent-coordination.ts", () => ({ buildAgentCoordinationContext: () => "" }));

let db: DatabaseSync;
beforeEach(() => {
  vi.useFakeTimers();
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES
      ('dev', 'Development', '개발', 'D', '#111'), ('planning', 'Planning', '기획', 'P', '#222');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES
      ('planner', 'Planner', 'planning', 'team_leader', 'codex', 'idle'),
      ('lead', 'Dev Lead', 'dev', 'team_leader', 'codex', 'working'),
      ('developer', 'Developer', 'dev', 'senior', 'codex', 'idle');
    INSERT INTO projects (id, name, project_path, core_goal) VALUES ('project', 'Nexo', '/project', 'Fix issues');
    INSERT INTO tasks (id, title, description, department_id, project_id, project_path, status)
      VALUES ('root', 'Fix Nexo #84 and #85', 'Fix code and add tests, one branch per issue', 'planning', 'project', '/project', 'collaborating');
    INSERT INTO subtasks (id, task_id, title, description, target_department_id, assigned_agent_id, status) VALUES
      ('issue84', 'root', 'Fix #84 in code', 'Implement bug fix and regression tests', 'dev', 'lead', 'pending'),
      ('issue85', 'root', 'Fix #85 in code', 'Implement second fix and regression tests', 'dev', 'lead', 'pending');
    INSERT INTO task_logs (task_id, kind, message) VALUES ('root', 'system', 'Planned graph seeded 2 subtasks with explicit dependencies');
  `);
  db.prepare("UPDATE tasks SET description = ? WHERE id = 'root'").run(`[CEO] ${nexoDirective}`);
  for (const issue of [84, 85]) {
    const implementation = nexoImplementation(issue);
    db.prepare("UPDATE subtasks SET title = ?, description = ? WHERE id = ?").run(
      implementation.title,
      implementation.description!,
      `issue${issue}`,
    );
  }
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  db.close();
});

function fixture() {
  const spawn = vi.fn((_taskId: string, _provider?: string, _prompt?: string) => ({ on: vi.fn() }));
  const prompt = vi.fn((_parent: unknown, subtasks: Array<{ title: string; description: string }>) =>
    subtasks.map((subtask) => `${subtask.title}: ${subtask.description}`).join("\n"),
  );
  const logs = vi.fn();
  const done = vi.fn();
  const tools = createSubtaskDelegationBatch({
    db,
    l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
    pickL: (pool: { en: string[] }) => pool.en[0],
    resolveLang: () => "en",
    getDeptName: (id: string) => id,
    getAgentDisplayName: (agent: { name: string }) => agent.name,
    findTeamLeader: (dept: string) =>
      db.prepare("SELECT * FROM agents WHERE department_id = ? AND role = 'team_leader'").get(dept) ?? null,
    findBestSubordinate: (dept: string, excluded: string) =>
      db
        .prepare("SELECT * FROM agents WHERE department_id = ? AND id != ? AND role != 'team_leader'")
        .get(dept, excluded) ?? null,
    nowMs: () => 100,
    broadcast: vi.fn(),
    notifyCeo: vi.fn(),
    sendAgentMessage: vi.fn(),
    appendTaskLog: logs,
    recordTaskCreationAudit: vi.fn(),
    resolveProjectPath: () => "/project",
    createWorktree: () => "/worktree",
    logsDir: "/logs",
    ensureTaskExecutionSession: (taskId: string, agentId: string, provider: string) => ({
      sessionId: taskId,
      agentId,
      provider,
    }),
    ensureClaudeMd: vi.fn(),
    getProviderModelConfig: () => ({}),
    spawnCliAgent: spawn,
    startProgressTimer: vi.fn(),
    subtaskDelegationCallbacks: new Map(),
    delegatedTaskToSubtask: new Map(),
    finalizeDelegatedSubtasks: vi.fn(),
    maybeNotifyAllSubtasksComplete: vi.fn(),
    buildSubtaskDelegationPrompt: prompt,
  } as any);
  const launch = () =>
    tools.delegateSubtaskBatch(
      db.prepare("SELECT * FROM subtasks WHERE task_id = 'root' ORDER BY id").all() as any,
      0,
      1,
      db.prepare("SELECT * FROM tasks WHERE id = 'root'").get() as any,
      done,
    );
  return { launch, spawn, logs, done, prompt };
}
function makeChild() {
  db.exec(`INSERT INTO tasks (id, title, department_id, project_id, status, source_task_id)
    VALUES ('child', 'Fix #84', 'dev', 'project', 'pending', 'root');
    UPDATE subtasks SET delegated_task_id = 'child' WHERE id = 'issue84';`);
}

describe("Development implementation ownership", () => {
  it("persists Development ownership in both child tasks and actual execution assignments", async () => {
    const { launch, spawn, prompt } = fixture();
    launch();
    await vi.advanceTimersByTimeAsync(2500);
    const child = db
      .prepare(
        "SELECT id, description, department_id, assigned_agent_id, status FROM tasks WHERE source_task_id = 'root'",
      )
      .get() as any;
    expect(child).toMatchObject({ department_id: "dev", assigned_agent_id: "developer", status: "in_progress" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe(child.id);
    for (const issue of [84, 85]) {
      expect(child.description).toContain(`Fix Nexo #${issue}`);
      expect(child.description).toContain(nexoImplementation(issue).description);
      expect(spawn.mock.calls[0]?.[2]).toContain(nexoImplementation(issue).description);
    }
    expect(prompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ target_department_id: "dev", title: "Fix Nexo #84" }),
        expect.objectContaining({ target_department_id: "dev", title: "Fix Nexo #85" }),
      ]),
      expect.objectContaining({ id: "developer", department_id: "dev" }),
      "dev",
      "dev",
    );
    expect(
      db
        .prepare("SELECT target_department_id, assigned_agent_id, delegated_task_id, status FROM subtasks ORDER BY id")
        .all(),
    ).toEqual([
      {
        target_department_id: "dev",
        assigned_agent_id: "developer",
        delegated_task_id: child.id,
        status: "in_progress",
      },
      {
        target_department_id: "dev",
        assigned_agent_id: "developer",
        delegated_task_id: child.id,
        status: "in_progress",
      },
    ]);
  });

  it.each(["busy", "offline", "missing-provider", "out-of-scope", "empty-scope"])(
    "keeps implementation blocked with explicit assignment evidence when Development is %s",
    async (scenario) => {
      if (scenario === "busy") db.exec("UPDATE agents SET current_task_id = 'other' WHERE department_id = 'dev'");
      if (scenario === "offline") db.exec("UPDATE agents SET status = 'offline' WHERE department_id = 'dev'");
      if (scenario === "missing-provider") db.exec("UPDATE agents SET cli_provider = NULL WHERE department_id = 'dev'");
      if (scenario === "out-of-scope" || scenario === "empty-scope") {
        db.exec("UPDATE projects SET assignment_mode = 'manual' WHERE id = 'project'");
        if (scenario === "out-of-scope")
          db.exec("INSERT INTO project_agents (project_id, agent_id) VALUES ('project', 'planner')");
      }
      const { launch, spawn, logs, done } = fixture();
      launch();
      await vi.advanceTimersByTimeAsync(2500);
      expect(spawn).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
      expect(db.prepare("SELECT id FROM tasks WHERE source_task_id = 'root'").all()).toEqual([]);
      for (const row of db
        .prepare("SELECT status, target_department_id, assigned_agent_id, blocked_reason FROM subtasks")
        .all() as any[]) {
        expect(row).toMatchObject({ status: "blocked", target_department_id: "dev", assigned_agent_id: null });
        expect(row.blocked_reason).toContain("eligible Development implementation agent");
      }
      expect(logs).toHaveBeenCalledWith(
        "root",
        "system",
        expect.stringContaining("Department assignment blocked (dev)"),
      );
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "collaborating" });
    },
  );

  it("does not require a team leader when an eligible developer can implement the work", async () => {
    db.exec("UPDATE subtasks SET assigned_agent_id = NULL; DELETE FROM agents WHERE id = 'lead'");
    const { launch, spawn } = fixture();
    launch();
    await vi.advanceTimersByTimeAsync(2500);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT assigned_agent_id FROM tasks WHERE source_task_id = 'root'").get()).toEqual({
      assigned_agent_id: "developer",
    });
  });

  it("rechecks availability at launch and resumes pending implementation when a developer becomes free", async () => {
    const { launch, spawn } = fixture();
    launch();
    db.exec("UPDATE agents SET current_task_id = 'other' WHERE department_id = 'dev'");
    await vi.advanceTimersByTimeAsync(2500);
    expect(spawn).not.toHaveBeenCalled();
    db.exec("UPDATE agents SET current_task_id = NULL WHERE id = 'developer'");
    await vi.advanceTimersByTimeAsync(7500);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status, blocked_reason FROM subtasks WHERE id = 'issue84'").get()).toEqual({
      status: "in_progress",
      blocked_reason: null,
    });
  });

  it.each(["planned", "review"] as const)("preserves accepted graph owners through %s rerouting", async (phase) => {
    const run = vi.fn();
    await createSubtaskRoutingTools({ db, runAgentOneShot: run } as any).rerouteSubtasksByPlanningLeader(
      "root",
      "planning",
      phase,
    );
    expect(run).not.toHaveBeenCalled();
    expect(db.prepare("SELECT DISTINCT target_department_id FROM subtasks").all()).toEqual([
      { target_department_id: "dev" },
    ]);
  });

  it("never auto-assigns an accepted Development child to Planning", () => {
    makeChild();
    db.exec("UPDATE agents SET status = 'offline' WHERE department_id = 'dev'");
    expect(
      selectAutoAssignableAgentForTask(db, {
        id: "child",
        department_id: "dev",
        project_id: "project",
        workflow_pack_key: "development",
      }),
    ).toBeNull();
    db.exec("UPDATE agents SET status = 'idle' WHERE id = 'developer'");
    expect(
      selectAutoAssignableAgentForTask(db, {
        id: "child",
        department_id: "dev",
        project_id: "project",
        workflow_pack_key: "development",
      })?.agent.id,
    ).toBe("developer");
  });

  it("persists an explicit pending assignment when re-running a child assigned to Planning with no developer available", () => {
    makeChild();
    db.exec(
      "UPDATE tasks SET assigned_agent_id = 'planner', department_id = 'planning' WHERE id = 'child'; UPDATE agents SET status = 'offline' WHERE department_id = 'dev'",
    );
    let handler: any;
    const spawn = vi.fn();
    const broadcast = vi.fn();
    registerTaskRunRoute({
      db,
      app: {
        post: (_path: string, callback: any) => {
          handler = callback;
        },
      },
      activeProcesses: new Map(),
      nowMs: () => 200,
      resolveLang: () => "en",
      appendTaskLog: vi.fn(),
      broadcast,
      spawnCliAgent: spawn,
    } as any);
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    handler({ params: { id: "child" }, body: {} }, response);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ error: "implementation_assignment_blocked" }));
    expect(spawn).not.toHaveBeenCalled();
    expect(db.prepare("SELECT department_id, status, assigned_agent_id FROM tasks WHERE id = 'child'").get()).toEqual({
      department_id: "dev",
      status: "pending",
      assigned_agent_id: null,
    });
    expect(
      db.prepare("SELECT target_department_id, status, blocked_reason FROM subtasks WHERE id = 'issue84'").get(),
    ).toMatchObject({
      target_department_id: "dev",
      status: "blocked",
      blocked_reason: expect.stringContaining("eligible Development"),
    });
    expect(broadcast).toHaveBeenCalledWith("task_update", expect.objectContaining({ status: "pending" }));
  });
});
