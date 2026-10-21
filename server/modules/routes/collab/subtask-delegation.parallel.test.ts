import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { initializeSubtaskDelegation } from "./subtask-delegation.ts";

const { delegateBatch, captureBatchDeps } = vi.hoisted(() => ({ delegateBatch: vi.fn(), captureBatchDeps: vi.fn() }));
vi.mock("./subtask-delegation-batch.ts", () => ({
  createSubtaskDelegationBatch: (deps: any) => {
    captureBatchDeps(deps);
    return { delegateSubtaskBatch: delegateBatch };
  },
}));

let db: DatabaseSync;
const resumeRoot = vi.fn();
beforeEach(() => {
  delegateBatch.mockReset();
  captureBatchDeps.mockReset();
  resumeRoot.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  db?.close();
});
function fixture(extra: Record<string, any> = {}) {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO tasks (id, title, department_id, status) VALUES ('root', 'Root', NULL, 'in_progress');
    INSERT INTO subtasks (id, task_id, title, target_department_id, status) VALUES
      ('own', 'root', 'Origin work', NULL, 'pending'),
      ('dev', 'root', 'Develop', 'dev', 'pending'),
      ('qa', 'root', 'Check independent item', 'qa', 'pending');
  `);
  return initializeSubtaskDelegation({
    db,
    l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
    pickL: (pool: { en: string[] }) => pool.en[0],
    resolveLang: () => "en",
    getDeptName: (id: string) => id,
    notifyCeo: vi.fn(),
    appendTaskLog: vi.fn(),
    broadcast: vi.fn(),
    subtaskDelegationDispatchInFlight: new Set(),
    subtaskDelegationCompletionNoticeSent: new Set(),
    activeProcesses: new Map(),
    nowMs: () => 10,
    startTaskExecutionForAgent: resumeRoot,
    ...extra,
  } as any);
}

describe("parallel department delegation", () => {
  it("keeps the parent subtask in progress while a failed child is queued for its automatic retry", () => {
    const linked = new Map([["child", "dev"]]);
    fixture({
      stopRequestedTasks: new Set(),
      stopRequestModeByTask: new Map(),
      delegatedTaskToSubtask: linked,
      handleTaskRunComplete: (id: string) => db.prepare("UPDATE tasks SET status = 'planned' WHERE id = ?").run(id),
    });
    db.exec(
      "INSERT INTO tasks (id,title,status,source_task_id) VALUES ('child','Child','in_progress','root'); UPDATE subtasks SET status = 'in_progress', delegated_task_id = 'child' WHERE id = 'dev'",
    );
    captureBatchDeps.mock.calls[0][0].finalizeDelegatedSubtasks("child", ["dev"], 1);
    expect(db.prepare("SELECT status,blocked_reason,delegated_task_id FROM subtasks WHERE id = 'dev'").get()).toEqual({
      status: "in_progress",
      blocked_reason: null,
      delegated_task_id: "child",
    });
    expect(linked.get("child")).toBe("dev");
  });
  it("starts independent departments together despite unfinished origin work and avoids duplicate launches", () => {
    const tools = fixture();
    tools.processSubtaskDelegations("root");
    expect(delegateBatch).toHaveBeenCalledTimes(2);
    expect(delegateBatch.mock.calls.map(([rows]) => rows[0].id)).toEqual(["dev", "qa"]);
    tools.processSubtaskDelegations("root");
    expect(delegateBatch).toHaveBeenCalledTimes(2);
  });
  it("releases a declared dependent as soon as its prerequisite integrates, while another department is active", () => {
    const tools = fixture();
    db.prepare("UPDATE subtasks SET depends_on = '[\"own\"]' WHERE id = 'qa'").run();
    tools.processSubtaskDelegations("root");
    expect(delegateBatch).toHaveBeenCalledTimes(1);
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('integrated', 'Integrated prerequisite', 'done')").run();
    db.prepare("UPDATE subtasks SET status = 'done', delegated_task_id = 'integrated' WHERE id = 'own'").run();
    tools.maybeNotifyAllSubtasksComplete("root");
    expect(delegateBatch).toHaveBeenCalledTimes(2);
    expect(delegateBatch.mock.calls[1][0][0].id).toBe("qa");
  });
  it("recovers graph root consolidation after callbacks and polling state are lost", () => {
    const tools = fixture();
    db.exec(`
      INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', '기획', 'P', '#111');
      INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES ('planner', 'Planner', 'planning', 'senior', 'codex', 'idle');
      UPDATE tasks SET status = 'collaborating', assigned_agent_id = 'planner' WHERE id = 'root';
      INSERT INTO tasks (id, title, status) VALUES ('integrated', 'Integrated', 'done');
      UPDATE subtasks SET status = 'done', delegated_task_id = 'integrated';
      INSERT INTO task_logs (task_id, kind, message) VALUES ('root', 'system', 'Planned graph seeded 3 subtasks with explicit dependencies');
    `);
    tools.maybeNotifyAllSubtasksComplete("root");
    expect(resumeRoot).toHaveBeenCalledTimes(1);
    expect(resumeRoot.mock.calls[0][0]).toBe("root");
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "planned" });
    // A retained original poll sees the claimed status and cannot start twice.
  });

  it("resumes a pending root immediately when the last revision completes", () => {
    const tools = fixture();
    db.exec(`INSERT INTO agents (id,name,role,cli_provider,status) VALUES ('owner','Owner','senior','codex','idle');
      UPDATE tasks SET status = 'pending', assigned_agent_id = 'owner' WHERE id = 'root';
      UPDATE subtasks SET title = '[Review Revision] Apply feedback', status = 'done';
      UPDATE subtasks SET status = 'pending' WHERE id = 'qa';`);
    tools.maybeNotifyAllSubtasksComplete("root");
    expect(resumeRoot).not.toHaveBeenCalled();
    db.exec("UPDATE subtasks SET status = 'cancelled' WHERE id = 'qa'");
    tools.maybeNotifyAllSubtasksComplete("root");
    expect(resumeRoot).toHaveBeenCalledOnce();
  });

  it("keeps final render deferred and does not restart inactive tasks", () => {
    const tools = fixture();
    db.prepare("UPDATE subtasks SET title = '[VIDEO_FINAL_RENDER]' WHERE id = 'qa'").run();
    tools.processSubtaskDelegations("root");
    expect(delegateBatch).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'root'").run();
    tools.processSubtaskDelegations("root", { includeRender: true });
    expect(delegateBatch).toHaveBeenCalledTimes(1);
  });
});
