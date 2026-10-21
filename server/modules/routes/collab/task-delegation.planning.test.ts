import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { createTaskDelegationHandler } from "./task-delegation.ts";

let db: DatabaseSync;
afterEach(() => {
  db?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("directive planner assignment", () => {
  it("keeps the balanced planner responsible and queues all-busy roots without replacing active reservations", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    applyTaskSchemaMigrations(db);
    db.exec(`
      INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', '기획', 'P', '#111');
      INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES
        ('lead', 'Lead', 'planning', 'team_leader', 'codex', 'idle'),
        ('senior', 'Senior', 'planning', 'senior', 'codex', 'idle');
    `);
    const leader = db.prepare("SELECT * FROM agents WHERE id = 'lead'").get() as any;
    const start = vi.fn((_taskId: string, agent: { id: string }) => {
      db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(agent.id);
    });
    const subordinate = vi.fn();
    const dispatch = vi.fn();
    const graph = JSON.stringify({
      plan_items: [{ key: "work", title: "Own department work", department_id: "planning", depends_on: [] }],
    });
    const handler = createTaskDelegationHandler({
      db,
      nowMs: () => 1,
      resolveLang: () => "en",
      getDeptName: (id: string) => id,
      getRoleLabel: (role: string) => role,
      detectTargetDepartments: () => [],
      findBestSubordinate: subordinate,
      normalizeTextField: (value: unknown) => value || null,
      resolveProjectFromOptions: () => ({ id: null, name: null, projectPath: null, coreGoal: null }),
      buildRoundGoal: (_goal: unknown, message: string) => message,
      resolveDirectiveProjectPath: () => ({ projectPath: "/workspace/project", source: "explicit" }),
      recordTaskCreationAudit: vi.fn(),
      appendTaskLog: vi.fn(),
      broadcast: vi.fn(),
      l: (ko: string[], en: string[]) => ({ ko, en }),
      pickL: (pool: { en: string[] }) => pool.en[0],
      notifyCeo: vi.fn(),
      isTaskWorkflowInterrupted: () => false,
      hasOpenForeignSubtasks: () => false,
      processSubtaskDelegations: dispatch,
      startCrossDeptCooperation: vi.fn(),
      seedApprovedPlanSubtasks: vi.fn((rootId: string, _dept: string, notes: string[]) => {
        if (notes.length === 0) return;
        db.prepare("INSERT INTO tasks (id, title, status) VALUES ('graph-child', 'Graph child', 'review')").run();
        db.prepare(
          "INSERT INTO subtasks (id, task_id, title, status, target_department_id, delegated_task_id) VALUES ('graph-item', ?, 'Origin work', 'done', 'planning', 'graph-child')",
        ).run(rootId);
      }),
      startPlannedApprovalMeeting: (_id: string, title: string, _dept: string, done: (items: string[]) => void) =>
        done(title === "Graph directive" ? [graph] : []),
      sendAgentMessage: vi.fn(),
      registerTaskMessengerRoute: vi.fn(),
      startTaskExecutionForAgent: start,
    } as any);
    handler(leader, "First directive", "");
    handler(leader, "Second directive", "");
    handler(leader, "Third directive", "");
    vi.advanceTimersByTime(1000);
    expect(start.mock.calls.map((call) => call[1].id)).toEqual(["lead", "senior"]);
    expect(subordinate).not.toHaveBeenCalled();
    const leadReservation = db.prepare("SELECT current_task_id FROM agents WHERE id = 'lead'").get() as any;
    expect(leadReservation.current_task_id).toBe(start.mock.calls[0][0]);
    db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = 'lead'").run();
    vi.advanceTimersByTime(5000);
    expect(start).toHaveBeenCalledTimes(3);
    expect(start.mock.calls[2][1].id).toBe("lead");
    db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL").run();
    handler(leader, "Graph directive", "");
    vi.advanceTimersByTime(1000);
    const root = db
      .prepare("SELECT id, status, assigned_agent_id FROM tasks WHERE title = 'Graph directive'")
      .get() as any;
    expect(root.status).toBe("collaborating");
    expect(dispatch).toHaveBeenCalledWith(root.id);
    expect(db.prepare("SELECT current_task_id FROM agents WHERE id = ?").get(root.assigned_agent_id)).toEqual({
      current_task_id: null,
    });
    expect(start).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(start).toHaveBeenCalledTimes(3);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'graph-child'").run();
    vi.advanceTimersByTime(1000);
    expect(start).toHaveBeenCalledTimes(4);
    expect(start.mock.calls[3][0]).toBe(root.id);
  });
});
