import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { recoverOrphanInProgressTasks, sweepQueuedRunRecoveries } from "./run-recovery.ts";
import { recoverReadyRoot } from "./task-resume.ts";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(child = false, status = "in_progress") {
  const project = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "run-recovery-"));
  directories.push(project);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" }).toString().trim();
  git("init", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture");
  const db = new DatabaseSync(path.join(project, "fixture.sqlite"));
  databases.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  const id = child ? "childaaa-task" : "rootaaaa-task";
  const worktree = path.join(project, ".climpire-worktrees", id.slice(0, 8));
  const branch = `climpire/${id.slice(0, 8)}`;
  git("worktree", "add", "-b", branch, worktree);
  fs.writeFileSync(path.join(worktree, "unfinished.txt"), "preserve my edits\n");
  db.prepare("INSERT INTO projects(id,name,project_path,core_goal) VALUES ('project','Project',?,'Recover')").run(
    project,
  );
  db.exec("INSERT INTO agents(id,name,role,cli_provider,status) VALUES ('owner','Owner','senior','codex','working')");
  if (child) db.exec("INSERT INTO tasks(id,title,status) VALUES ('parent','Parent','collaborating')");
  db.prepare(
    `INSERT INTO tasks(id,title,status,assigned_agent_id,source_task_id,project_id,updated_at,created_at,started_at)
    VALUES (?, 'Recover', ?, 'owner', ?, 'project', 1, 1, 1)`,
  ).run(id, status, child ? "parent" : null);
  db.prepare("UPDATE agents SET current_task_id = ?").run(id);
  const deps = {
    db,
    logsDir: project,
    nowMs: () => 1_000_000,
    IN_PROGRESS_ORPHAN_GRACE_MS: 30_000,
    activeProcesses: new Map<string, any>(),
    taskWorktrees: new Map<string, any>(),
    stopRequestedTasks: new Set<string>(),
    isPidAlive: vi.fn(() => false),
    stopProgressTimer: vi.fn(),
    broadcast: vi.fn(),
    getDeptName: () => "Development",
    notifyCeo: vi.fn(),
    handleTaskRunComplete: vi.fn(),
    appendTaskLog: (taskId: string, kind: string, message: string) => {
      db.prepare("INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?,?,?,?)").run(
        taskId,
        kind,
        message,
        1_000_000,
      );
    },
    startTaskExecutionForAgent: vi.fn(
      (taskId: string, agent: { id: string }, _deptId?: string | null, _deptName?: string, _options?: any) => {
        db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
        db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(taskId, agent.id);
        db.prepare(
          "INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?, 'system', 'RUN start (recovered)', 1000000)",
        ).run(taskId);
        deps.activeProcesses.set(taskId, { pid: -1 });
      },
    ),
  };
  db.prepare(
    "INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?, 'system', 'RUN start (agent=Owner, provider=codex)', 1)",
  ).run(id);
  return { db, deps, id, project, worktree, branch, git };
}

