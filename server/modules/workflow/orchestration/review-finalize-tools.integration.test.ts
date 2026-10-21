import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReportWorkflowTools } from "./report-workflow-tools.ts";
import * as worktreeLifecycle from "../core/worktree/lifecycle.ts";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";

const databases: DatabaseSync[] = [];

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});

function createHarness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, department_id TEXT,
      source_task_id TEXT, project_id TEXT, workflow_pack_key TEXT, project_path TEXT,
      assigned_agent_id TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
      completed_at INTEGER
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY, task_id TEXT, title TEXT, status TEXT,
      delegated_task_id TEXT, blocked_reason TEXT, completed_at INTEGER
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, department_id TEXT, status TEXT, current_task_id TEXT);
    INSERT INTO agents VALUES ('owner', 'development', 'idle', NULL);
    INSERT INTO tasks (id, title, status, department_id, source_task_id, project_id, assigned_agent_id)
      VALUES ('child', 'Implement feature', 'review', 'development', 'root', 'project', 'owner');
    INSERT INTO subtasks (id, task_id, status, delegated_task_id, completed_at)
      VALUES ('sub', 'root', 'done', 'child', 1);
  `);
  const worktree = {
    worktreePath: "/isolated/child",
    projectPath: "/project",
    branchName: "climpire/child",
    integrationBranch: "climpire/d-root",
  };
  const deps = {
    db,
    nowMs: () => 10,
    broadcast: vi.fn(),
    appendTaskLog: vi.fn(),
    getPreferredLanguage: () => "en",
    pickL: (pool: Record<string, string[]>) => pool.en[0],
    l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
    resolveLang: () => "en",
    projectReviewGateNotifiedAt: new Map(),
    notifyCeo: vi.fn(),
    taskWorktrees: new Map([["child", worktree]]),
    mergeToDevAndCreatePR: vi.fn(),
    mergeWorktree: vi.fn((): { success: boolean; message: string; conflicts?: string[] } => ({
      success: true,
      message: "integrated",
    })),
    cleanupWorktree: vi.fn(),
    startTaskExecutionForAgent: vi.fn(),
    getDeptName: (department: string) => department,
    findTeamLeader: () => null,
    setTaskCreationAuditCompletion: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    notifyTaskStatus: vi.fn(),
    refreshCliUsageData: vi.fn(async () => ({})),
    shouldDeferTaskReportUntilPlanningArchive: () => false,
    emitTaskReportEvent: vi.fn(),
    formatTaskSubtaskProgressSummary: () => "",
    reviewRoundState: new Map([["child", 1]]),
    reviewInFlight: new Set(["child"]),
    archivePlanningConsolidatedReport: vi.fn(),
    crossDeptNextCallbacks: new Map(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map(),
    startReviewConsensusMeeting: vi.fn((_id, _title, _dept, approved) => approved()),
  };
  return { db, deps, tools: createReviewFinalizeTools(deps), worktree };
}

describe("directive integration approval", () => {
  it("completes reports without a meeting only after integrating their branch", () => {
    const { db, deps, tools } = createHarness();
    db.exec("UPDATE tasks SET source_task_id = NULL, project_id = NULL, status = 'in_progress' WHERE id = 'child'");
    const reports = createReportWorkflowTools({ ...deps, finishReview: tools.finishReview });
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'child'").get() as any;
    expect(reports.completeTaskWithoutReview(task, "Report complete")).toBe(true);
    expect(deps.mergeWorktree).toHaveBeenCalledWith("/project", "child");
    expect(deps.startReviewConsensusMeeting).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'child'").get()).toMatchObject({ status: "done" });
  });

  it("keeps report checkpoints and their dependency callbacks pending after an integration conflict", () => {
    const { db, deps, tools } = createHarness();
    db.exec("UPDATE tasks SET status = 'in_progress' WHERE id = 'child'");
    deps.mergeWorktree.mockReturnValueOnce({ success: false, message: "conflict" });
    const dependentCallback = vi.fn();
    deps.subtaskDelegationCallbacks.set("child", dependentCallback);
    const reports = createReportWorkflowTools({ ...deps, finishReview: tools.finishReview });
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'child'").get() as any;
    expect(reports.completeTaskWithoutReview(task, "Report complete")).toBe(false);
    expect(dependentCallback).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'child'").get()).toMatchObject({ status: "planned" });
    expect(deps.appendTaskLog).not.toHaveBeenCalledWith("child", "system", "Report complete");
  });

  it("integrates approval into one branch for manual CEO review without GitHub actions", () => {
    const { db, deps, tools } = createHarness();
    tools.finishReview("child", "Implement feature");
    expect(deps.mergeWorktree).toHaveBeenCalledWith("/project", "child");
    expect(deps.mergeToDevAndCreatePR).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'child'").get()).toMatchObject({ status: "done" });
    expect(deps.notifyCeo).toHaveBeenCalledWith(
      expect.stringContaining("climpire/d-root; ready for CEO manual review/merge"),
      "child",
    );
  });

  it("recovers registered worktree metadata after restart before approving an existing branch", () => {
    const { db, deps, tools, worktree } = createHarness();
    db.exec(
      "CREATE TABLE projects (id TEXT PRIMARY KEY, project_path TEXT); INSERT INTO projects VALUES ('project', '/project')",
    );
    deps.taskWorktrees.clear();
    const recover = vi.spyOn(worktreeLifecycle, "recoverTaskWorktree").mockReturnValue(worktree);
    tools.finishReview("child", "Implement feature");
    expect(recover).toHaveBeenCalledWith("/project", "child", db);
    expect(deps.mergeWorktree).toHaveBeenCalledWith("/project", "child");
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'child'").get()).toMatchObject({ status: "done" });
  });

  it("reattaches orphaned task branches before integration rather than silently completing without their work", () => {
    const { db, deps, tools, worktree } = createHarness();
    db.exec("UPDATE tasks SET project_path = '/project' WHERE id = 'child'");
    deps.taskWorktrees.clear();
    vi.spyOn(worktreeLifecycle, "recoverTaskWorktree").mockReturnValue(null);
    vi.spyOn(worktreeLifecycle, "findTaskBranch").mockReturnValue("climpire/child");
    const restore = vi.fn(() => {
      deps.taskWorktrees.set("child", worktree);
      return worktree.worktreePath;
    });
    vi.spyOn(worktreeLifecycle, "createWorktreeLifecycleTools").mockReturnValue({
      createWorktree: restore,
      cleanupWorktree: vi.fn(),
      isGitRepo: () => true,
    });
    tools.finishReview("child", "Implement feature");
    expect(restore).toHaveBeenCalledWith("/project", "child", "review recovery");
    expect(deps.mergeWorktree).toHaveBeenCalledWith("/project", "child");
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'child'").get()).toMatchObject({ status: "done" });
  });

  it("holds approval and returns to the owner if existing task work cannot be recovered", () => {
    const { db, deps, tools } = createHarness();
    db.exec("UPDATE tasks SET project_path = '/project' WHERE id = 'child'");
    deps.taskWorktrees.clear();
    vi.spyOn(worktreeLifecycle, "recoverTaskWorktree").mockReturnValue(null);
    vi.spyOn(worktreeLifecycle, "findTaskBranch").mockReturnValue("climpire/child");
    vi.spyOn(worktreeLifecycle, "createWorktreeLifecycleTools").mockReturnValue({
      createWorktree: () => null,
      cleanupWorktree: vi.fn(),
      isGitRepo: () => true,
    });
    tools.finishReview("child", "Implement feature");
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'child'").get()).toMatchObject({ status: "planned" });
    expect(deps.mergeWorktree).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.setTaskCreationAuditCompletion).not.toHaveBeenCalled();
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalled();
  });

  it("keeps conflicts out of done, retains worktree and owner, and permits approval after revision", () => {
    const { db, deps, tools, worktree } = createHarness();
    deps.mergeWorktree.mockReturnValueOnce({ success: false, message: "conflict", conflicts: ["src/feature.ts"] });
    tools.finishReview("child", "Implement feature");
    expect(
      db.prepare("SELECT status, completed_at, assigned_agent_id, description FROM tasks WHERE id = 'child'").get(),
    ).toMatchObject({
      status: "planned",
      completed_at: null,
      assigned_agent_id: "owner",
      description: expect.stringContaining("src/feature.ts"),
    });
    expect(db.prepare("SELECT status, completed_at FROM subtasks WHERE id = 'sub'").get()).toMatchObject({
      status: "blocked",
      completed_at: null,
    });
    expect(deps.taskWorktrees.get("child")).toBe(worktree);
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.setTaskCreationAuditCompletion).not.toHaveBeenCalled();
    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledWith(
      "child",
      expect.objectContaining({ id: "owner" }),
      "development",
      "development",
    );
    expect(deps.reviewInFlight.has("child")).toBe(false);

    db.exec("UPDATE tasks SET status = 'review' WHERE id = 'child'");
    tools.finishReview("child", "Implement feature");
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'child'").get()).toMatchObject({ status: "done" });
    expect(deps.mergeWorktree).toHaveBeenCalledTimes(2);
    expect(deps.cleanupWorktree).toHaveBeenCalledOnce();
  });

  it("resumes a held parent after the same child completes its integration revision", () => {
    const { db, deps, tools } = createHarness();
    db.exec("INSERT INTO tasks (id, title, status, department_id) VALUES ('root', 'Directive', 'review', 'planning')");
    const dependentCallback = vi.fn();
    deps.subtaskDelegationCallbacks.set("child", dependentCallback);
    deps.mergeWorktree.mockReturnValueOnce({ success: false, message: "conflict" });
    tools.finishReview("root", "Directive");
    expect(dependentCallback).not.toHaveBeenCalled();
    db.exec("UPDATE tasks SET status = 'review' WHERE id = 'child'");
    tools.finishReview("child", "Implement feature");
    expect(dependentCallback).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toMatchObject({ status: "done" });
    expect(db.prepare("SELECT status FROM subtasks WHERE id = 'sub'").get()).toMatchObject({ status: "done" });
  });

  it("integrates nested collaboration work before completing its ancestors", () => {
    const { db, deps, tools, worktree } = createHarness();
    db.exec(`
      INSERT INTO tasks (id, title, status, department_id) VALUES ('root', 'Directive', 'review', 'planning');
      INSERT INTO tasks (id, title, status, department_id, source_task_id)
        VALUES ('grandchild', 'Nested change', 'review', 'development', 'child');
    `);
    deps.taskWorktrees.set("grandchild", { ...worktree, branchName: "climpire/grandchild" });
    tools.finishReview("root", "Directive");
    expect(deps.mergeWorktree.mock.calls).toEqual([
      ["/project", "grandchild"],
      ["/project", "child"],
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'done'").get()).toMatchObject({ count: 3 });
  });

  it("holds parent completion when a reviewing child cannot integrate", () => {
    const { db, deps, tools } = createHarness();
    db.exec("INSERT INTO tasks (id, title, status, department_id) VALUES ('root', 'Directive', 'review', 'planning')");
    deps.mergeWorktree.mockReturnValueOnce({ success: false, message: "conflict" });
    tools.finishReview("root", "Directive");
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'root'").get()).toMatchObject({ status: "review" });
    expect(deps.setTaskCreationAuditCompletion).not.toHaveBeenCalled();
    expect(deps.archivePlanningConsolidatedReport).not.toHaveBeenCalled();
  });
});
