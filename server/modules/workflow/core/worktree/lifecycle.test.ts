import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorktreeLifecycleTools,
  discoverTaskWorktree,
  discoverTaskWorktrees,
  recoverTaskWorktree,
  type WorktreeInfo,
} from "./lifecycle.ts";
import { resolveDirectiveRoot } from "./directive-branch.ts";
import { reuseWorktreeDependencies } from "./reuse-dependencies.ts";
import { integrateTaskBranch } from "./integrate.ts";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 15000 }).toString().trim();
}

function initRepo(basePrefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), basePrefix));
  try {
    runGit(dir, ["init", "-b", "main"]);
  } catch {
    runGit(dir, ["init"]);
    runGit(dir, ["checkout", "-B", "main"]);
  }
  runGit(dir, ["config", "user.name", "Claw-Empire Test"]);
  runGit(dir, ["config", "user.email", "claw-empire-test@example.local"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n", "utf8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "seed"]);
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree lifecycle branch collision handling", () => {
  it("reuses existing task branch when branch already exists", () => {
    const repo = initRepo("climpire-wt-reuse-");
    tempDirs.push(repo);
    const shortId = "reuse001";
    const taskId = `${shortId}-0000-0000-0000-000000000000`;
    runGit(repo, ["branch", `climpire/${shortId}`]);

    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();
    const info = taskWorktrees.get(taskId);
    expect(info?.branchName).toBe(`climpire/${shortId}`);
    expect(fs.existsSync(String(info?.worktreePath || ""))).toBe(true);

    tools.cleanupWorktree(repo, taskId);
    expect(taskWorktrees.has(taskId)).toBe(false);
  });

  it("reuses a registered task branch at a nonstandard path instead of creating a stale sibling", () => {
    const repo = initRepo("climpire-wt-fallback-");
    tempDirs.push(repo);
    const shortId = "fallback";
    const baseBranch = `climpire/${shortId}`;
    const occupiedPath = path.join(repo, ".occupied-worktree");
    runGit(repo, ["worktree", "add", occupiedPath, "-b", baseBranch, "HEAD"]);

    const taskId = `${shortId}-0000-0000-0000-000000000000`;
    const taskWorktrees = new Map();
    const tools = createWorktreeLifecycleTools({
      appendTaskLog: () => {},
      taskWorktrees,
    });

    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();
    const info = taskWorktrees.get(taskId);
    expect(fs.realpathSync(String(worktreePath))).toBe(fs.realpathSync(occupiedPath));
    expect(info?.branchName).toBe(baseBranch);
    expect(fs.realpathSync(recoverTaskWorktree(repo, taskId)!.worktreePath)).toBe(fs.realpathSync(occupiedPath));

    tools.cleanupWorktree(repo, taskId);
  });
});

function taskDatabase(records: Record<string, { source_task_id?: string | null; base_branch?: string | null }>) {
  return { prepare: () => ({ get: (id: string) => records[id] }) };
}