describe("interrupted run recovery", () => {
  it.each([
    [false, "in_progress"],
    [true, "in_progress"],
    [true, "inbox"],
    [false, "inbox"],
  ] as const)(
    "recovers root/child=%s from %s in its original dirty worktree without a failure notice",
    (child, status) => {
      const { db, deps, id, worktree, branch, git } = fixture(child, status);
      recoverOrphanInProgressTasks(deps, "startup");
      expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
      expect(deps.startTaskExecutionForAgent.mock.calls[0][4]).toEqual(
        expect.objectContaining({
          reuseWorktree: true,
          recoveryNote: expect.stringContaining("previous changes are kept"),
        }),
      );
      expect(deps.taskWorktrees.get(id)).toMatchObject({ worktreePath: worktree, branchName: branch });
      expect(fs.readFileSync(path.join(worktree, "unfinished.txt"), "utf8")).toBe("preserve my edits\n");
      expect(git("branch", "--show-current")).toBe("main");
      expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(id)).toEqual({ status: "in_progress" });
      expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
      expect(deps.notifyCeo).not.toHaveBeenCalled();
      expect(
        db
          .prepare("SELECT 1 FROM task_logs WHERE task_id = ? AND message = ?")
          .get(id, `Recovery (startup): run interrupted by a restart; resuming in ${worktree}`),
      ).toBeTruthy();
      recoverOrphanInProgressTasks(deps, "interval");
      expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    },
  );

  it.each(["cancelled", "done", "pending"])("leaves %s tasks untouched", (status) => {
    const { deps } = fixture(false, status);
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
  });

  it.each(["PAUSE_BREAK: explicit pause", "STOP sent to pid 42"])("preserves durable CEO control: %s", (control) => {
    const { deps, id } = fixture();
    deps.appendTaskLog(id, "system", control);
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "done"])("does not resume a child of a %s directive", (status) => {
    const { deps, db } = fixture(true);
    db.prepare("UPDATE tasks SET status = ? WHERE id = 'parent'").run(status);
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });

  it("blocks recovery while shutting down, even after a late close cleared stop flags", () => {
    const { deps } = fixture();
    recoverOrphanInProgressTasks({ ...deps, shuttingDown: true }, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });

  it("waits persistently for a missing worktree and prevents the root sweep creating a replacement", () => {
    vi.useFakeTimers();
    const { deps, id, project, worktree } = fixture();
    fs.renameSync(worktree, path.join(project, "retained-elsewhere"));
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(
      deps.db.prepare("SELECT message FROM task_logs WHERE message LIKE 'Workflow wait run-worktree:%'").get(),
    ).toBeTruthy();
    expect(recoverReadyRoot(deps, id, "root sweep")).toBe(false);
  });

  it("preserves an in-memory stop request and a live detached process", () => {
    const { deps, id } = fixture();
    deps.stopRequestedTasks.add(id);
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    deps.stopRequestedTasks.clear();
    deps.appendTaskLog(id, "system", "Run process pid: 42");
    deps.isPidAlive.mockReturnValue(true);
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.isPidAlive).toHaveBeenCalledWith(42);
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });

  it("recovers a known dead process immediately at startup even when output was recent", () => {
    const { deps, id } = fixture();
    deps.appendTaskLog(id, "system", "Run process pid: 42");
    fs.writeFileSync(path.join(deps.logsDir, `${id}.log`), "recent output");
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });

  it("waits visibly for a busy child owner across restart, then starts only once", () => {
    vi.useFakeTimers();
    const { db, deps, id } = fixture(true);
    db.exec("UPDATE agents SET current_task_id = 'another-task', status = 'working'");
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(id)).toEqual({ status: "planned" });
    expect(
      db.prepare("SELECT message FROM task_logs WHERE message LIKE 'Workflow wait root-owner:%'").get(),
    ).toMatchObject({ message: expect.stringContaining("another-task") });
    vi.clearAllTimers();
    const restarted = {
      ...deps,
      db: new DatabaseSync(path.join(deps.logsDir, "fixture.sqlite")),
      activeProcesses: new Map(),
      taskWorktrees: new Map(),
    };
    databases.push(restarted.db);
    sweepQueuedRunRecoveries(restarted);
    expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'owner'").get()).toEqual({
      status: "working",
      current_task_id: "another-task",
    });
    db.exec("UPDATE agents SET current_task_id = NULL, status = 'idle'");
    vi.advanceTimersByTime(5_000);
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    sweepQueuedRunRecoveries(restarted);
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });

  it("resumes a retry reserved just before restart without consuming another retry", () => {
    const { deps, id } = fixture(true);
    deps.appendTaskLog(id, "system", "RUN failed (exit code: 1)");
    deps.appendTaskLog(id, "system", "Run automatic retry: 1/1 (exit code: 1); worktree preserved");
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
  });

  it("waits for another in-progress assignment even if its agent status is stale idle", () => {
    vi.useFakeTimers();
    const { deps, db } = fixture();
    db.exec(
      "INSERT INTO tasks(id,title,status,assigned_agent_id) VALUES ('other','Other','in_progress','owner'); UPDATE agents SET status = 'idle', current_task_id = NULL",
    );
    deps.activeProcesses.set("other", { pid: -1 });
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });

  it("keeps strict worktree/session reuse if the ordinary root sweep wins an owner-wait race", () => {
    vi.useFakeTimers();
    const { db, deps, id } = fixture();
    db.exec("UPDATE agents SET current_task_id = 'another-task', status = 'working'");
    recoverOrphanInProgressTasks(deps, "startup");
    db.exec("UPDATE agents SET current_task_id = NULL, status = 'idle'");
    expect(recoverReadyRoot(deps, id, "root sweep")).toBe(true);
    expect(deps.startTaskExecutionForAgent.mock.calls[0][4]).toMatchObject({ reuseWorktree: true });
    vi.advanceTimersByTime(5_000);
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });

  it("replays recorded completions but does not requeue a real failure in Inbox", () => {
    const { deps, id, db } = fixture();
    db.prepare(
      "INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?, 'system', 'RUN completed (exit code: 0)', 2)",
    ).run(id);
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.handleTaskRunComplete).toHaveBeenCalledExactlyOnceWith(id, 0);
    db.prepare("UPDATE tasks SET status = 'inbox' WHERE id = ?").run(id);
    deps.appendTaskLog(id, "system", "RUN failed (exit code: 1)");
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });

  it.each([false, true])("recovers legacy synthetic restart failures in Inbox (child=%s)", (child) => {
    const { deps, db, id } = fixture(child, "inbox");
    db.prepare(
      "INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?, 'system', 'Recovery (startup): orphan in_progress detected (age_ms=120000) → replaying failed completion', 2)",
    ).run(id);
    db.prepare(
      "INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?, 'system', 'RUN failed (exit code: 1)', 3)",
    ).run(id);
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    expect(deps.notifyCeo).not.toHaveBeenCalled();
    expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
  });

  it("does not mistake an old replay of a recorded real failure for an interruption", () => {
    const { deps, db, id } = fixture(true, "inbox");
    for (const message of [
      "RUN failed (exit code: 2)",
      "Recovery (startup): orphan in_progress detected (age_ms=120000) → replaying failed completion",
      "RUN failed (exit code: 1)",
    ])
      db.prepare("INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?, 'system', ?, 2)").run(id, message);
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });
});
