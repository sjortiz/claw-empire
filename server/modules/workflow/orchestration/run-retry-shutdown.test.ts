import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { coordinationLocalizers, createCoordinationDb } from "../../../test/agent-coordination-fixture.ts";
import { initializeWorkflowPartC } from "../orchestration.ts";

const { startTaskExecutionForAgent } = vi.hoisted(() => ({ startTaskExecutionForAgent: vi.fn() }));
vi.mock("./execution-start-task.ts", () => ({
  createExecutionStartTaskTools: () => ({ startTaskExecutionForAgent }),
}));

describe("retry shutdown coordination", () => {
  it("keeps a queued retry held when its owner becomes available during shutdown", () => {
    vi.useFakeTimers();
    startTaskExecutionForAgent.mockClear();
    const db = createCoordinationDb();
    const worktreePath = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "retry-shutdown-"));
    try {
      db.exec(`
        ALTER TABLE subtasks ADD COLUMN target_department_id TEXT;
        UPDATE agents SET status = 'working', current_task_id = 'target' WHERE id = 'alpha';
        UPDATE tasks SET status = 'review' WHERE id = 'target';
      `);
      const ctx = {
        ...coordinationLocalizers,
        db,
        nowMs: () => Date.now(),
        logsDir: worktreePath,
        appendTaskLog: (taskId: string, kind: string, message: string) => {
          db.prepare("INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?,?,?,?)").run(
            taskId,
            kind,
            message,
            Date.now(),
          );
        },
        activeProcesses: new Map(),
        stopRequestedTasks: new Set(),
        stopRequestModeByTask: new Map(),
        codexThreadToSubtask: new Map(),
        taskWorktrees: new Map([["source", { worktreePath, projectPath: worktreePath }]]),
        broadcast: vi.fn(),
        getDeptName: () => "Development",
        shuttingDown: false,
      };
      const workflow = initializeWorkflowPartC(ctx as unknown as RuntimeContext);
      workflow.handleTaskRunComplete("source", 1);
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'source'").get()).toEqual({ status: "planned" });
      expect(db.prepare("SELECT 1 FROM task_logs WHERE message LIKE 'Workflow wait root-owner:%'").get()).toBeTruthy();
      expect(startTaskExecutionForAgent).not.toHaveBeenCalled();

      // The lifecycle mutates the runtime context after the handler and its
      // persistent wait were created. A delayed meeting close can free the owner.
      ctx.shuttingDown = true;
      db.exec("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = 'alpha'");
      vi.advanceTimersByTime(5_000);

      expect(startTaskExecutionForAgent).not.toHaveBeenCalled();
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'source'").get()).toEqual({ status: "planned" });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      db.close();
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
