import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktreeLifecycleTools } from "../core/worktree/lifecycle.ts";
import { createWorktreeMergeTools } from "../core/worktree/merge.ts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";

function createHarness(
  options: { global?: string; project?: string | null; github?: boolean; conflict?: boolean } = {},
) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, merge_policy TEXT, github_repo TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, status TEXT, department_id TEXT, source_task_id TEXT,
      project_id TEXT, workflow_pack_key TEXT, project_path TEXT, created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0, completed_at INTEGER
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY, task_id TEXT, title TEXT, status TEXT, delegated_task_id TEXT,
      blocked_reason TEXT, completed_at INTEGER
    );
    INSERT INTO tasks (id, title, status, project_id) VALUES ('task-1', 'Implement policy', 'review', 'project-1');
  `);
  db.prepare("INSERT INTO projects VALUES ('project-1', ?, ?)").run(
    options.project ?? null,
    options.github ? "owner/repo" : null,
  );
  if (options.global) db.prepare("INSERT INTO settings VALUES ('mergePolicy', ?)").run(options.global);
  const info = { projectPath: "/project's checkout", worktreePath: "/isolated/task-1", branchName: "climpire/task-1" };
  const taskWorktrees = new Map([["task-1", info]]);
  const mergeWorktree = vi.fn(() =>
    options.conflict
      ? { success: false, message: "Conflict", conflicts: ["server.ts"] }
      : { success: true, message: "Merged locally" },
  );
  const cleanupWorktree = vi.fn(() => taskWorktrees.delete("task-1"));
  const appendTaskLog = vi.fn();
  const notifyCeo = vi.fn();
  const remoteMerge = vi.fn();
  const deps = {
    db,
    nowMs: () => 1000,
    broadcast: vi.fn(),
    appendTaskLog,
    getPreferredLanguage: () => "en",
    resolveLang: () => "en",
    l: (_ko: string[], en: string[]) => en[0],
    pickL: (value: string) => value,
    projectReviewGateNotifiedAt: new Map(),
    notifyCeo,
    taskWorktrees,
    mergeWorktree,
    mergeToDevAndCreatePR: remoteMerge,
    cleanupWorktree,
    findTeamLeader: () => null,
    getAgentDisplayName: () => "Leader",
    setTaskCreationAuditCompletion: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    notifyTaskStatus: vi.fn(),
    refreshCliUsageData: async () => ({}),
    shouldDeferTaskReportUntilPlanningArchive: () => false,
    emitTaskReportEvent: vi.fn(),
    formatTaskSubtaskProgressSummary: () => "",
    reviewRoundState: new Map(),
    reviewInFlight: new Set(),
    archivePlanningConsolidatedReport: vi.fn(),
    crossDeptNextCallbacks: new Map(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map(),
    startReviewConsensusMeeting: (_id: string, _title: string, _department: unknown, approve: () => void) => approve(),
  };
  const tools = createReviewFinalizeTools(deps);
  return { db, ...tools, taskWorktrees, mergeWorktree, cleanupWorktree, appendTaskLog, notifyCeo, remoteMerge, deps };
}

describe("approved task merge policy", () => {
  it.each([false, true])("keeps default auto merging local (GitHub project=%s)", (github) => {
    const h = createHarness({ github });
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      expect(h.mergeWorktree).toHaveBeenCalledWith("/project's checkout", "task-1");
      expect(h.remoteMerge).not.toHaveBeenCalled();
      expect(h.cleanupWorktree).toHaveBeenCalledOnce();
      expect(h.db.prepare("SELECT status FROM tasks").get()).toMatchObject({ status: "done" });
    } finally {
      h.db.close();
    }
  });

  it.each([
    { global: "manual", github: false, source: "global" },
    { global: "manual", github: true, source: "global" },
    { global: "auto", project: "manual", github: true, source: "project" },
  ])("retains approved branches without merging: %j", (options) => {
    const h = createHarness(options);
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      expect(h.db.prepare("SELECT status, completed_at FROM tasks").get()).toMatchObject({
        status: "done",
        completed_at: 1000,
      });
      expect(h.mergeWorktree).not.toHaveBeenCalled();
      expect(h.remoteMerge).not.toHaveBeenCalled();
      expect(h.cleanupWorktree).not.toHaveBeenCalled();
      expect(h.taskWorktrees.has("task-1")).toBe(true);
      const logs = h.appendTaskLog.mock.calls.map((call) => call[2]).join("\n");
      expect(logs).toContain(`Merge policy: manual (${options.source})`);
      expect(logs).toContain("branch retained: climpire/task-1");
      expect(logs).toContain("git -C '/project'\\''s checkout' merge -- 'climpire/task-1'");
      expect(logs).toContain("Merge now in task details");
    } finally {
      h.db.close();
    }
  });

  it("allows an explicit project auto override of global manual", () => {
    const h = createHarness({ global: "manual", project: "auto", github: true });
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      expect(h.mergeWorktree).toHaveBeenCalledOnce();
      expect(h.remoteMerge).not.toHaveBeenCalled();
    } finally {
      h.db.close();
    }
  });

  it("keeps a conflicted branch available for manual resolution", () => {
    const h = createHarness({ conflict: true });
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      expect(h.cleanupWorktree).not.toHaveBeenCalled();
      expect(h.taskWorktrees.has("task-1")).toBe(true);
      expect(h.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("server.ts"), "task-1");
      expect(h.db.prepare("SELECT status FROM tasks").get()).toMatchObject({ status: "done" });
    } finally {
      h.db.close();
    }
  });
});

describe("manual approval checkout isolation", () => {
  it.each([false, true])(
    "preserves real checkout, index, origin and pending work across approval and restart (GitHub=%s)",
    (github) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-manual-approval-"));
      const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
      const h = createHarness({ global: "manual", github });
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        git(repo, ["init", "-b", "dev"]);
        git(repo, ["config", "user.name", "Claw-Empire Test"]);
        git(repo, ["config", "user.email", "test@example.local"]);
        fs.writeFileSync(path.join(repo, "server.ts"), "export const reviewed = true;\n");
        git(repo, ["add", "server.ts"]);
        git(repo, ["commit", "-m", "seed"]);
        git(repo, ["remote", "add", "origin", "https://example.invalid/owner/repo.git"]);
        h.taskWorktrees.clear();
        const lifecycle = createWorktreeLifecycleTools({
          appendTaskLog: h.appendTaskLog,
          taskWorktrees: h.taskWorktrees,
        });
        const worktree = lifecycle.createWorktree(repo, "task-1", "Tester")!;
        fs.writeFileSync(path.join(worktree, "server.ts"), "export const reviewed = false;\n");
        git(worktree, ["add", "server.ts"]);
        fs.writeFileSync(path.join(worktree, "pending.ts"), "export const pending = true;\n");
        h.db.exec("ALTER TABLE tasks ADD COLUMN description TEXT");
        h.db.prepare("UPDATE tasks SET project_path = ?").run(repo);
        const checkoutState = () => ({
          head: git(repo, ["rev-parse", "HEAD"]),
          branch: git(repo, ["branch", "--show-current"]),
          status: git(repo, ["status", "--porcelain"]),
          index: git(repo, ["write-tree"]),
          origin: git(repo, ["remote", "get-url", "origin"]),
          server: fs.readFileSync(path.join(repo, "server.ts"), "utf8"),
        });
        const before = checkoutState();
        const worktreeStatus = git(worktree, ["status", "--porcelain"]);
        const localMerge = vi.fn(
          createWorktreeMergeTools({
            ...h.deps,
            cleanupWorktree: lifecycle.cleanupWorktree,
          }).mergeWorktree,
        );
        // Simulate process restart: approval must recover the retained task's real worktree.
        h.taskWorktrees.clear();
        const tools = createReviewFinalizeTools({
          ...h.deps,
          mergeWorktree: localMerge,
          cleanupWorktree: lifecycle.cleanupWorktree,
        });
        tools.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
        expect(checkoutState()).toEqual(before);
        expect(git(worktree, ["status", "--porcelain"])).toBe(worktreeStatus);
        expect(fs.readFileSync(path.join(worktree, "pending.ts"), "utf8")).toContain("pending = true");
        expect(h.taskWorktrees.get("task-1")?.branchName).toBe("climpire/task-1");
        expect(h.db.prepare("SELECT status FROM tasks").get()).toMatchObject({ status: "done" });
        expect(localMerge).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(h.appendTaskLog).toHaveBeenCalledWith(
          "task-1",
          "system",
          expect.stringContaining("branch retained: climpire/task-1"),
        );
      } finally {
        fetchSpy.mockRestore();
        h.db.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});
