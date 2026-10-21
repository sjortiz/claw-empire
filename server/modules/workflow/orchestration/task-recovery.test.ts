import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { initializeSubtaskDelegation } from "../../routes/collab/subtask-delegation.ts";
import { recoverReadyRoot, resumeTaskExecution, sweepReadyRoots } from "./task-recovery.ts";

let db: DatabaseSync;
let deps: any;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', '기획', 'P', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES ('planner', 'Planner', 'planning', 'senior', 'codex', 'idle');
    INSERT INTO tasks (id, title, description, assigned_agent_id, department_id, status) VALUES ('root', 'Root', '[CEO] Directive', 'planner', 'planning', 'pending');
    INSERT INTO task_logs (task_id, kind, message) VALUES ('root', 'system', 'Decision inbox round1: supplement round opened (review -> pending)');
    INSERT INTO subtasks (id, task_id, title, status, target_department_id) VALUES ('revision', 'root', 'Revision', 'blocked', 'dev');`);
  deps = {
    db,
    notifyCeo: vi.fn(),
    activeProcesses: new Map(),
    reviewInFlight: new Set(),
    nowMs: () => Date.now(),
    appendTaskLog: vi.fn((id, kind, message) =>
      db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, ?, ?)").run(id, kind, message),
    ),
    broadcast: vi.fn(),
    getDeptName: (id: string) => id,
    startTaskExecutionForAgent: vi.fn((id: string) =>
      db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(id),
    ),
    finishReview: vi.fn(),
    startPlannedApprovalMeeting: vi.fn(),
    seedApprovedPlanSubtasks: vi.fn(),
    processSubtaskDelegations: vi.fn(),
  };
});
afterEach(() => db.close());

function finishRevision() {
  db.exec("UPDATE subtasks SET status = 'done' WHERE id = 'revision'");
}

describe("persistent directive recovery", () => {
  it("migrates existing subtask records to allow cancellation without losing prerequisites", () => {
    db.close();
    db = new DatabaseSync(":memory:");
    applyBaseSchema({ exec: (sql: string) => db.exec(sql.replace("'blocked','cancelled'", "'blocked'")) });
    db.exec(`INSERT INTO tasks (id,title) VALUES ('legacy','Legacy');
      INSERT INTO subtasks (id,task_id,title,depends_on) VALUES ('prior','legacy','Prior','[]'), ('next','legacy','Next','["prior"]');`);
    applyTaskSchemaMigrations(db);
    db.exec("UPDATE subtasks SET status='cancelled' WHERE id='prior'");
    applyTaskSchemaMigrations(db);
    expect(db.prepare("SELECT title,depends_on FROM subtasks WHERE id='next'").get()).toEqual({
      title: "Next",
      depends_on: '["prior"]',
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("resumes immediately when the last revision finishes, before completion-notice deduplication", () => {
    const tools = initializeSubtaskDelegation({
      ...deps,
      l: (_ko: string[], en: string[]) => ({ en }),
      pickL: (pool: any) => pool.en[0],
      resolveLang: () => "en",
      subtaskDelegationDispatchInFlight: new Set(),
      subtaskDelegationCompletionNoticeSent: new Set(["root"]),
    } as any);
    expect(recoverReadyRoot(deps, "root", "interval")).toBe(false);
    finishRevision();
    tools.maybeNotifyAllSubtasksComplete("root");
    tools.maybeNotifyAllSubtasksComplete("root");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledTimes(1);
    expect(deps.appendTaskLog).toHaveBeenCalledWith(
      "root",
      "system",
      expect.stringContaining("revision department work completed"),
    );
  });
  it("finds a ready root after all callback state is lost on restart, including cancelled revisions", () => {
    db.exec("UPDATE subtasks SET status = 'cancelled'");
    sweepReadyRoots({ ...deps, activeProcesses: new Map(), reviewInFlight: new Set() }, "startup");
    sweepReadyRoots(deps, "interval");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledTimes(1);
  });
  it("allows the root to perform its own nondelegated consolidation after department work integrates", () => {
    finishRevision();
    db.exec(
      "INSERT INTO subtasks (id, task_id, title, status) VALUES ('local', 'root', '[Review Revision] Consolidate updates and resubmit for review', 'pending')",
    );
    expect(recoverReadyRoot(deps, "root", "completion")).toBe(true);
  });
  it("waits for approval/integration, agent availability, and active processes without duplicate starts", () => {
    db.exec(
      "INSERT INTO tasks (id,title,status) VALUES ('child','Child','review'); UPDATE subtasks SET status='done', delegated_task_id='child'",
    );
    expect(recoverReadyRoot(deps, "root", "interval")).toBe(false);
    db.exec(
      "UPDATE tasks SET status='done' WHERE id='child'; UPDATE agents SET status='working', current_task_id='other'",
    );
    expect(recoverReadyRoot(deps, "root", "interval")).toBe(false);
    db.exec("UPDATE agents SET status='idle', current_task_id=NULL");
    deps.activeProcesses.set("root", {});
    expect(recoverReadyRoot(deps, "root", "interval")).toBe(false);
    deps.activeProcesses.clear();
    expect(recoverReadyRoot(deps, "root", "interval")).toBe(true);
  });
  it("preserves manual pauses across a simulated restart", () => {
    finishRevision();
    db.exec("INSERT INTO task_logs (task_id,kind,message) VALUES ('root','system','PAUSE: explicit CEO pause')");
    sweepReadyRoots(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });
  it("restores orphaned planning, but leaves a live meeting and review decisions alone", () => {
    db.exec("DELETE FROM subtasks; UPDATE tasks SET status='planned'");
    deps.reviewInFlight.add("planned:root");
    expect(recoverReadyRoot(deps, "root", "startup")).toBe(false);
    deps.reviewInFlight.clear();
    expect(recoverReadyRoot(deps, "root", "startup")).toBe(true);
    expect(deps.startPlannedApprovalMeeting).toHaveBeenCalledTimes(1);
    db.exec(
      "UPDATE tasks SET status='review'; INSERT INTO meeting_minutes (id,task_id,meeting_type,round,status,started_at,title) VALUES ('meeting','root','review',1,'revision_requested',1,'Review')",
    );
    expect(recoverReadyRoot(deps, "root", "startup")).toBe(false);
    expect(deps.finishReview).not.toHaveBeenCalled();
  });
  it("keeps failed planning in attention until Resume explicitly retries the meeting", () => {
    db.exec(`DELETE FROM subtasks; UPDATE tasks SET status='pending';
      INSERT INTO meeting_minutes (id,task_id,meeting_type,round,status,started_at,title) VALUES ('failed','root','planned',1,'failed',1,'Planning');
      INSERT INTO task_logs (task_id,kind,message) VALUES ('root','system','Workflow attention required: planning meeting failed');`);
    sweepReadyRoots(deps, "startup");
    expect(deps.startPlannedApprovalMeeting).not.toHaveBeenCalled();
    expect(resumeTaskExecution(deps, "root", "CEO resume requested")).toBe(true);
    expect(deps.startPlannedApprovalMeeting).toHaveBeenCalledOnce();
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });
  it("logs busy root waiting once and escalates after a persistent budget on restart", () => {
    finishRevision();
    db.exec("UPDATE agents SET status='working', current_task_id='other'");
    let time = Date.now();
    deps.nowMs = () => time;
    sweepReadyRoots(deps, "startup");
    sweepReadyRoots(deps, "interval");
    expect(
      deps.appendTaskLog.mock.calls.filter((call: any[]) => String(call[2]).includes("Delegation wait")),
    ).toHaveLength(1);
    time += 10 * 60_000;
    sweepReadyRoots({ ...deps, activeProcesses: new Map() }, "startup");
    expect(deps.notifyCeo).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "pending" });
  });
  it("recovers explicitly resumed children after their busy agent becomes available", () => {
    db.exec(`UPDATE tasks SET source_task_id='parent', status='planned';
      INSERT INTO task_logs (task_id,kind,message) VALUES ('root','system','RESUME: pending → planned');
      UPDATE agents SET status='working',current_task_id='other';`);
    sweepReadyRoots(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    db.exec("UPDATE agents SET status='idle',current_task_id=NULL");
    sweepReadyRoots({ ...deps, activeProcesses: new Map() }, "interval");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });
  it("preserves a recorded CEO skip-meeting decision after restart", () => {
    db.exec(`DELETE FROM subtasks; UPDATE tasks SET status='planned';
      INSERT INTO task_creation_audits (id,task_id,task_title,trigger,trigger_detail,actor_type) VALUES ('audit','root','Root','workflow.delegation.ceo_message','skip_planned_meeting=true; skip_plan_subtasks=true','agent');`);
    sweepReadyRoots(deps, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    expect(deps.startPlannedApprovalMeeting).not.toHaveBeenCalled();
  });
  it("restores collaborating root consolidation only after all graph children integrate", () => {
    db.exec(
      "UPDATE tasks SET status='collaborating'; INSERT INTO tasks (id,title,status) VALUES ('child','Child','review'); UPDATE subtasks SET status='done',delegated_task_id='child'",
    );
    sweepReadyRoots(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    db.exec("UPDATE tasks SET status='done' WHERE id='child'");
    sweepReadyRoots(deps, "interval");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });
});
