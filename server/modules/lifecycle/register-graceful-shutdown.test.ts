import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { registerGracefulShutdownHandlers } from "./register-graceful-shutdown.ts";

// Exercise registered handlers without signalling the Vitest process.
describe("graceful restart continuity", () => {
  it.each(["SIGTERM", "SIGINT", "SIGUSR2"])("keeps runs recoverable on %s", (signal) => {
    vi.useFakeTimers();
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE tasks (id TEXT, status TEXT, assigned_agent_id TEXT);
      CREATE TABLE agents (id TEXT, status TEXT, current_task_id TEXT);
      INSERT INTO tasks VALUES ('task', 'in_progress', 'owner');
      INSERT INTO agents VALUES ('owner', 'working', 'task');`);
    const listeners = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((name: string, callback: () => void) => {
      listeners.set(name, callback);
      return process;
    }) as any);
    vi.spyOn(process, "once").mockImplementation(((name: string, callback: () => void) => {
      listeners.set(name, callback);
      return process;
    }) as any);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.spyOn(db, "close").mockImplementation(() => {});
    const activeProcesses = new Map([["task", { pid: 42 } as ChildProcess]]);
    const stopRequestedTasks = new Set<string>();
    const killPidTree = vi.fn();
    try {
      registerGracefulShutdownHandlers({
        db,
        activeProcesses,
        stopRequestedTasks,
        killPidTree,
        wsClients: new Set(),
        wss: { close: (callback: () => void) => callback() } as any,
        server: { close: (callback: () => void) => callback() },
      });
      listeners.get(signal)!();
      expect(killPidTree).toHaveBeenCalledExactlyOnceWith(42);
      expect(stopRequestedTasks.has("task")).toBe(true);
      expect(activeProcesses.size).toBe(0);
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'task'").get()).toEqual({ status: "in_progress" });
      expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'owner'").get()).toEqual({
        status: "idle",
        current_task_id: null,
      });
      if (signal === "SIGUSR2") expect(process.kill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGUSR2");
      else expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
      // Repeated shutdown signals cannot cancel or kill a resumed task twice.
      listeners.get(signal)!();
      expect(killPidTree).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      db.close();
    }
  });
});