describe("directive worktree bases and revision reuse", () => {
  it("never recovers the project checkout as an agent worktree when a human checks out a task branch", () => {
    const repo = initRepo("climpire-project-checkout-guard-");
    tempDirs.push(repo);
    runGit(repo, ["checkout", "-b", "climpire/human"]);
    fs.writeFileSync(path.join(repo, "README.md"), "human unfinished edit\n");
    const taskWorktrees = new Map<string, WorktreeInfo>();
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    expect(recoverTaskWorktree(repo, "human")).toBeNull();
    expect(tools.createWorktree(repo, "human", "Tester")).toBeNull();
    expect(taskWorktrees.size).toBe(0);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("human unfinished edit\n");
    expect(runGit(repo, ["branch", "--show-current"])).toBe("climpire/human");
  });

  it("starts a directive at its root task's base branch without changing the project checkout", () => {
    const repo = initRepo("climpire-directive-base-");
    tempDirs.push(repo);
    runGit(repo, ["branch", "dev"]);
    fs.writeFileSync(path.join(repo, "head-only.txt"), "main branch work\n");
    runGit(repo, ["add", "head-only.txt"]);
    runGit(repo, ["commit", "-m", "main-only work"]);
    const head = runGit(repo, ["rev-parse", "HEAD"]);
    const taskWorktrees = new Map<string, WorktreeInfo>();
    const db = taskDatabase({ root: { base_branch: "dev" }, child: { source_task_id: "root" } });
    const tools = createWorktreeLifecycleTools({ db, appendTaskLog: () => {}, taskWorktrees });
    const worktree = tools.createWorktree(repo, "child", "Tester");
    expect(worktree).toBeTruthy();
    expect(runGit(String(worktree), ["rev-parse", "HEAD"])).toBe(runGit(repo, ["rev-parse", "dev"]));
    expect(taskWorktrees.get("child")).toMatchObject({ integrationBranch: "climpire/d-root", rootTaskId: "root" });
    expect(fs.existsSync(path.join(String(worktree), "head-only.txt"))).toBe(false);
    expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(runGit(repo, ["branch", "--show-current"])).toBe("main");
  });

  it("starts later subtasks from the current directive tip, including nested subtasks", () => {
    const repo = initRepo("climpire-directive-tip-");
    tempDirs.push(repo);
    const taskWorktrees = new Map<string, WorktreeInfo>();
    const db = taskDatabase({ root: {}, first: { source_task_id: "root" }, next: { source_task_id: "first" } });
    const tools = createWorktreeLifecycleTools({ db, appendTaskLog: () => {}, taskWorktrees });
    const first = String(tools.createWorktree(repo, "first", "Tester"));
    fs.writeFileSync(path.join(first, "sibling-fix.ts"), "export const fixed = true;\n");
    runGit(first, ["add", "sibling-fix.ts"]);
    runGit(first, ["commit", "-m", "first approved work"]);
    const approvedCommit = runGit(first, ["rev-parse", "HEAD"]);
    runGit(repo, ["update-ref", "refs/heads/climpire/d-root", approvedCommit]);
    const next = String(tools.createWorktree(repo, "next", "Tester"));
    expect(runGit(next, ["rev-parse", "HEAD"])).toBe(approvedCommit);
    expect(fs.readFileSync(path.join(next, "sibling-fix.ts"), "utf8")).toContain("fixed = true");
    expect(taskWorktrees.get("next")?.rootTaskId).toBe("root");
  });

  it("refuses an invalid explicit base instead of silently using HEAD", () => {
    const repo = initRepo("climpire-directive-invalid-");
    tempDirs.push(repo);
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees: new Map() });
    expect(tools.createWorktree(repo, "invalid", "Tester", "missing-branch")).toBeNull();
    expect(() => runGit(repo, ["show-ref", "--verify", "refs/heads/climpire/d-invalid"])).toThrow();
  });

  function revisionFixture() {
    const repo = initRepo("climpire-cumulative-revision-");
    tempDirs.push(repo);
    const taskWorktrees = new Map<string, WorktreeInfo>();
    const appendTaskLog = vi.fn();
    const db = taskDatabase({ root: {}, revision: { source_task_id: "root" }, sibling: { source_task_id: "root" } });
    const tools = createWorktreeLifecycleTools({ db, appendTaskLog, taskWorktrees });
    const revision = String(tools.createWorktree(repo, "revision", "Tester"));
    const sibling = String(tools.createWorktree(repo, "sibling", "Tester"));
    fs.writeFileSync(path.join(sibling, "approved.txt"), "approved sibling work\n");
    runGit(sibling, ["add", "approved.txt"]);
    runGit(sibling, ["commit", "-m", "sibling work"]);
    expect(integrateTaskBranch(repo, "climpire/d-root", "climpire/sibling").success).toBe(true);
    return { repo, taskWorktrees, appendTaskLog, tools, revision, sibling };
  }

  it("refreshes a reused revision from approved siblings while retaining its own commits and unstaged edits", () => {
    const { repo, tools, revision } = revisionFixture();
    const projectHead = runGit(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(revision, "own.txt"), "committed revision\n");
    runGit(revision, ["add", "own.txt"]);
    runGit(revision, ["commit", "-m", "revision work"]);
    const ownCommit = runGit(revision, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(revision, "README.md"), "unfinished tracked edit\n");
    fs.writeFileSync(path.join(revision, "unfinished.txt"), "unfinished new file\n");
    expect(tools.createWorktree(repo, "revision", "Tester")).toBe(revision);
    expect(fs.readFileSync(path.join(revision, "approved.txt"), "utf8")).toBe("approved sibling work\n");
    expect(fs.readFileSync(path.join(revision, "own.txt"), "utf8")).toBe("committed revision\n");
    expect(fs.readFileSync(path.join(revision, "README.md"), "utf8")).toBe("unfinished tracked edit\n");
    expect(fs.readFileSync(path.join(revision, "unfinished.txt"), "utf8")).toBe("unfinished new file\n");
    expect(runGit(revision, ["merge-base", "--is-ancestor", ownCommit, "HEAD"])).toBe("");
    expect(runGit(revision, ["merge-base", "--is-ancestor", "climpire/d-root", "HEAD"])).toBe("");
    expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(projectHead);
    const refreshedHead = runGit(revision, ["rev-parse", "HEAD"]);
    tools.createWorktree(repo, "revision", "Tester");
    expect(runGit(revision, ["rev-parse", "HEAD"])).toBe(refreshedHead);
  });

  it("recovers an orphaned legacy branch at a free path without losing commits or deleting an occupied directory", () => {
    const { repo, tools, revision, taskWorktrees } = revisionFixture();
    fs.writeFileSync(path.join(revision, "legacy.txt"), "retain legacy commit\n");
    runGit(revision, ["add", "legacy.txt"]);
    runGit(revision, ["commit", "-m", "legacy work"]);
    runGit(repo, ["worktree", "remove", revision, "--force"]);
    fs.mkdirSync(revision);
    fs.writeFileSync(path.join(revision, "unrelated.txt"), "retain occupied directory\n");
    taskWorktrees.clear();
    expect(tools.createWorktree(repo, "revision", "Tester")).toBe(`${revision}-1`);
    expect(taskWorktrees.get("revision")?.branchName).toBe("climpire/revision");
    expect(fs.readFileSync(path.join(`${revision}-1`, "approved.txt"), "utf8")).toContain("approved sibling");
    expect(fs.readFileSync(path.join(`${revision}-1`, "legacy.txt"), "utf8")).toContain("retain legacy");
    expect(fs.readFileSync(path.join(revision, "unrelated.txt"), "utf8")).toBe("retain occupied directory\n");
  });

  it("retains staged revision changes and reports that refresh needs owner action", () => {
    const { repo, tools, revision, appendTaskLog } = revisionFixture();
    fs.writeFileSync(path.join(revision, "staged.txt"), "staged revision\n");
    runGit(revision, ["add", "staged.txt"]);
    const before = runGit(revision, ["rev-parse", "HEAD"]);
    const index = runGit(revision, ["diff", "--cached"]);
    expect(tools.createWorktree(repo, "revision", "Tester")).toBe(revision);
    expect(runGit(revision, ["rev-parse", "HEAD"])).toBe(before);
    expect(runGit(revision, ["diff", "--cached"])).toBe(index);
    expect(appendTaskLog).toHaveBeenCalledWith(
      "revision",
      "system",
      expect.stringContaining("Staged revision changes retained"),
    );
  });

  it("leaves overlapping dirty files untouched rather than overwriting them during refresh", () => {
    const { repo, tools, revision, appendTaskLog } = revisionFixture();
    fs.writeFileSync(path.join(revision, "approved.txt"), "unfinished local file\n");
    const before = runGit(revision, ["rev-parse", "HEAD"]);
    expect(tools.createWorktree(repo, "revision", "Tester")).toBe(revision);
    expect(runGit(revision, ["rev-parse", "HEAD"])).toBe(before);
    expect(fs.readFileSync(path.join(revision, "approved.txt"), "utf8")).toBe("unfinished local file\n");
    expect(runGit(revision, ["ls-files", "--unmerged"])).toBe("");
    expect(appendTaskLog).toHaveBeenCalledWith(
      "revision",
      "system",
      expect.stringContaining("revision must reconcile climpire/d-root"),
    );
  });

  it("reports committed revision conflicts without moving refs or leaving a half-merged index", () => {
    const { repo, tools, revision, appendTaskLog } = revisionFixture();
    fs.writeFileSync(path.join(revision, "approved.txt"), "conflicting revision\n");
    runGit(revision, ["add", "approved.txt"]);
    runGit(revision, ["commit", "-m", "conflicting revision"]);
    const before = runGit(revision, ["rev-parse", "HEAD"]);
    const directive = runGit(repo, ["rev-parse", "climpire/d-root"]);
    expect(tools.createWorktree(repo, "revision", "Tester")).toBe(revision);
    expect(runGit(revision, ["rev-parse", "HEAD"])).toBe(before);
    expect(runGit(repo, ["rev-parse", "climpire/d-root"])).toBe(directive);
    expect(runGit(revision, ["ls-files", "--unmerged"])).toBe("");
    expect(appendTaskLog).toHaveBeenCalledWith(
      "revision",
      "system",
      expect.stringContaining("revision must reconcile climpire/d-root: approved.txt"),
    );
  });

  it("keeps overlapping unstaged edits when the directive changes the same tracked file", () => {
    const { repo, tools, revision, sibling } = revisionFixture();
    fs.writeFileSync(path.join(sibling, "README.md"), "approved README update\n");
    runGit(sibling, ["add", "README.md"]);
    runGit(sibling, ["commit", "-m", "update shared README"]);
    expect(integrateTaskBranch(repo, "climpire/d-root", "climpire/sibling").success).toBe(true);
    fs.writeFileSync(path.join(revision, "README.md"), "unfinished local README\n");
    const before = runGit(revision, ["rev-parse", "HEAD"]);
    const index = runGit(revision, ["write-tree"]);
    expect(tools.createWorktree(repo, "revision", "Tester")).toBe(revision);
    expect(runGit(revision, ["rev-parse", "HEAD"])).toBe(before);
    expect(runGit(revision, ["write-tree"])).toBe(index);
    expect(fs.readFileSync(path.join(revision, "README.md"), "utf8")).toBe("unfinished local README\n");
    expect(fs.existsSync(path.join(revision, "approved.txt"))).toBe(false);
  });

  it("preserves dirty revisions both during execution and after a server restart", () => {
    const repo = initRepo("climpire-directive-revision-");
    tempDirs.push(repo);
    const taskWorktrees = new Map<string, WorktreeInfo>();
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    const first = String(tools.createWorktree(repo, "revision", "Tester"));
    fs.writeFileSync(path.join(first, "unfinished.txt"), "retain my revision\n");
    expect(tools.createWorktree(repo, "revision", "Tester")).toBe(first);
    taskWorktrees.clear();
    expect(tools.createWorktree(repo, "revision", "Tester")).toBe(first);
    expect(fs.readFileSync(path.join(first, "unfinished.txt"), "utf8")).toBe("retain my revision\n");
  });

  it("retains a migrated legacy task worktree and never deletes an occupied task directory", () => {
    const repo = initRepo("climpire-directive-legacy-");
    tempDirs.push(repo);
    const legacy = path.join(repo, ".climpire-worktrees", "legacy");
    runGit(repo, ["worktree", "add", legacy, "-b", "climpire/legacy", "HEAD"]);
    fs.writeFileSync(path.join(legacy, "legacy-work.txt"), "pending revision\n");
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees: new Map() });
    expect(tools.createWorktree(repo, "legacy", "Tester")).toBe(legacy);
    expect(fs.readFileSync(path.join(legacy, "legacy-work.txt"), "utf8")).toContain("pending revision");
    const occupied = path.join(repo, ".climpire-worktrees", "occupied");
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, "do-not-delete.txt"), "retained\n");
    expect(tools.createWorktree(repo, "occupied", "Tester")).toBe(`${occupied}-1`);
    expect(fs.existsSync(path.join(occupied, "do-not-delete.txt"))).toBe(true);
  });

  it("recovers legacy review worktrees without creating a directive ref or touching dirty files", () => {
    const repo = initRepo("climpire-review-recovery-");
    tempDirs.push(repo);
    const taskId = "recovery";
    const legacy = path.join(repo, ".climpire-worktrees", taskId);
    runGit(repo, ["worktree", "add", legacy, "-b", `climpire/${taskId}`, "HEAD"]);
    fs.writeFileSync(path.join(legacy, "review-fix.txt"), "keep dirty review work\n");
    const db = taskDatabase({ root: {}, recovery: { source_task_id: "root" } });
    expect(recoverTaskWorktree(repo, taskId, db)).toEqual({
      projectPath: repo,
      worktreePath: legacy,
      branchName: `climpire/${taskId}`,
      rootTaskId: "root",
      integrationBranch: "climpire/d-root",
    });
    expect(fs.readFileSync(path.join(legacy, "review-fix.txt"), "utf8")).toContain("keep dirty review work");
    expect(() => runGit(repo, ["show-ref", "--verify", "refs/heads/climpire/d-root"])).toThrow();
    expect(recoverTaskWorktree(repo, "unknown")).toBeNull();
  });

  it("fails closed on cyclic task ancestry", () => {
    const db = taskDatabase({ first: { source_task_id: "second" }, second: { source_task_id: "first" } });
    expect(() => resolveDirectiveRoot("first", db)).toThrow("directive_task_ancestry_cycle");
  });
});

