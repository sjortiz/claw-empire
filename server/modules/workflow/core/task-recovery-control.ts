import { hasExhaustedWait } from "./persistent-wait.ts";

const shuttingDown = new WeakSet<object>();

export function holdRecoveryDuringShutdown(activeProcesses: object): void {
  shuttingDown.add(activeProcesses);
}

export function isTaskAutoRecoveryHeld(deps: any, taskId: string): boolean {
  if (shuttingDown.has(deps.activeProcesses)) return true;
  if (deps.stopRequestedTasks?.has(taskId) || hasExhaustedWait(deps.db, taskId)) return true;
  const task = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (task?.planning_attention_reason) return true;
  const control = deps.db
    .prepare(
      `SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system'
    AND (message LIKE 'PAUSE_BREAK%' OR message LIKE 'STOP%' OR message LIKE 'RUN start%' OR message LIKE 'RESUME:%' OR message LIKE '%action=apply_review_pick%')
    ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(taskId);
  return /^(PAUSE_BREAK|STOP)/.test(String(control?.message ?? ""));
}
