import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeLifecycleTools, discoverTaskWorktree, discoverTaskWorktrees } from "./lifecycle.ts";

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

  it("falls back to suffixed branch when existing branch is occupied in another worktree", () => {
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
    expect(info?.branchName.startsWith(baseBranch)).toBe(true);
    expect(info?.branchName).not.toBe(baseBranch);

    tools.cleanupWorktree(repo, taskId);
    runGit(repo, ["worktree", "remove", occupiedPath, "--force"]);
    runGit(repo, ["branch", "-D", baseBranch]);
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

    expect(restarted.createWorktree(repo, taskId, "Tester")).toBe(fs.realpathSync(worktreePath));
    expect(fs.readFileSync(pendingFile, "utf8")).toBe("export const pending = true;\n");
    expect(recoveredWorktrees.get(taskId)?.branchName).toBe("climpire/retain01");
    expect(runGit(worktreePath, ["status", "--porcelain"])).toContain("pending.ts");
  });
});