describe("isolated dependency reuse", () => {
  function dependencyFixture() {
    const repo = initRepo("climpire-dependency-reuse-");
    tempDirs.push(repo);
    const worktree = path.join(repo, "agent");
    fs.mkdirSync(worktree);
    for (const dir of [repo, worktree]) {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "test", dependencies: { library: "1" } }),
      );
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    }
    const installed = path.join(repo, "node_modules");
    fs.mkdirSync(path.join(installed, ".pnpm", "library", "node_modules", "library"), { recursive: true });
    fs.copyFileSync(path.join(repo, "pnpm-lock.yaml"), path.join(installed, ".pnpm", "lock.yaml"));
    fs.writeFileSync(path.join(installed, ".pnpm", "library", "node_modules", "library", "index.js"), "original\n");
    fs.symlinkSync(".pnpm/library/node_modules/library", path.join(installed, "library"));
    return { repo, worktree, installed };
  }

  it("reuses matching installs with separate writable files and relocates bin wrappers", () => {
    const { repo, worktree, installed } = dependencyFixture();
    fs.mkdirSync(path.join(installed, ".bin"));
    fs.writeFileSync(path.join(installed, ".bin", "library"), `#!/bin/sh\nnode '${installed}/library/index.js'\n`);
    expect(reuseWorktreeDependencies(repo, worktree)).toBe(true);
    const copied = path.join(worktree, "node_modules");
    expect(fs.readlinkSync(path.join(copied, "library"))).toBe(".pnpm/library/node_modules/library");
    fs.writeFileSync(path.join(copied, "library", "index.js"), "agent changed this\n");
    expect(fs.readFileSync(path.join(installed, "library", "index.js"), "utf8")).toBe("original\n");
    expect(fs.readFileSync(path.join(copied, ".bin", "library"), "utf8")).toContain(`${copied}/library/index.js`);
  });

  it("skips stale installations and changed dependency manifests", () => {
    const { repo, worktree, installed } = dependencyFixture();
    fs.writeFileSync(path.join(installed, ".pnpm", "lock.yaml"), "stale lock\n");
    expect(reuseWorktreeDependencies(repo, worktree)).toBe(false);
    fs.copyFileSync(path.join(repo, "pnpm-lock.yaml"), path.join(installed, ".pnpm", "lock.yaml"));
    fs.writeFileSync(
      path.join(worktree, "package.json"),
      JSON.stringify({ name: "test", dependencies: { library: "2" } }),
    );
    expect(reuseWorktreeDependencies(repo, worktree)).toBe(false);
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("rejects dependency symlinks outside the isolated install", () => {
    const { repo, worktree, installed } = dependencyFixture();
    fs.symlinkSync("../../README.md", path.join(installed, "outside"));
    expect(reuseWorktreeDependencies(repo, worktree)).toBe(false);
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
    expect(fs.readdirSync(worktree).some((name) => name.startsWith(".climpire-dependencies-"))).toBe(false);
  });

  it("can reuse an installed sibling worktree when the project has no dependencies installed", () => {
    const { repo, worktree } = dependencyFixture();
    const project = path.join(repo, "project-without-install");
    fs.mkdirSync(project);
    expect(reuseWorktreeDependencies(project, worktree, [repo])).toBe(true);
  });
});

