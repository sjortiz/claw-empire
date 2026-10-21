import { holdRecoveryDuringShutdown } from "../workflow/core/task-recovery-control.ts";
import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket as WsSocket, WebSocketServer } from "ws";

interface RegisterGracefulShutdownHandlersOptions {
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  killPidTree: (pid: number) => void;
  rollbackTaskWorktree: (taskId: string, reason: string) => void;
  db: DatabaseSync;
  nowMs: () => number;
  endTaskExecutionSession: (taskId: string, reason: string) => void;
  wsClients: Set<WsSocket>;
  wss: WebSocketServer;
  server: { close: (callback: () => void) => void };
  onBeforeClose?: () => void;
}

export function registerGracefulShutdownHandlers({
  activeProcesses,
  stopRequestedTasks,
  killPidTree,
  db,
  nowMs,
  wsClients,
  wss,
  server,
  onBeforeClose,
}: RegisterGracefulShutdownHandlersOptions): void {
  let shuttingDown = false;
  function gracefulShutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    holdRecoveryDuringShutdown(activeProcesses);
    console.log(`\n[Claw-Empire] ${signal} received. Shutting down gracefully...`);

    try {
      onBeforeClose?.();
    } catch {
      // ignore pre-close cleanup failures
    }

    for (const [taskId, child] of activeProcesses) {
      console.log(`[Claw-Empire] Stopping process for task ${taskId} (pid: ${child.pid})`);
      stopRequestedTasks.add(taskId);
      if (child.pid && child.pid < 0) {
        child.kill();
      } else if (child.pid) {
        killPidTree(child.pid);
      }
      activeProcesses.delete(taskId);

      // Server shutdown interrupts a run; it is not a CEO cancellation.
      // Preserve both the worktree and execution session for startup recovery.

      const task = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
        | {
            assigned_agent_id: string | null;
          }
        | undefined;
      if (task?.assigned_agent_id) {
        db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ? AND current_task_id = ?",
        ).run(task.assigned_agent_id, taskId);
      }
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ? AND status = 'in_progress'").run(nowMs(), taskId);
    }

    for (const ws of wsClients) {
      ws.close(1001, "Server shutting down");
    }
    wsClients.clear();

    wss.close(() => {
      server.close(() => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        console.log("[Claw-Empire] Shutdown complete.");
        process.exit(0);
      });
    });

    setTimeout(() => {
      console.error("[Claw-Empire] Forced exit after timeout.");
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  process.once("SIGUSR2", () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.kill(process.pid, "SIGUSR2");
  });
}
