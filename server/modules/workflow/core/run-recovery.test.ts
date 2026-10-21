import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { recoverOrphanInProgressTasks } from "../../lifecycle/recover-orphan-runs.ts";
import { createRunCompleteHandler } from "../orchestration/run-complete-handler.ts";
import { createSessionReviewTools } from "../orchestration/session-review-tools.ts";
import {
  hasAutomaticRunRetry,
  queueTaskRunRecovery,
  resumeQueuedTaskRun,
  sweepQueuedTaskRuns,
} from "./run-recovery.ts";
import { holdRecoveryDuringShutdown } from "./task-recovery-control.ts";
import { recoverReadyRoot, resumeTaskExecution } from "./task-resume.ts";

let db: DatabaseSync;
let repo: string;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  db?.close();
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

function fixture(persistent = false) {
  repo = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "recovery-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
  git("init", "-b", "main");
  git("-c", "user.name=Recovery Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base");
  db = new DatabaseSync(persistent ? path.join(repo, "recovery.sqlite") : ":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec("INSERT INTO agents (id,name,role,cli_provider,status) VALUES ('owner','Owner','senior','codex','working')");
  const appendTaskLog = (id: string, kind: string, message: string) =>
    db.prepare("INSERT INTO task_logs(task_id,kind,message,created_at) VALUES (?,?,?,?)").run(id, kind, message, now);
  let now = 1_000_000;
  const deps = {
    db,
    nowMs: () => now,
    logsDir: repo,
    IN_PROGRESS_ORPHAN_GRACE_MS: 30_000,
    activeProcesses: new Map(),
    stopRequestedTasks: new Set(),
    stopRequestModeByTask: new Map(),
    taskWorktrees: new Map(),
    taskExecutionSessions: new Map(),
    isPidAlive: vi.fn(() => false),
    appendTaskLog,
    broadcast: vi.fn(),
    notifyCeo: vi.fn(),
    stopProgressTimer: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    handleTaskRunComplete: vi.fn(),
    resolveLang: () => "en",
    getDeptName: () => "Development",
    startTaskExecutionForAgent: vi.fn((id: string) => {
      db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(id);
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = 'owner'").run(id);
      appendTaskLog(id, "system", "RUN start (agent=Owner, provider=codex)");
      deps.activeProcesses.set(id, { pid: -1 });
    }),
  };
  const add = (id = "root0000-task", status = "in_progress", parent: string | null = null) => {
    db.prepare(
      "INSERT INTO tasks(id,title,status,assigned_agent_id,project_path,source_task_id,created_at,updated_at) VALUES (?, 'Recovery task', ?, 'owner', ?, ?, 1,1)",
    ).run(id, status, repo, parent);
    const worktree = path.join(repo, ".climpire-worktrees", id.slice(0, 8));
    git("worktree", "add", "-b", "climpire/" + id.slice(0, 8), worktree);
    fs.writeFileSync(path.join(worktree, "unfinished.txt"), "keep my changes");
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = 'owner'").run(id);
    appendTaskLog(id, "system", "RUN start (agent=Owner, provider=codex)");
    return worktree;
  };
  return {
    deps,
    add,
    git,
    advance: (ms = 200_000) => {
      now += ms;
    },
    logs: (id: string) =>
      db
        .prepare("SELECT message FROM task_logs WHERE task_id = ? ORDER BY rowid")
        .all(id)
        .map((r: any) => r.message),
  };
}

describe("restart-safe run recovery", () => {
  it.each([
    ["root", "in_progress"],
    ["child", "in_progress"],
    ["child", "inbox"],
  ])("requeues an interrupted %s in %s using its retained worktree without failure", (kind, status) => {
    const { deps, add, advance, logs } = fixture();
    if (kind === "child") db.exec("INSERT INTO tasks(id,title,status) VALUES ('parent','Directive','collaborating')");
    const id = kind === "child" ? "child000-task" : "root0000-task";
    const worktree = add(id, status, kind === "child" ? "parent" : null);
    advance();
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledExactlyOnceWith(
      id,
      expect.objectContaining({ id: "owner" }),
      null,
      "Unassigned",
      expect.objectContaining({ reuseWorktree: true, recoveryNote: expect.stringContaining("interrupted") }),
    );
    expect(deps.taskWorktrees.get(id)).toMatchObject({
      worktreePath: worktree,
      branchName: "climpire/" + id.slice(0, 8),
    });
    expect(fs.readFileSync(path.join(worktree, "unfinished.txt"), "utf8")).toBe("keep my changes");
    expect(logs(id)).toContain("Recovery (startup): run interrupted by a restart; resuming in " + worktree);
    expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
    expect(deps.notifyCeo).not.toHaveBeenCalled();
    recoverOrphanInProgressTasks(deps, "interval");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "done", "pending"])("leaves %s tasks alone", (status) => {
    const { deps, add, advance } = fixture();
    add("root0000-task", status);
    advance();
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM tasks").get()).toEqual({ status });
  });

  it.each(["PAUSE_BREAK: explicit pause", "STOP sent to pid 123"])(
    "honors durable control %s even with lost runtime state",
    (control) => {
      const { deps, add, advance } = fixture();
      add();
      deps.appendTaskLog("root0000-task", "system", control);
      advance();
      recoverOrphanInProgressTasks(deps, "startup");
      expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
      expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
    },
  );

  it("leaves a stopped runtime task and paused directive children alone", () => {
    const { deps, add, advance } = fixture();
    db.exec("INSERT INTO tasks(id,title,status) VALUES ('parent','Directive','pending')");
    deps.appendTaskLog("parent", "system", "PAUSE_BREAK: explicit pause");
    add("child000-task", "inbox", "parent");
    deps.stopRequestedTasks.add("child000-task");
    advance();
    recoverOrphanInProgressTasks(deps, "startup");
    deps.stopRequestedTasks.clear();
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });

  it("waits durably for a busy owner and resumes a queued child after restart only once", () => {
    const { deps, add, advance, logs } = fixture();
    db.exec("INSERT INTO tasks(id,title,status) VALUES ('parent','Directive','collaborating')");
    add("child000-task", "in_progress", "parent");
    db.exec("UPDATE agents SET current_task_id = 'other', status = 'working'");
    advance();
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(db.prepare("SELECT current_task_id FROM agents").get()).toEqual({ current_task_id: "other" });
    expect(logs("child000-task").some((s: string) => s.startsWith("Workflow wait run-owner:"))).toBe(true);
    vi.clearAllTimers();
    db.exec("UPDATE agents SET status = 'idle', current_task_id = NULL");
    const restarted = { ...deps, activeProcesses: new Map(), taskWorktrees: new Map(), stopRequestedTasks: new Set() };
    sweepQueuedTaskRuns(restarted, "startup");
    sweepQueuedTaskRuns(restarted, "interval");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });

  it("does not let the ordinary root sweep bypass a queued worktree wait", () => {
    const { deps, add } = fixture();
    add();
    queueTaskRunRecovery(deps, "root0000-task", "Recovery (startup): run interrupted by a restart");
    db.exec("UPDATE agents SET status = 'working', current_task_id = 'other'");
    expect(recoverReadyRoot(deps, "root0000-task", "root sweep")).toBe(false);
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    db.exec("UPDATE agents SET status = 'idle', current_task_id = NULL");
    resumeTaskExecution(deps, "root0000-task", "lost owner callback");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledWith(
      "root0000-task",
      expect.anything(),
      null,
      "Unassigned",
      expect.objectContaining({ reuseWorktree: true }),
    );
  });

  it("recovers a child incorrectly sent to Inbox by the old restart watchdog", () => {
    const { deps, add, advance } = fixture();
    db.exec("INSERT INTO tasks(id,title,status) VALUES ('parent','Directive','collaborating')");
    add("child000-task", "inbox", "parent");
    deps.appendTaskLog(
      "child000-task",
      "system",
      "Recovery (startup): orphan in_progress detected (age_ms=999999) → replaying failed completion",
    );
    deps.appendTaskLog("child000-task", "system", "RUN failed (exit code: 1)");
    advance();
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    expect(deps.notifyCeo).not.toHaveBeenCalled();
    expect(hasAutomaticRunRetry(db, "child000-task")).toBe(false);
  });

  it("holds recovery while the server shuts down even after stop flags are cleared", () => {
    const { deps, add, advance } = fixture();
    add();
    advance();
    holdRecoveryDuringShutdown(deps.activeProcesses);
    deps.stopRequestedTasks.clear();
    recoverOrphanInProgressTasks(deps, "interval");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
  });

  it("recovers a retry interrupted between its in_progress claim and RUN start without spending another retry", () => {
    const { deps, add, advance } = fixture();
    add();
    queueTaskRunRecovery(deps, "root0000-task", "Automatic retry after agent process failure", 1);
    db.exec("UPDATE tasks SET status = 'in_progress'");
    advance();
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM task_logs WHERE message LIKE 'Automatic run retry: 1/1%'").get(),
    ).toEqual({ count: 1 });
    expect(deps.handleTaskRunComplete).not.toHaveBeenCalled();
  });

  it("never duplicates a live detached process after losing runtime handles", () => {
    const { deps, add, advance } = fixture();
    add();
    deps.appendTaskLog("root0000-task", "system", "Run process: pid=123");
    deps.isPidAlive.mockReturnValue(true);
    advance();
    recoverOrphanInProgressTasks(deps, "startup");
    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
  });

  it("persists one real failure retry across restart, then sends the second failure to Inbox", () => {
    const { deps, add, advance, logs } = fixture(true);
    const worktree = add();
    advance();
    const completionDeps = {
      ...deps,
      codexThreadToSubtask: new Map(),
      processSubtaskDelegations: vi.fn(),
      cleanupWorktree: vi.fn(),
      findTeamLeader: () => null,
      l: (_ko: string[], en: string[]) => en,
      pickL: (pool: string[]) => pool[0],
      sendAgentMessage: vi.fn(),
      reconcileDelegatedSubtasksAfterRun: vi.fn(),
      crossDeptNextCallbacks: new Map(),
      subtaskDelegationCallbacks: new Map(),
      prettyStreamJson: (s: string) => s,
    };
    createRunCompleteHandler(completionDeps).handleTaskRunComplete("root0000-task", 1);
    expect(db.prepare("SELECT status FROM tasks").get()).toEqual({ status: "planned" });
    expect(hasAutomaticRunRetry(db, "root0000-task")).toBe(true);
    expect(completionDeps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.notifyCeo).not.toHaveBeenCalled();
    vi.clearAllTimers(); // Restart before the dispatch callback, reopening persisted state.
    db.close();
    db = new DatabaseSync(path.join(repo, "recovery.sqlite"));
    expect(hasAutomaticRunRetry(db, "root0000-task")).toBe(true);
    const restarted = {
      ...completionDeps,
      db,
      activeProcesses: new Map(),
      taskWorktrees: new Map(),
      taskExecutionSessions: new Map(),
    };
    sweepQueuedTaskRuns(restarted, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
    expect(restarted.taskWorktrees.get("root0000-task").worktreePath).toBe(worktree);
    createRunCompleteHandler(restarted).handleTaskRunComplete("root0000-task", 2);
    expect(db.prepare("SELECT status FROM tasks").get()).toEqual({ status: "inbox" });
    expect(logs("root0000-task").filter((s: string) => s.startsWith("Automatic run retry: 1/1"))).toHaveLength(1);
    expect(deps.notifyCeo).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("one automatic retry"),
      "root0000-task",
    );
    sweepQueuedTaskRuns(restarted, "startup");
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledOnce();
  });

  it("restores the application session identity from its durable record", () => {
    const { deps, add } = fixture();
    add();
    const sessions = new Map();
    const tools = (map: Map<string, any>) =>
      createSessionReviewTools({ ...deps, taskExecutionSessions: map, randomUUID: () => "app-session-id" });
    const first = tools(sessions).ensureTaskExecutionSession("root0000-task", "owner", "codex");
    const after = tools(new Map()).ensureTaskExecutionSession("root0000-task", "owner", "codex");
    expect(after.sessionId).toBe(first.sessionId);
    const closed = tools(new Map());
    closed.endTaskExecutionSession("root0000-task", "done");
    expect(logsSession()).toContain("Execution session closed:");
    function logsSession() {
      return String((db.prepare("SELECT message FROM task_logs ORDER BY rowid DESC LIMIT 1").get() as any).message);
    }
  });
});
