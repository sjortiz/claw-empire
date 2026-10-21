import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGracefulShutdownHandlers } from "./register-graceful-shutdown.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("shutdown run preservation", () => {
  it.each([123, -1])("interrupts process %s without cancellation, rollback or session closure", (pid) => {
    vi.useFakeTimers();
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE tasks(id TEXT,status TEXT,assigned_agent_id TEXT,updated_at INTEGER); CREATE TABLE agents(id TEXT,status TEXT,current_task_id TEXT); INSERT INTO tasks VALUES ('task','in_progress','owner',0); INSERT INTO agents VALUES ('owner','working','task')",
    );
    const handlers = new Map<string, (...args: any[]) => void>();
    vi.spyOn(process, "on").mockImplementation(((signal: string, callback: any) => {
      handlers.set(signal, callback);
      return process;
    }) as any);
    vi.spyOn(process, "once").mockImplementation(((signal: string, callback: any) => {
      handlers.set(signal, callback);
      return process;
    }) as any);
    const kill = vi.fn();
    const rollback = vi.fn();
    const closeSession = vi.fn();
    const stopRequestedTasks = new Set<string>();
    const activeProcesses = new Map([["task", { pid, kill }]]);
    try {
      registerGracefulShutdownHandlers({
        activeProcesses,
        stopRequestedTasks,
        killPidTree: kill,
        rollbackTaskWorktree: rollback,
        db,
        nowMs: () => 100,
        endTaskExecutionSession: closeSession,
        wsClients: new Set(),
        wss: { close: vi.fn() },
        server: { close: vi.fn() },
      } as any);
      handlers.get("SIGTERM")!();
      expect(kill).toHaveBeenCalledOnce();
      expect(stopRequestedTasks.has("task")).toBe(true);
      expect(db.prepare("SELECT status FROM tasks").get()).toEqual({ status: "in_progress" });
      expect(db.prepare("SELECT status,current_task_id FROM agents").get()).toEqual({
        status: "idle",
        current_task_id: null,
      });
      expect(rollback).not.toHaveBeenCalled();
      expect(closeSession).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
