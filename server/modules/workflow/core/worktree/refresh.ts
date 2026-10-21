import { execFileSync } from "node:child_process";
import { prepareIntegrationCommit, type IntegrationResult } from "./integrate.ts";
import type { WorktreeInfo } from "./lifecycle.ts";

/** Refresh a retained task branch while preserving its commits and unfinished files. */
export function refreshTaskWorktree(info: WorktreeInfo): IntegrationResult {
  if (!info.integrationBranch) return { success: true };
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: info.worktreePath, stdio: "pipe", timeout: 30000 }).toString().trim();
  try {
    if (git(["symbolic-ref", "--short", "HEAD"]) !== info.branchName) {
      return { success: false, error: "Task worktree branch changed; retained without refreshing" };
    }
    const taskTip = git(["rev-parse", "HEAD"]);
    const directiveTip = git(["rev-parse", "--verify", `refs/heads/${info.integrationBranch}^{commit}`]);
    const prepared = prepareIntegrationCommit(
      info.projectPath,
      taskTip,
      directiveTip,
      `Refresh ${info.branchName} from ${info.integrationBranch}`,
    );
    if (!prepared.success || !prepared.commit) return prepared;
    if (prepared.commit === taskTip) return { success: true };
    // reset --keep preserves unstaged edits, but would reset staged entries.
    // Leave those intact for the owner to commit before retrying the refresh.
    if (git(["diff", "--cached", "--name-only", "-z"])) {
      return { success: false, error: "Staged revision changes retained; commit them before refreshing" };
    }
    // Git refuses overlapping edits and untracked-file collisions. No force,
    // stash, checkout of the project, or half-merged index is involved.
    git(["reset", "--keep", prepared.commit]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
