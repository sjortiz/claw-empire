import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoordinationDb } from "../agent-coordination-fixture.ts";
import { buildRelatedWorkContext } from "../../modules/workflow/core/related-work.ts";

describe("QA acceptance: real local Git related-work snapshot", () => {
  let db: DatabaseSync;
  let repo: string;
  let worktree: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  beforeEach(() => {
    db = createCoordinationDb();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "qa-related-work-"));
    worktree = path.join(repo, "peer-worktree");
    git("init", "--initial-branch=dev");
    git("config", "user.name", "QA Fixture");
    git("config", "user.email", "qa@example.invalid");
    git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "--no-gpg-sign", "-m", "fixture base");
    git("worktree", "add", "-b", "climpire/target-1", worktree);
    for (let index = 0; index < 2; index++) {
      execFileSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "--no-gpg-sign", "-m", `fixture change ${index}`],
        {
          cwd: worktree,
          stdio: "pipe",
        },
      );
    }
    db.prepare("UPDATE tasks SET project_path=?,base_branch='dev' WHERE project_id='project'").run(repo);
    db.exec("UPDATE tasks SET status='done',result='Reuse the peer implementation.' WHERE id='target'");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("discovers a suffixed completed branch after restart and counts commits against its base", () => {
    const context = buildRelatedWorkContext(db, "source");
    expect(context).toContain("Scoped tests | Beta / Development | done");
    expect(context).toContain("branch: climpire/target-1; commits ahead of base: 2");
    expect(context).toContain("latest report: Reuse the peer implementation.");
    expect(context).not.toContain("Scoped implementation");
    expect(context).not.toContain("Other work");
  });

  it("does not count dirty files as commits or change either worktree", () => {
    fs.writeFileSync(path.join(worktree, "unfinished.txt"), "keep this work");
    const before = git("status", "--porcelain");
    const head = git("-C", worktree, "rev-parse", "HEAD");
    const context = buildRelatedWorkContext(db, "source", "en", {
      taskWorktrees: new Map([
        ["target", { projectPath: repo, worktreePath: worktree, branchName: "climpire/target-1" }],
      ]),
    });
    expect(context).toContain("commits ahead of base: 2");
    expect(git("status", "--porcelain")).toBe(before);
    expect(git("-C", worktree, "rev-parse", "HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(worktree, "unfinished.txt"), "utf8")).toBe("keep this work");
  });
});
