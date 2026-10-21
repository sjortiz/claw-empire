import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistentWait,
  hasExhaustedWait,
  resetPersistentWaits,
  sweepExpiredWorkflowWaits,
} from "./persistent-wait.ts";

describe("persistent workflow waits", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE task_logs (task_id TEXT, kind TEXT, message TEXT, created_at INTEGER);
      CREATE TABLE tasks (id TEXT, status TEXT, updated_at INTEGER);
      INSERT INTO tasks VALUES ('root', 'planned', 0);
    `);
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });
  function fixture() {
    const notifyCeo = vi.fn();
    const appendTaskLog = vi.fn((taskId: string, kind: string, message: string) => {
      db.prepare("INSERT INTO task_logs VALUES (?, ?, ?, ?)").run(taskId, kind, message, Date.now());
    });
    return { db, nowMs: Date.now, notifyCeo, appendTaskLog, broadcast: vi.fn() };
  }

  it("logs the dependency once, bounds the wait across restart, and notifies once", () => {
    const deps = fixture();
    const retry = vi.fn();
    const waiting = createPersistentWait(deps);
    waiting.wait("root", "department:dev", "Waiting for department dev agent", retry, { maxWaitMs: 10_000 });
    waiting.wait("root", "department:dev", "Waiting for department dev agent", retry, { maxWaitMs: 10_000 });
    expect(deps.appendTaskLog).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    // Restart loses the timer and helper instance, but not the original clock.
    vi.clearAllTimers();
    vi.setSystemTime(11_000);
    const restarted = createPersistentWait(deps);
    expect(
      restarted.wait("root", "department:dev", "Waiting for department dev agent", retry, { maxWaitMs: 10_000 }),
    ).toBe(false);
    expect(hasExhaustedWait(db, "root")).toBe(true);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "pending" });
    expect(deps.broadcast).toHaveBeenCalledWith("task_update", expect.objectContaining({ status: "pending" }));
    expect(deps.notifyCeo).toHaveBeenCalledTimes(1);
    expect(deps.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("department dev agent"), "root");
    expect(vi.getTimerCount()).toBe(0);
    restarted.wait("root", "department:dev", "Waiting for department dev agent", retry);
    expect(deps.notifyCeo).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    resetPersistentWaits(db, "root", Date.now());
    expect(hasExhaustedWait(db, "root")).toBe(false);
    expect(restarted.wait("root", "department:dev", "Waiting for department dev agent", retry)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("expires a lost callback from the startup sweep with the original custom deadline", () => {
    const deps = fixture();
    const waiting = createPersistentWait(deps);
    waiting.wait("root", "planning-integration", "Waiting for child integration", vi.fn(), { maxWaitMs: 60_000 });
    vi.clearAllTimers();
    vi.setSystemTime(60_999);
    sweepExpiredWorkflowWaits(deps);
    expect(deps.notifyCeo).not.toHaveBeenCalled();
    vi.setSystemTime(61_000);
    sweepExpiredWorkflowWaits(deps);
    sweepExpiredWorkflowWaits(deps);
    expect(deps.notifyCeo).toHaveBeenCalledOnce();
    expect(hasExhaustedWait(db, "root")).toBe(true);
  });
  it.each(["in_progress", "review"])(
    "does not regress active %s work when another department exhausts its wait",
    (status) => {
      const deps = fixture();
      db.prepare("UPDATE tasks SET status = ? WHERE id = 'root'").run(status);
      const waiting = createPersistentWait(deps);
      waiting.wait("root", "department", "Waiting for department", vi.fn(), { maxWaitMs: 0 });
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status });
      expect(hasExhaustedWait(db, "root")).toBe(true);
      expect(deps.notifyCeo).toHaveBeenCalledTimes(1);
      expect(deps.broadcast).not.toHaveBeenCalled();
    },
  );

  it("resolves a dependency and cancels a duplicate retry", () => {
    const deps = fixture();
    const retry = vi.fn();
    const waiting = createPersistentWait(deps);
    waiting.wait("root", "planner", "Waiting for planner", retry);
    waiting.clear("root", "planner");
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
    expect(deps.notifyCeo).not.toHaveBeenCalled();
    expect(deps.appendTaskLog).toHaveBeenLastCalledWith(
      "root",
      "system",
      expect.stringContaining('"state":"resolved"'),
    );
  });
});
