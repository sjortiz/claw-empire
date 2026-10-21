import { execFileSync } from "node:child_process";

export type DirectiveTaskDatabase = {
  prepare: (sql: string) => { get: (...params: string[]) => unknown };
};

export function resolveDirectiveRoot(taskId: string, db?: DirectiveTaskDatabase) {
  let rootTaskId = taskId;
  let baseBranch: string | undefined;
  const visited = new Set<string>();
  while (db) {
    if (visited.has(rootTaskId)) throw new Error("directive_task_ancestry_cycle");
    visited.add(rootTaskId);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(rootTaskId) as
      | { source_task_id?: string | null; base_branch?: string | null }
      | undefined;
    if (!task) break;
    baseBranch = task.base_branch?.trim() || undefined;
    if (!task.source_task_id) break;
    rootTaskId = task.source_task_id;
  }
  return { rootTaskId, baseBranch };
}

/** Create a ref only; never check out or alter the project's index or working tree. */
export function ensureDirectiveBranch(
  projectPath: string,
  taskId: string,
  db?: DirectiveTaskDatabase,
  baseBranch?: string,
) {
  const root = resolveDirectiveRoot(taskId, db);
  const integrationBranch = `climpire/d-${root.rootTaskId}`;
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: projectPath, stdio: "pipe", timeout: 5000 }).toString().trim();
  const ref = `refs/heads/${integrationBranch}`;
  try {
    git(["show-ref", "--verify", ref]);
    return { integrationBranch, rootTaskId: root.rootTaskId };
  } catch {
    // New directives start from the configured base. Invalid explicit bases fail closed.
  }
  const base = git([
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${root.baseBranch || baseBranch || "HEAD"}^{commit}`,
  ]);
  try {
    git(["branch", integrationBranch, base]);
  } catch (error) {
    // A concurrent department may have created the same directive ref first.
    try {
      git(["show-ref", "--verify", ref]);
    } catch {
      throw error;
    }
  }
  return { integrationBranch, rootTaskId: root.rootTaskId };
}