describe("retained task worktree discovery", () => {
  it.each(["", "-2", "-12"])(
    "recovers the exact registered task branch with suffix '%s' without changing Git state",
    (suffix) => {
      const repo = initRepo("climpire-wt-discover-");
      tempDirs.push(repo);
      const taskId = "retained-0000-0000-0000-000000000000";
      const branchName = `climpire/${taskId.slice(0, 8)}${suffix}`;
      const worktreePath = path.join(repo, ".climpire-worktrees", `${taskId.slice(0, 8)}${suffix}`);
      runGit(repo, ["worktree", "add", worktreePath, "-b", branchName, "HEAD"]);
      const before = runGit(repo, ["worktree", "list", "--porcelain"]);
      const head = runGit(repo, ["rev-parse", "HEAD"]);

      expect(discoverTaskWorktree(repo, taskId)).toEqual({
        branchName,
        worktreePath: fs.realpathSync(worktreePath),
        projectPath: repo,
      });
      expect(discoverTaskWorktrees(repo, [taskId]).size).toBe(1);
      expect(runGit(repo, ["worktree", "list", "--porcelain"])).toBe(before);
      expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
    },
  );

  it("ignores similarly prefixed branches and worktrees outside the task directory", () => {
    const repo = initRepo("climpire-wt-ignore-");
    tempDirs.push(repo);
    const taskId = "retained-0000-0000-0000-000000000000";
    runGit(repo, ["worktree", "add", path.join(repo, ".occupied"), "-b", "climpire/retained", "HEAD"]);
    runGit(repo, [
      "worktree",
      "add",
      path.join(repo, ".climpire-worktrees", "retained-extra"),
      "-b",
      "climpire/retained-extra",
      "HEAD",
    ]);

    expect(discoverTaskWorktree(repo, taskId)).toBeUndefined();
  });

  it("reuses a retained worktree after restart and preserves uncommitted changes", () => {
    const repo = initRepo("climpire-wt-retain-");
    tempDirs.push(repo);
    const taskId = "retain01-0000-0000-0000-000000000000";
    const original = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees: new Map() });
    const worktreePath = original.createWorktree(repo, taskId, "Tester")!;
    const pendingFile = path.join(worktreePath, "pending.ts");
    fs.writeFileSync(pendingFile, "export const pending = true;\n", "utf8");
    const recoveredWorktrees = new Map();
    const restarted = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees: recoveredWorktrees });

    expect(fs.realpathSync(restarted.createWorktree(repo, taskId, "Tester")!)).toBe(fs.realpathSync(worktreePath));
    expect(fs.readFileSync(pendingFile, "utf8")).toBe("export const pending = true;\n");
    expect(recoveredWorktrees.get(taskId)?.branchName).toBe("climpire/retain01");
    expect(runGit(worktreePath, ["status", "--porcelain"])).toContain("pending.ts");
  });
});
