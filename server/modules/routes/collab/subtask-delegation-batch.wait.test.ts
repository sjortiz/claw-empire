import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { DEFAULT_WORKFLOW_WAIT_LIMIT_MS, sweepExpiredWorkflowWaits } from "../../workflow/core/persistent-wait.ts";
import { createSubtaskDelegationBatch } from "./subtask-delegation-batch.ts";
import { pickAvailableDepartmentAgent } from "./available-department-agent.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("department agent availability", () => {
  it("logs a department wait once and stops with CEO attention after the durable limit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const db = new DatabaseSync(":memory:");
    try {
      applyBaseSchema(db);
      applyTaskSchemaMigrations(db);
      db.exec(`
        INSERT INTO tasks (id, title, status) VALUES ('root', 'Directive', 'collaborating');
        INSERT INTO subtasks (id, task_id, title, status, target_department_id) VALUES ('revision', 'root', 'Fix code', 'pending', 'dev');
      `);
      const appendTaskLog = vi.fn((taskId, kind, message) => {
        db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
          taskId,
          kind,
          message,
          Date.now(),
        );
      });
      const notifyCeo = vi.fn();
      const { delegateSubtaskBatch } = createSubtaskDelegationBatch({
        db,
        nowMs: Date.now,
        appendTaskLog,
        notifyCeo,
        resolveLang: () => "en",
        l: (_ko: string[], en: string[]) => ({ en }),
        pickL: (pool: { en: string[] }) => pool.en[0],
        getDeptName: () => "Development",
        findTeamLeader: () => null,
        broadcast: vi.fn(),
      } as any);
      const subtasks = db.prepare("SELECT * FROM subtasks WHERE task_id = 'root'").all() as any;
      delegateSubtaskBatch(subtasks, 0, 1, {
        id: "root",
        title: "Directive",
        description: null,
        project_id: null,
        project_path: null,
        department_id: "planning",
      });
      expect(appendTaskLog).toHaveBeenCalledTimes(1);
      expect(appendTaskLog).toHaveBeenCalledWith(
        "root",
        "system",
        expect.stringContaining(
          "Department assignment blocked (dev): Waiting for an eligible Development implementation agent",
        ),
      );
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(DEFAULT_WORKFLOW_WAIT_LIMIT_MS - 1);
      expect(appendTaskLog).toHaveBeenCalledTimes(1);
      expect(notifyCeo).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(notifyCeo).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "pending" });
      expect(db.prepare("SELECT status FROM subtasks WHERE id = 'revision'").get()).toEqual({ status: "blocked" });
      expect(appendTaskLog.mock.calls.filter((call) => call[2].includes('"state":"waiting"'))).toHaveLength(1);
      vi.advanceTimersByTime(DEFAULT_WORKFLOW_WAIT_LIMIT_MS);
      expect(notifyCeo).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it.each(["dispatch", "acknowledgement", "expired retry"])(
    "does not launch a held department batch at %s and releases its reservation",
    (heldAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      vi.spyOn(Math, "random").mockReturnValue(0);
      const db = new DatabaseSync(":memory:");
      try {
        applyBaseSchema(db);
        applyTaskSchemaMigrations(db);
        db.exec(`
        INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('dev', 'Development', 'Development', 'D', '#000');
        INSERT INTO agents (id, name, name_ko, department_id, role, cli_provider, status, current_task_id)
          VALUES ('dev-leader', 'Lead', 'Lead', 'dev', 'team_leader', 'codex', 'working', 'other');
        INSERT INTO tasks (id, title, status) VALUES ('root', 'Directive', 'collaborating');
        INSERT INTO subtasks (id, task_id, title, status, target_department_id) VALUES ('revision', 'root', 'Fix code', 'pending', 'dev');
      `);
        const appendTaskLog = (taskId: string, kind: string, message: string) => {
          db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
            taskId,
            kind,
            message,
            Date.now(),
          );
        };
        const notifyCeo = vi.fn();
        const onBatchDone = vi.fn();
        const startTaskExecution = vi.fn();
        const deps = {
          db,
          nowMs: Date.now,
          appendTaskLog,
          notifyCeo,
          resolveLang: () => "en",
          getDeptName: () => "Development",
          getAgentDisplayName: (agent: any) => agent.name,
          l: (_ko: string[], en: string[]) => ({ en }),
          pickL: (pool: { en: string[] }) => pool.en[0],
          findTeamLeader: (dept: string) =>
            dept === "dev" ? db.prepare("SELECT * FROM agents WHERE id = 'dev-leader'").get() : null,
          findBestSubordinate: () => null,
          broadcast: vi.fn(),
          spawnCliAgent: startTaskExecution,
        };
        const { delegateSubtaskBatch } = createSubtaskDelegationBatch(deps as any);
        const subtasks = db.prepare("SELECT * FROM subtasks WHERE task_id = 'root'").all() as any;
        const pause = () => appendTaskLog("root", "system", "PAUSE_BREAK: explicit pause");
        if (heldAt === "dispatch") pause();
        delegateSubtaskBatch(
          subtasks,
          0,
          1,
          {
            id: "root",
            title: "Directive",
            description: null,
            project_id: null,
            project_path: null,
            department_id: "planning",
          },
          onBatchDone,
        );
        if (heldAt === "acknowledgement") pause();
        if (heldAt === "expired retry") {
          vi.advanceTimersByTime(1_500);
          expect(onBatchDone).not.toHaveBeenCalled();
          vi.setSystemTime(Date.now() + DEFAULT_WORKFLOW_WAIT_LIMIT_MS);
          sweepExpiredWorkflowWaits(deps);
          db.exec("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = 'dev-leader'");
        }
        vi.advanceTimersByTime(10_000);
        expect(onBatchDone).toHaveBeenCalledTimes(1);
        expect(startTaskExecution).not.toHaveBeenCalled();
        expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE source_task_id = 'root'").get()).toEqual({
          count: 0,
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        db.close();
      }
    },
  );

  it("uses another free eligible department agent when the preferred subordinate is reserved", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyBaseSchema(db);
      applyTaskSchemaMigrations(db);
      db.exec(`
        INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('dev', 'Development', 'Development', 'D', '#000');
        INSERT INTO agents (id, name, name_ko, department_id, role, cli_provider, status, current_task_id) VALUES
          ('reserved', 'Reserved', 'Reserved', 'dev', 'senior', 'codex', 'idle', 'other-task'),
          ('free', 'Free', 'Free', 'dev', 'junior', 'codex', 'idle', NULL),
          ('outside', 'Outside', 'Outside', 'dev', 'senior', 'codex', 'idle', NULL);
      `);
      expect(pickAvailableDepartmentAgent(db, "dev", ["reserved", "free"])?.id).toBe("free");
      expect(pickAvailableDepartmentAgent(db, "dev", ["reserved"])).toBeNull();
      expect(pickAvailableDepartmentAgent(db, "dev", [])).toBeNull();
    } finally {
      db.close();
    }
  });
});
