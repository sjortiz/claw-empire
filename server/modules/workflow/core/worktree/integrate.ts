import { execFileSync, spawnSync } from "node:child_process";

export type IntegrationResult = { success: boolean; conflicts?: string[]; error?: string };

/** Prepare a cumulative commit without changing any refs, files, or index. */
export function prepareIntegrationCommit(
  projectPath: string,
  targetTip: string,
  sourceTip: string,
  message: string,
): IntegrationResult & { commit?: string } {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: projectPath, stdio: "pipe", timeout: 30000 }).toString().trim();
  try {
    const isAncestor = (ancestor: string, descendant: string) => {
      const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd: projectPath,
        encoding: "utf8",
        timeout: 10000,
      });
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(result.error?.message || result.stderr || "git merge-base failed");
      }
      return result.status === 0;
    };
    if (isAncestor(sourceTip, targetTip)) return { success: true, commit: targetTip };
    if (isAncestor(targetTip, sourceTip)) return { success: true, commit: sourceTip };
    const merge = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "-z", targetTip, sourceTip], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const [tree, ...details] = (merge.stdout ?? "").split("\0");
    if (merge.status === 1) {
      const end = details.indexOf("");
      return { success: false, conflicts: details.slice(0, end < 0 ? undefined : end).filter(Boolean) };
    }
    if (merge.status !== 0 || !/^[a-f0-9]{40,64}$/.test(tree)) {
      return { success: false, error: merge.error?.message || merge.stderr || "git merge-tree failed" };
    }
    const commit = git([
      "-c",
      "user.name=Claw-Empire",
      "-c",
      "user.email=claw-empire@local",
      "commit-tree",
      tree,
      "-p",
      targetTip,
      "-p",
      sourceTip,
      "-m",
      message,
    ]);
    return { success: true, commit };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Merge objects and advance only the integration ref. No checkout or index is involved,
// so conflicts cannot leave either the project or the agent half-merged.
export function integrateTaskBranch(projectPath: string, target: string, source: string): IntegrationResult {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: projectPath, stdio: "pipe", timeout: 30000 }).toString().trim();
  try {
    const targetRef = `refs/heads/${target}`;
    if (git(["worktree", "list", "--porcelain"]).split("\n").includes(`branch ${targetRef}`)) {
      return { success: false, error: `Integration branch is checked out: ${target}` };
    }
    const sourceTip = git(["rev-parse", "--verify", `refs/heads/${source}^{commit}`]);
    // Compare-and-swap protects concurrent approvals, including another server process.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const targetTip = git(["rev-parse", "--verify", `${targetRef}^{commit}`]);
      const prepared = prepareIntegrationCommit(
        projectPath,
        targetTip,
        sourceTip,
        `Integrate ${source} into ${target}`,
      );
      if (!prepared.success || !prepared.commit) return prepared;
      if (prepared.commit === targetTip) return { success: true };
      try {
        git(["update-ref", "-m", `Integrate ${source}`, targetRef, prepared.commit, targetTip]);
        return { success: true };
      } catch {
        if (git(["rev-parse", targetRef]) === targetTip) throw new Error("Integration ref update failed");
      }
    }
    return { success: false, error: "Integration branch changed during approval; retry integration" };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
