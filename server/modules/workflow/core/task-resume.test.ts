import { registerTaskExecutionControlRoutes } from "../../routes/core/tasks/execution-control.ts";
import { getCsrfToken } from "../../../security/auth.ts";
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
    notifyCeo: vi.fn(),
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
  it("bounds a recovered owner wait using its persisted deadline and notifies once", () => {
    vi.useFakeTimers();
    try {
      const deps = fixture();
      let now = 100_000;
      deps.nowMs = () => now;
      db.exec("UPDATE tasks SET status = 'planned'; UPDATE agents SET status = 'working', current_task_id = 'other'");
      sweepReadyRoots(deps);
      const logs = db.prepare("SELECT message FROM task_logs").all() as Array<{ message: string }>;
      expect(logs.filter((log) => log.message.includes("Root waiting for assigned agent owner"))).toHaveLength(1);
      vi.clearAllTimers();
      now += 16 * 60_000;
      sweepReadyRoots({ ...deps, activeProcesses: new Map(), reviewInFlight: new Set() });
      expect(deps.notifyCeo).toHaveBeenCalledOnce();
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "pending" });
      sweepReadyRoots(deps);
      expect(deps.notifyCeo).toHaveBeenCalledOnce();
      expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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
  it("retries an attention-marked planning meeting from the task card resume route", () => {
    vi.useFakeTimers();
    try {
      const deps = fixture();
      db.exec(
        "DELETE FROM subtasks; UPDATE tasks SET planning_attention_reason = 'provider unavailable', planning_meeting_failures = 2",
      );
      const routes = new Map<string, (...args: any[]) => any>();
      registerTaskExecutionControlRoutes({
        ...deps,
        app: { post: (path: string, handler: (...args: any[]) => any) => routes.set(path, handler) },
        resolveLang: () => "en",
        taskExecutionSessions: new Map(),
        stopRequestModeByTask: new Map(),
        isTaskWorkflowInterrupted: () => false,
        randomDelay: () => 1,
        l: (_ko: string[], en: string[]) => ({ en }),
        pickL: (pool: { en: string[] }) => pool.en[0],
      } as any);
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      routes.get("/api/tasks/:id/resume")!(
        {
          params: { id: "root" },
          body: {},
          method: "POST",
          header: (name: string) => (name === "x-csrf-token" ? getCsrfToken() : undefined),
        },
        res,
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, status: "planned", auto_resumed: true }),
      );
      expect(
        db.prepare("SELECT planning_attention_reason, planning_meeting_failures FROM tasks WHERE id = 'root'").get(),
      ).toEqual({ planning_attention_reason: null, planning_meeting_failures: 0 });
      vi.runAllTimers();
      expect(deps.startPlannedApprovalMeeting).toHaveBeenCalledOnce();
      expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("restores dependency dispatch on manual graph retry without running root early", () => {
    vi.useFakeTimers();
    try {
      const deps = fixture();
      deps.appendTaskLog("root", "system", "Planned graph seeded 1 subtasks with explicit dependencies");
      db.exec("UPDATE tasks SET status = 'planned'; UPDATE subtasks SET status = 'pending'");
      expect(resumeTaskExecution(deps, "root", "manual retry")).toBe(true);
      expect(deps.processSubtaskDelegations).toHaveBeenCalledWith("root");
      expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "collaborating" });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("preserves a review round waiting for CEO remediation picks", () => {
    const deps = fixture();
    db.exec(
      "UPDATE tasks SET status = 'review'; INSERT INTO meeting_minutes (id,task_id,meeting_type,round,title,status,started_at) VALUES ('meeting','root','review',1,'Review','revision_requested',1)",
    );
    sweepReadyRoots(deps);
    expect(deps.finishReview).not.toHaveBeenCalled();
  });
  it("restores legacy department cooperation with the manual project agent scope", () => {
    const deps = fixture();
    db.exec(
      "UPDATE tasks SET status = 'planned'; DELETE FROM subtasks; UPDATE agents SET acts_as_planning_leader = 1; INSERT INTO projects (id,name,project_path,core_goal,assignment_mode) VALUES ('project','Project','/project','Goal','manual'); INSERT INTO project_agents (project_id,agent_id) VALUES ('project','owner'); UPDATE tasks SET project_id = 'project'",
    );
    const cooperate = vi.fn();
    const recovered = {
      ...deps,
      detectTargetDepartments: () => ["dev"],
      startCrossDeptCooperation: cooperate,
      resolveLang: () => "en",
    };
    sweepReadyRoots(recovered);
    const approved = deps.startPlannedApprovalMeeting.mock.calls[0][3] as unknown as (notes: string[]) => void;
    approved(["Legacy planning action"]);
    expect(cooperate).toHaveBeenCalledWith(
      ["dev"],
      0,
      expect.objectContaining({ taskId: "root", projectCandidateAgentIds: ["owner"] }),
    );
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });
  it("leaves a review held at the project decision gate alone", () => {
    const deps = fixture();
    db.exec("UPDATE tasks SET status = 'review';");
    deps.appendTaskLog(
      "root",
      "system",
      "Review gate: waiting for project-level decision (1/1 active tasks in review)",
    );
    sweepReadyRoots(deps);
    sweepReadyRoots(deps);
    expect(deps.finishReview).not.toHaveBeenCalled();
  });
  it("recovers review via the existing gate without bypass options", () => {
    const deps = fixture();
    db.exec("UPDATE tasks SET status = 'review';");
    sweepReadyRoots(deps);
    expect(deps.finishReview).toHaveBeenCalledWith("root", "Root", { trigger: "recovery_sweep" });
  });
});
