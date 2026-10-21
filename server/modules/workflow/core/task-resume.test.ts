import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { recoverReadyRoot, resumeTaskExecution, sweepReadyRoots } from "./task-resume.ts";

let db: DatabaseSync;
afterEach(() => db?.close());
function fixture() {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`INSERT INTO agents (id,name,role,cli_provider,status) VALUES ('owner','Owner','senior','codex','idle');
    INSERT INTO tasks (id,title,status,assigned_agent_id,updated_at) VALUES ('root','Root','pending','owner',1);
    INSERT INTO subtasks (id,task_id,title,status) VALUES ('revision','root','[Review Revision] Apply feedback','done');`);
  const deps = {
    db,
    activeProcesses: new Map(),
    stopRequestedTasks: new Set(),
    reviewInFlight: new Set(),
    nowMs: () => 100_000,
    getDeptName: () => "Development",
    broadcast: vi.fn(),
    appendTaskLog: (id: string, kind: string, message: string) =>
      db
        .prepare("INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?,?,?,?)")
        .run(id, kind, message, 100_000),
    startTaskExecutionForAgent: vi.fn((id: string) =>
      db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(id),
    ),
    finishReview: vi.fn(),
    startPlannedApprovalMeeting: vi.fn(),
    seedApprovedPlanSubtasks: vi.fn(),
    processSubtaskDelegations: vi.fn(),
  };
  return deps;
}
describe("persistent root recovery", () => {
  it("reconstructs a ready revision root after all runtime callbacks are lost", () => {
    const beforeRestart = fixture();
    const afterRestart = {
      ...beforeRestart,
      activeProcesses: new Map(),
      reviewInFlight: new Set(),
      stopRequestedTasks: new Set(),
    };
    sweepReadyRoots(afterRestart);
    expect(afterRestart.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "in_progress" });
    expect(db.prepare("SELECT message FROM task_logs WHERE task_id = 'root'").get()).toEqual({
      message: expect.stringContaining("all revision subtasks completed or cancelled"),
    });
    sweepReadyRoots(afterRestart);
    expect(afterRestart.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });
  it.each(["pending", "blocked"])("waits for %s revision work", (status) => {
    const deps = fixture();
    db.prepare("UPDATE subtasks SET status = ?").run(status);
    expect(recoverReadyRoot(deps, "root", "completion")).toBe(false);
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });
  it("allows cancelled revisions but waits for completed child integration", () => {
    const deps = fixture();
    db.exec(
      "INSERT INTO tasks (id,title,status) VALUES ('child','Child','review'); UPDATE subtasks SET delegated_task_id = 'child';",
    );
    expect(recoverReadyRoot(deps, "root", "completion")).toBe(false);
    db.exec("UPDATE subtasks SET status = 'cancelled';");
    expect(recoverReadyRoot(deps, "root", "completion")).toBe(true);
  });
  it("preserves explicit pause across restart", () => {
    const deps = fixture();
    deps.appendTaskLog("root", "system", "PAUSE_BREAK: explicit pause");
    sweepReadyRoots(deps);
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });
  it("waits for the assigned agent and never steals its other task", () => {
    const deps = fixture();
    db.exec("UPDATE agents SET status = 'working', current_task_id = 'other';");
    expect(resumeTaskExecution(deps, "root", "test")).toBe(false);
  });
  it("restarts a planned meeting through planning rather than executing early", () => {
    const deps = fixture();
    db.exec("UPDATE tasks SET status = 'planned'; DELETE FROM subtasks;");
    sweepReadyRoots(deps);
    expect(deps.startPlannedApprovalMeeting).toHaveBeenCalledOnce();
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    const callback = deps.startPlannedApprovalMeeting.mock.calls[0][3] as unknown as (notes: string[]) => void;
    callback([]);
    expect(deps.seedApprovedPlanSubtasks).toHaveBeenCalledOnce();
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });
  it("reserves the planner before awaiting a recovered meeting", () => {
    const deps = fixture();
    db.exec(
      "UPDATE tasks SET status = 'planned'; DELETE FROM subtasks; INSERT INTO tasks (id,title,status,assigned_agent_id,updated_at) VALUES ('second','Second','planned','owner',2)",
    );
    sweepReadyRoots(deps);
    expect(deps.startPlannedApprovalMeeting).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT current_task_id FROM agents WHERE id = 'owner'").get()).toEqual({
      current_task_id: "root",
    });
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });
  it("recovers review via the existing gate without bypass options", () => {
    const deps = fixture();
    db.exec("UPDATE tasks SET status = 'review';");
    sweepReadyRoots(deps);
    expect(deps.finishReview).toHaveBeenCalledWith("root", "Root", { trigger: "recovery_sweep" });
  });
});
