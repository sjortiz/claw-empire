import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktreeLifecycleTools } from "../core/worktree/lifecycle.ts";
import { createWorktreeMergeTools } from "../core/worktree/merge.ts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

// A real repository whose path needs shell quoting, with an existing directive branch.
function createProjectRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-merge-policy-"));
  const repo = path.join(root, "project's checkout");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "dev"]);
  git(repo, ["config", "user.name", "Claw-Empire Test"]);
  git(repo, ["config", "user.email", "test@example.local"]);
  fs.writeFileSync(path.join(repo, "server.ts"), "export const reviewed = true;\n");
  git(repo, ["add", "server.ts"]);
  git(repo, ["commit", "-m", "seed"]);
  return repo;
}

function createHarness(
  options: {
    global?: string;
    project?: string | null;
    github?: boolean;
    conflict?: boolean;
    child?: boolean;
    repo?: string;
  } = {},
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
  if (options.child) db.prepare("UPDATE tasks SET source_task_id = 'root-1'").run();
  db.prepare("INSERT INTO projects VALUES ('project-1', ?, ?)").run(
    options.project ?? null,
    options.github ? "owner/repo" : null,
  );
  if (options.global) db.prepare("INSERT INTO settings VALUES ('mergePolicy', ?)").run(options.global);
  const repo = options.repo ?? createProjectRepo();
  const directiveBranch = options.child ? "climpire/d-root-1" : "climpire/d-task-1";
  if (!options.repo) git(repo, ["branch", directiveBranch]);
  const info = { projectPath: repo, worktreePath: "/isolated/task-1", branchName: "climpire/task-1" };
  const taskWorktrees = new Map([["task-1", info]]);
  const mergeWorktree = vi.fn(() => ({ success: true, message: "Integrated" }));
  const mergeIntoCheckout = vi.fn(() =>
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
    mergeIntoCheckout,
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
  const close = () => {
    db.close();
    if (!options.repo) fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  };
  return {
    db,
    ...tools,
    repo,
    close,
    taskWorktrees,
    mergeWorktree,
    mergeIntoCheckout,
    cleanupWorktree,
    appendTaskLog,
    notifyCeo,
    remoteMerge,
    deps,
  };
}

describe("approved task merge policy", () => {
  it.each([false, true])("merges the completed directive locally by default (GitHub project=%s)", (github) => {
    const h = createHarness({ github });
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      // Approval integrates into the directive branch; the policy then applies to that branch.
      expect(h.mergeWorktree).toHaveBeenCalledWith(h.repo, "task-1");
      expect(h.cleanupWorktree).toHaveBeenCalledOnce();
      expect(h.mergeIntoCheckout).toHaveBeenCalledExactlyOnceWith(h.repo, "task-1", "climpire/d-task-1");
      expect(h.remoteMerge).not.toHaveBeenCalled();
      expect(h.db.prepare("SELECT status FROM tasks").get()).toMatchObject({ status: "done" });
    } finally {
      h.close();
    }
  });

  it.each([
    { global: "manual", github: false, source: "global" },
    { global: "manual", github: true, source: "global" },
    { global: "auto", project: "manual", github: true, source: "project" },
  ])("keeps the directive branch without merging the checkout: %j", (options) => {
    const h = createHarness(options);
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      expect(h.db.prepare("SELECT status, completed_at FROM tasks").get()).toMatchObject({
        status: "done",
        completed_at: 1000,
      });
      expect(h.mergeWorktree).toHaveBeenCalledOnce();
      expect(h.mergeIntoCheckout).not.toHaveBeenCalled();
      expect(h.remoteMerge).not.toHaveBeenCalled();
      const logs = h.appendTaskLog.mock.calls.map((call) => call[2]).join("\n");
      expect(logs).toContain(`Merge policy: manual (${options.source})`);
      expect(logs).toContain("Directive branch not merged into the checkout: climpire/d-task-1");
      expect(logs).toContain(`git -C '${h.repo.replaceAll("'", "'\\''")}' merge -- 'climpire/d-task-1'`);
      expect(logs).toContain("Merge now in task details");
    } finally {
      h.close();
    }
  });

  it("allows an explicit project auto override of global manual", () => {
    const h = createHarness({ global: "manual", project: "auto", github: true });
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      expect(h.mergeIntoCheckout).toHaveBeenCalledOnce();
      expect(h.remoteMerge).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });

  it("only integrates child tasks; the checkout is merged when the root completes", () => {
    const h = createHarness({ child: true });
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      expect(h.mergeWorktree).toHaveBeenCalledOnce();
      expect(h.mergeIntoCheckout).not.toHaveBeenCalled();
      expect(h.db.prepare("SELECT status FROM tasks").get()).toMatchObject({ status: "done" });
    } finally {
      h.close();
    }
  });

  it("keeps the directive branch when merging it into the checkout conflicts", () => {
    const h = createHarness({ conflict: true });
    try {
      h.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
      expect(h.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("server.ts"), "task-1");
      expect(git(h.repo, ["branch", "--list", "climpire/d-task-1"])).toContain("climpire/d-task-1");
      expect(h.db.prepare("SELECT status FROM tasks").get()).toMatchObject({ status: "done" });
    } finally {
      h.close();
    }
  });
});

describe("manual approval checkout isolation", () => {
  it.each([false, true])(
    "integrates into the directive branch and leaves the real checkout, index and origin untouched (GitHub=%s)",
    (github) => {
      const repo = createProjectRepo();
      git(repo, ["remote", "add", "origin", "https://example.invalid/owner/repo.git"]);
      const h = createHarness({ global: "manual", github, repo });
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
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
          // The task worktree directory is removed after integration.
          status: git(repo, ["status", "--porcelain"]).replace("?? .climpire-worktrees/\n", ""),
          index: git(repo, ["write-tree"]),
          origin: git(repo, ["remote", "get-url", "origin"]),
          server: fs.readFileSync(path.join(repo, "server.ts"), "utf8"),
        });
        const before = checkoutState();
        const mergeTools = createWorktreeMergeTools({ ...h.deps, cleanupWorktree: lifecycle.cleanupWorktree });
        const mergeIntoCheckout = vi.fn(mergeTools.mergeIntoCheckout);
        // Simulate process restart: approval must recover the task's real worktree.
        h.taskWorktrees.clear();
        const tools = createReviewFinalizeTools({
          ...h.deps,
          mergeWorktree: mergeTools.mergeWorktree,
          mergeIntoCheckout,
          cleanupWorktree: lifecycle.cleanupWorktree,
        });
        tools.finishReview("task-1", "Implement policy", { bypassProjectDecisionGate: true });
        expect(checkoutState()).toEqual(before);
        expect(git(repo, ["show", "climpire/d-task-1:server.ts"])).toContain("reviewed = false");
        expect(git(repo, ["show", "climpire/d-task-1:pending.ts"])).toContain("pending = true");
        expect(h.db.prepare("SELECT status FROM tasks").get()).toMatchObject({ status: "done" });
        expect(mergeIntoCheckout).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(h.appendTaskLog).toHaveBeenCalledWith(
          "task-1",
          "system",
          expect.stringContaining("Directive branch not merged into the checkout: climpire/d-task-1"),
        );
      } finally {
        fetchSpy.mockRestore();
        h.close();
        fs.rmSync(path.dirname(repo), { recursive: true, force: true });
      }
    },
  );
});
