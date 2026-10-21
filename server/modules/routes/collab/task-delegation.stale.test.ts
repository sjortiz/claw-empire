import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { createTaskDelegationHandler } from "./task-delegation.ts";

let db: DatabaseSync;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db?.close();
});

function fixture(waitFor: "planning" | "execution") {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', 'Planning', 'P', '#000');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status, current_task_id)
      VALUES ('planner', 'Planner', 'planning', 'team_leader', 'codex', '${waitFor === "planning" ? "working" : "idle"}', '${waitFor === "planning" ? "other" : ""}');
  `);
  const planner = db.prepare("SELECT * FROM agents WHERE id = 'planner'").get() as any;
  const start = vi.fn();
  const meeting = vi.fn((_id: string, _title: string, _dept: string, done: (notes: string[]) => void) => {
    db.exec("UPDATE agents SET status = 'working', current_task_id = 'other' WHERE id = 'planner'");
    done([]);
  });
  const handler = createTaskDelegationHandler({
    db,
    nowMs: Date.now,
    resolveLang: () => "en",
    getDeptName: (id: string) => id,
    getRoleLabel: (role: string) => role,
    detectTargetDepartments: () => [],
    normalizeTextField: () => null,
    resolveProjectFromOptions: () => ({ id: null, name: null, projectPath: null, coreGoal: null }),
    buildRoundGoal: (_goal: unknown, message: string) => message,
    resolveDirectiveProjectPath: () => ({ projectPath: "/workspace/project", source: "explicit" }),
    recordTaskCreationAudit: vi.fn(),
    appendTaskLog: (taskId: string, kind: string, message: string) => {
      db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
        taskId,
        kind,
        message,
        Date.now(),
      );
    },
    broadcast: vi.fn(),
    l: (_ko: string[], en: string[]) => ({ en }),
    pickL: (pool: { en: string[] }) => pool.en[0],
    notifyCeo: vi.fn(),
    // The runtime's interruption predicate permits in_progress and review, so
    // the callback must check ownership of the planned transition itself.
    isTaskWorkflowInterrupted: () => false,
    hasOpenForeignSubtasks: () => false,
    processSubtaskDelegations: vi.fn(),
    seedApprovedPlanSubtasks: vi.fn(),
    startPlannedApprovalMeeting: meeting,
    sendAgentMessage: vi.fn(),
    registerTaskMessengerRoute: vi.fn(),
    startTaskExecutionForAgent: start,
  } as any);
  handler(planner, "Directive", "");
  vi.advanceTimersByTime(1_000);
  return { start, meeting };
}

describe("stale directive callbacks", () => {
  it.each(["in_progress", "review"])("stops an old planning wait after recovery moved the root to %s", (status) => {
    const { start, meeting } = fixture("planning");
    expect(vi.getTimerCount()).toBe(1);
    db.prepare("UPDATE tasks SET status = ?").run(status);
    db.exec("UPDATE agents SET status = 'idle', current_task_id = NULL");
    vi.advanceTimersByTime(5_000);
    expect(meeting).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["in_progress", "review"])("stops an old execution wait after recovery moved the root to %s", (status) => {
    const { start, meeting } = fixture("execution");
    expect(meeting).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    db.prepare("UPDATE tasks SET status = ?").run(status);
    db.exec("UPDATE agents SET status = 'idle', current_task_id = NULL");
    vi.advanceTimersByTime(5_000);
    expect(meeting).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
