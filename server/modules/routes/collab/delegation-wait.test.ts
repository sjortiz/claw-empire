import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { createSubtaskDelegationBatch } from "./subtask-delegation-batch.ts";
import { createDelegationWait, DELEGATION_WAIT_LIMIT_MS, resetDelegationWaits } from "./delegation-wait.ts";

let db: DatabaseSync;
afterEach(() => {
  db?.close();
  vi.useRealTimers();
});
function fixture() {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO tasks (id, title, status) VALUES ('root', 'Root', 'planned');
    INSERT INTO subtasks (id, task_id, title, target_department_id) VALUES ('item', 'root', 'Develop', 'dev');
  `);
  const appendTaskLog = (id: string, kind: string, message: string) => {
    db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, ?, ?)").run(id, kind, message);
  };
  return { db, nowMs: () => Date.now(), appendTaskLog, notifyCeo: vi.fn(), broadcast: vi.fn() };
}

describe("bounded delegation waits", () => {
  it("logs the awaited department once, persists the budget across reconstruction and escalates only once", () => {
    vi.useFakeTimers();
    const deps = fixture();
    const makeBatch = () =>
      createSubtaskDelegationBatch({
        ...deps,
        resolveLang: () => "en",
        getDeptName: (id: string) => id,
        findTeamLeader: () => null,
      } as any);
    const item = db.prepare("SELECT * FROM subtasks WHERE id = 'item'").get() as any;
    const parent = db.prepare("SELECT * FROM tasks WHERE id = 'root'").get() as any;
    const firstDone = vi.fn();
    makeBatch().delegateSubtaskBatch([item], 0, 1, parent, firstDone);
    vi.advanceTimersByTime(30_000);
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_logs").get()).toEqual({ count: 1 });
    expect(deps.notifyCeo).not.toHaveBeenCalled();
    // Simulate lost timers and reconstructed handlers after a server restart.
    vi.clearAllTimers();
    vi.advanceTimersByTime(DELEGATION_WAIT_LIMIT_MS);
    const resumedDone = vi.fn();
    makeBatch().delegateSubtaskBatch([item], 0, 1, parent, resumedDone);
    expect(deps.notifyCeo).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("department leader (dev)"), "root");
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "pending" });
    expect(db.prepare("SELECT blocked_reason FROM subtasks WHERE id = 'item'").get()).toEqual({
      blocked_reason: "Needs CEO attention: waiting for eligible department leader (dev)",
    });
    expect(resumedDone).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    createDelegationWait(deps).wait("root", "department-batch:dev:item", "department leader (dev)");
    expect(deps.notifyCeo).toHaveBeenCalledOnce();
  });

  it("bounds a busy department agent wait without taking its reservation or flooding logs", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const deps = fixture();
    db.exec(`
      INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('dev', 'Development', '개발', 'D', '#111');
      INSERT INTO agents (id, name, department_id, role, status, current_task_id)
        VALUES ('leader', 'Dev Leader', 'dev', 'team_leader', 'working', 'another-root');
    `);
    const leader = db.prepare("SELECT * FROM agents WHERE id = 'leader'").get();
    const batch = createSubtaskDelegationBatch({
      ...deps,
      resolveLang: () => "en",
      getDeptName: (id: string) => id,
      findTeamLeader: (id: string) => (id === "dev" ? leader : null),
      findBestSubordinate: () => null,
      l: (ko: string[], en: string[]) => ({ ko, en }),
      pickL: (pool: { en: string[] }) => pool.en[0],
      getAgentDisplayName: (agent: { name: string }) => agent.name,
      sendAgentMessage: vi.fn(),
    } as any);
    const item = db.prepare("SELECT * FROM subtasks WHERE id = 'item'").get() as any;
    const parent = db.prepare("SELECT * FROM tasks WHERE id = 'root'").get() as any;
    batch.delegateSubtaskBatch([item], 0, 1, parent, vi.fn());
    vi.advanceTimersByTime(DELEGATION_WAIT_LIMIT_MS + 20_000);
    expect(deps.notifyCeo).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("available department agent (dev)"),
      "root",
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_logs").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT current_task_id FROM agents WHERE id = 'leader'").get()).toEqual({
      current_task_id: "another-root",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
  });

  it("does not launch an already queued department acknowledgement after attention", () => {
    vi.useFakeTimers();
    const deps = fixture();
    db.exec(`INSERT INTO departments (id,name,name_ko,icon,color) VALUES ('dev','Development','개발','D','#111');
      INSERT INTO agents (id,name,department_id,role,status) VALUES ('leader','Leader','dev','team_leader','idle');`);
    const leader = db.prepare("SELECT * FROM agents WHERE id='leader'").get();
    const done = vi.fn();
    const batch = createSubtaskDelegationBatch({
      ...deps,
      resolveLang: () => "en",
      getDeptName: (id: string) => id,
      getAgentDisplayName: () => "Leader",
      findTeamLeader: () => leader,
      findBestSubordinate: () => null,
      sendAgentMessage: vi.fn(),
      l: (_ko: string[], en: string[]) => ({ en }),
      pickL: (pool: any) => pool.en[0],
    } as any);
    batch.delegateSubtaskBatch(
      [db.prepare("SELECT * FROM subtasks WHERE id='item'").get() as any],
      0,
      1,
      db.prepare("SELECT * FROM tasks WHERE id='root'").get() as any,
      done,
    );
    db.exec(
      "INSERT INTO task_logs (task_id,kind,message) VALUES ('root','system','Workflow attention required: planning failed')",
    );
    vi.advanceTimersByTime(3000);
    expect(done).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
  });
  it("lets an explicit Resume reset an exhausted wait and its blocked department work", () => {
    vi.useFakeTimers();
    const deps = fixture();
    const wait = createDelegationWait(deps);
    wait.wait("root", "department:dev", "department dev", ["item"]);
    vi.advanceTimersByTime(DELEGATION_WAIT_LIMIT_MS);
    expect(wait.wait("root", "department:dev", "department dev", ["item"])).toBe(false);
    expect(db.prepare("SELECT status FROM tasks WHERE id='root'").get()).toEqual({ status: "pending" });
    resetDelegationWaits(deps, "root");
    expect(db.prepare("SELECT status, blocked_reason FROM subtasks WHERE id='item'").get()).toEqual({
      status: "pending",
      blocked_reason: null,
    });
    expect(createDelegationWait(deps).wait("root", "department:dev", "department dev", ["item"])).toBe(true);
    expect(deps.notifyCeo).toHaveBeenCalledOnce();
  });
  it("does not regress an active parent and starts a fresh budget only after progress", () => {
    vi.useFakeTimers();
    const deps = fixture();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'root'").run();
    const wait = createDelegationWait(deps);
    expect(wait.wait("root", "department", "available department agent (dev)")).toBe(true);
    wait.resolve("root", "department");
    vi.advanceTimersByTime(DELEGATION_WAIT_LIMIT_MS);
    expect(wait.wait("root", "department", "available department agent (dev)")).toBe(true);
    vi.advanceTimersByTime(DELEGATION_WAIT_LIMIT_MS);
    expect(wait.wait("root", "department", "available department agent (dev)")).toBe(false);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toEqual({ status: "in_progress" });
    expect(deps.notifyCeo).toHaveBeenCalledOnce();
  });
});
