import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoCommitWorktreePendingChanges } from "./shared.ts";

const repositories: string[] = [];

function createRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-auto-commit-"));
  repositories.push(repository);
  execFileSync("git", ["init", "-b", "dev"], { cwd: repository, stdio: "pipe" });
  return repository;
}

function writeFile(repository: string, relative: string, content = "generated"): void {
  const target = path.join(repository, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) fs.rmSync(repository, { recursive: true, force: true });
});

describe("worktree pending changes", () => {
  it("ignores untracked tool state, dependency caches, and gitignored paths while committing source", () => {
    const repository = createRepository();
    writeFile(repository, ".gitignore", "generated/\n");
    writeFile(repository, "generated/output.data");
    writeFile(repository, ".serena/project.yml");
    writeFile(repository, ".claude/skills/helper.md");
    writeFile(repository, "node_modules/package/index.js");
    writeFile(repository, "src/feature.ts", "export const feature = true;\n");
    const result = autoCommitWorktreePendingChanges(
      "task-1",
      { worktreePath: repository, branchName: "climpire/task-1" },
      vi.fn(),
    );
    expect(result).toMatchObject({ committed: true, error: null, restrictedUntrackedCount: 0 });
    const committed = execFileSync("git", ["ls-tree", "--name-only", "-r", "HEAD"], { cwd: repository }).toString();
    expect(committed.trim().split("\n")).toEqual([".gitignore", "src/feature.ts"]);
  });

  it("does not block approval when only tool or cache folders remain", () => {
    const repository = createRepository();
    writeFile(repository, ".serena/project.yml");
    writeFile(repository, ".cache/runtime.data");
    expect(
      autoCommitWorktreePendingChanges("task-2", { worktreePath: repository, branchName: "climpire/task-2" }, vi.fn()),
    ).toMatchObject({ committed: false, error: null, restrictedUntrackedCount: 0 });
  });

  it("still blocks secret files instead of treating them as harmless tool state", () => {
    const repository = createRepository();
    writeFile(repository, ".env", "API_KEY=private");
    writeFile(repository, "private.key", "private");
    const result = autoCommitWorktreePendingChanges(
      "task-3",
      { worktreePath: repository, branchName: "climpire/task-3" },
      vi.fn(),
    );
    expect(result).toMatchObject({ committed: false, errorKind: "restricted_untracked", restrictedUntrackedCount: 2 });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repository }).toString()).toBe("");
  });
});
