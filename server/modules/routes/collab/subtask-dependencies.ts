import type { DatabaseSync } from "node:sqlite";

export function parseSubtaskDependencies(value: unknown): string[] | null {
  if (value == null) return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || !id.trim())) return null;
  return [...new Set(parsed.map((id: string) => id.trim()))];
}

export function hasUnfinishedDependencies(
  db: Pick<DatabaseSync, "prepare">,
  subtask: { task_id: string; depends_on?: unknown },
): boolean {
  const ids = parseSubtaskDependencies(subtask.depends_on);
  if (!ids) return true;
  return ids.some((id) => {
    const prerequisite = db
      .prepare("SELECT status, delegated_task_id FROM subtasks WHERE id = ? AND task_id = ?")
      .get(id, subtask.task_id) as { status: string; delegated_task_id: string | null } | undefined;
    if (!prerequisite || prerequisite.status !== "done") return true;
    if (!prerequisite.delegated_task_id) {
      const owner = db.prepare("SELECT status FROM tasks WHERE id = ?").get(subtask.task_id) as
        | { status: string }
        | undefined;
      return owner?.status !== "done";
    }
    const delegated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(prerequisite.delegated_task_id) as
      | { status: string }
      | undefined;
    return delegated?.status !== "done";
  });
}

export function validateSubtaskDependencies(
  db: Pick<DatabaseSync, "prepare">,
  taskId: string,
  subtaskId: string,
  ids: string[],
): boolean {
  const visited = new Set<string>();
  const visitsSelf = (id: string): boolean => {
    if (id === subtaskId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const row = db
      .prepare("SELECT depends_on, target_department_id, delegated_task_id FROM subtasks WHERE id = ? AND task_id = ?")
      .get(id, taskId) as
      | { depends_on: unknown; target_department_id: string | null; delegated_task_id: string | null }
      | undefined;
    // Root-local legacy items cannot satisfy code dependencies until the root
    // integrates, which would deadlock its own children. Use a delegated item.
    if (!row || (!row.target_department_id && !row.delegated_task_id)) return true;
    const dependencies = parseSubtaskDependencies(row.depends_on);
    return !dependencies || dependencies.some(visitsSelf);
  };
  return !ids.some(visitsSelf);
}
