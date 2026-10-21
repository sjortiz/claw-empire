import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeLifecycleTools, type WorktreeInfo } from "./lifecycle.ts";
import { createWorktreeMergeTools } from "./merge.ts";
import { integrateTaskBranch } from "./integrate.ts";

const repos: string[] = [];
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
function fixture(rootId?: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "directive-integration-"));
  repos.push(repo);
  git(repo, ["init", "-b", "dev"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.local"]);
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, ["add", "shared.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  const taskWorktrees = new Map<string, WorktreeInfo>();
  const appendTaskLog = vi.fn();
  const db = {
    prepare: () => ({
      get: (id?: string) => ({
        title: "Task",
        description: "",
        source_task_id: rootId && id !== rootId ? rootId : null,
        base_branch: "dev",
      }),
    }),
  };
  const lifecycle = createWorktreeLifecycleTools({ db, taskWorktrees, appendTaskLog });
  const tools = createWorktreeMergeTools({
    db,
    taskWorktrees,
    appendTaskLog,
    cleanupWorktree: lifecycle.cleanupWorktree,
    resolveLang: () => "en",
    l: (...args: string[][]) => args,
    pickL: (strings: string[][]) => strings[1][0],
  });
  return { repo, taskWorktrees, lifecycle, tools };
}
afterEach(() => {
  for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
});

describe("directive integration", () => {
  it("integrates approved changes and leaves checkout, dirty files and dev unchanged", () => {
    const { repo, taskWorktrees, lifecycle, tools } = fixture();
    const task = "approved-0000-0000-0000-000000000000";
    const worktree = lifecycle.createWorktree(repo, task, "Coder", "dev")!;
    const before = git(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "shared.txt"), "CEO dirty checkout\n");
    fs.writeFileSync(path.join(worktree, "feature.ts"), "export const feature = true;\n");
    expect(tools.mergeWorktree(repo, task).success).toBe(true);
    const branch = taskWorktrees.get(task)!.integrationBranch!;
    expect(git(repo, ["show", `${branch}:feature.ts`])).toContain("feature = true");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("CEO dirty checkout\n");
    expect(git(repo, ["branch", "--show-current"])).toBe("dev");
    // Repeated approval stays local and idempotent.
    expect(tools.mergeWorktree(repo, task).success).toBe(true);
    lifecycle.cleanupWorktree(repo, task);
    expect(git(repo, ["show-ref", "--verify", `refs/heads/${branch}`])).toBeTruthy();
  });

  it("builds successive approved subtasks on one shared directive result", () => {
    const rootId = "root-directive";
    const { repo, taskWorktrees, lifecycle, tools } = fixture(rootId);
    const first = lifecycle.createWorktree(repo, "first-child", "Coder", "dev")!;
    fs.writeFileSync(path.join(first, "first.ts"), "export const first = true;\n");
    expect(tools.mergeWorktree(repo, "first-child").success).toBe(true);
    const branch = taskWorktrees.get("first-child")!.integrationBranch!;
    lifecycle.cleanupWorktree(repo, "first-child");
    const second = lifecycle.createWorktree(repo, "next-child", "Coder", "dev")!;
    expect(fs.readFileSync(path.join(second, "first.ts"), "utf8")).toContain("first = true");
    fs.writeFileSync(path.join(second, "second.ts"), "export const second = true;\n");
    expect(tools.mergeWorktree(repo, "next-child").success).toBe(true);
    expect(taskWorktrees.get("next-child")!.integrationBranch).toBe(branch);
    expect(git(repo, ["show", `${branch}:first.ts`])).toContain("first = true");
    expect(git(repo, ["show", `${branch}:second.ts`])).toContain("second = true");
    expect(git(repo, ["branch", "--list", "climpire/d-*"])).toBe(`climpire/d-${rootId}`);
    expect(fs.existsSync(path.join(repo, "first.ts"))).toBe(false);
  });

  it("reports conflicts without moving the integration ref or leaving a merge/index state", () => {
    const { repo, lifecycle, tools, taskWorktrees } = fixture();
    const task = "conflict-0000-0000-0000-000000000000";
    const worktree = lifecycle.createWorktree(repo, task, "Coder", "dev")!;
    const target = taskWorktrees.get(task)!.integrationBranch!;
    const sibling = path.join(repo, ".sibling");
    git(repo, ["worktree", "add", "-b", "sibling", sibling, target]);
    fs.writeFileSync(path.join(sibling, "shared.txt"), "sibling change\n");
    git(sibling, ["add", "shared.txt"]);
    git(sibling, ["commit", "-m", "sibling"]);
    expect(integrateTaskBranch(repo, target, "sibling").success).toBe(true);
    const before = git(repo, ["rev-parse", target]);
    fs.writeFileSync(path.join(worktree, "shared.txt"), "agent change\n");
    const result = tools.mergeWorktree(repo, task);
    expect(result.success).toBe(false);
    expect(result.conflicts).toEqual(["shared.txt"]);
    expect(git(repo, ["rev-parse", target])).toBe(before);
    expect(git(worktree, ["ls-files", "--unmerged"])).toBe("");
    expect(git(repo, ["ls-files", "--unmerged"])).toBe("");
    expect(fs.existsSync(path.join(worktree, "shared.txt"))).toBe(true);
    expect(lifecycle.createWorktree(repo, task, "Coder", "dev")).toBe(worktree);
    // Owner resolves in its retained worktree; re-approval integrates successfully.
    fs.writeFileSync(path.join(worktree, "shared.txt"), "sibling change\n");
    fs.writeFileSync(path.join(worktree, "resolved.ts"), "export const resolved = true;\n");
    expect(tools.mergeWorktree(repo, task).success).toBe(true);
  });

  it("refuses to update an integration branch checked out by a human", () => {
    const { repo } = fixture();
    git(repo, ["branch", "source"]);
    const result = integrateTaskBranch(repo, "dev", "source");
    expect(result.success).toBe(false);
    expect(result.error).toContain("checked out");
  });
});
