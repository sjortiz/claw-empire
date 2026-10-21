import fs from "node:fs";
import { createPersistentWait } from "./persistent-wait.ts";
import { isTaskAutoRecoveryHeld } from "./task-recovery-control.ts";
import { recoverTaskWorktree } from "./worktree/lifecycle.ts";

const QUEUED = "Run recovery queued:";
const RETRY = "Automatic run retry: 1/1";
const waits = new WeakMap<object, ReturnType<typeof createPersistentWait>>();
function waiting(deps: any) {
  let wait = waits.get(deps.db);
  if (!wait) {
    wait = createPersistentWait(deps);
    waits.set(deps.db, wait);
  }
  return wait;
}

export function isRunRecoveryHeld(deps: any, task: any): boolean {
  if (isTaskAutoRecoveryHeld(deps, task.id)) return true;
  // A stopped directive must not be resurrected through one of its parts.
  const seen = new Set<string>([task.id]);
  while (task.source_task_id) {
    if (seen.has(task.source_task_id)) return true;
    seen.add(task.source_task_id);
    task = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.source_task_id);
    if (!task || ["cancelled", "done", "inbox"].includes(task.status) || isTaskAutoRecoveryHeld(deps, task.id))
      return true;
  }
  return false;
}

export function latestTaskRunEvent(db: any, taskId: string): string {
  return (
    db
      .prepare(
        `SELECT message FROM task_logs WHERE task_id = ? AND
      (message LIKE 'RUN start%' OR message LIKE 'RUN completed%' OR message LIKE 'RUN failed%'
       OR message LIKE 'Agent spawn failed:%' OR message LIKE 'Run recovery queued:%')
      ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId)?.message ?? ""
  );
}

// Older servers wrote a synthetic failure when replaying an unfinished run.
// Recover those Inbox tasks only with that explicit evidence, never real failures.
export function isInterruptedTaskRun(db: any, taskId: string): boolean {
  const event = latestTaskRunEvent(db, taskId);
  if (event.startsWith("RUN start")) return true;
  if (!event.startsWith("RUN failed")) return false;
  const runs = db
    .prepare(
      "SELECT rowid AS run_rowid, message FROM task_logs WHERE task_id = ? AND (message LIKE 'RUN start%' OR message LIKE 'RUN completed%' OR message LIKE 'RUN failed%' OR message LIKE 'Agent spawn failed:%') ORDER BY rowid DESC LIMIT 2",
    )
    .all(taskId);
  if (!runs[1]?.message.startsWith("RUN start")) return false;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM task_logs WHERE task_id = ? AND rowid > ? AND rowid < ? AND message LIKE 'Recovery (%): orphan in_progress detected%replaying failed completion' LIMIT 1",
      )
      .get(taskId, runs[1].run_rowid, runs[0].run_rowid),
  );
}

export function hasAutomaticRunRetry(db: any, taskId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM task_logs WHERE task_id = ? AND message LIKE ? LIMIT 1").get(taskId, `${RETRY}%`),
  );
}

// Queue + retry claim share a transaction. Neither a lost timer nor a restart
// can grant a second failure retry. The existing task log is the durable state.
export function queueTaskRunRecovery(deps: any, taskId: string, reason: string, exitCode?: number): boolean {
  const task = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (
    !task ||
    deps.activeProcesses.has(taskId) ||
    !["in_progress", "inbox"].includes(task.status) ||
    isRunRecoveryHeld(deps, task)
  )
    return false;
  if (exitCode !== undefined && hasAutomaticRunRetry(deps.db, taskId)) return false;
  deps.db.exec("SAVEPOINT queue_run_recovery");
  try {
    if (exitCode !== undefined) deps.appendTaskLog(taskId, "system", `${RETRY} (exit code: ${exitCode})`);
    deps.db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(deps.nowMs(), taskId);
    deps.appendTaskLog(taskId, "system", `${QUEUED} ${reason}`);
    deps.db.exec("RELEASE queue_run_recovery");
  } catch (error) {
    deps.db.exec("ROLLBACK TO queue_run_recovery; RELEASE queue_run_recovery");
    throw error;
  }
  deps.stopProgressTimer?.(taskId);
  // Release only this run's reservation, never the owner's other work.
  deps.db
    .prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ? AND current_task_id = ?")
    .run(task.assigned_agent_id, taskId);
  if (task.assigned_agent_id)
    deps.broadcast("agent_status", deps.db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id));
  deps.broadcast("task_update", deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
  return true;
}

export function resumeQueuedTaskRun(deps: any, taskId: string): boolean {
  const task = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task || task.status !== "planned" || deps.activeProcesses.has(taskId) || isRunRecoveryHeld(deps, task))
    return false;
  const event = latestTaskRunEvent(deps.db, taskId);
  if (!event.startsWith(QUEUED)) return false;
  const agent = deps.db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
  if (
    !agent ||
    !["idle", "break"].includes(agent.status) ||
    (agent.current_task_id && agent.current_task_id !== taskId) ||
    deps.db
      .prepare("SELECT 1 FROM tasks WHERE assigned_agent_id = ? AND id != ? AND status = 'in_progress' LIMIT 1")
      .get(task.assigned_agent_id, taskId)
  ) {
    waiting(deps).wait(
      taskId,
      "run-owner",
      `Run recovery waiting for assigned agent ${task.assigned_agent_id ?? "unassigned"} (${agent?.status ?? "missing"}; current_task=${agent?.current_task_id ?? "none"})`,
      () => resumeQueuedTaskRun(deps, taskId),
    );
    return false;
  }
  waiting(deps).clear(taskId, "run-owner");
  const projectPath = deps.resolveProjectPath?.(task) ?? task.project_path;
  const remembered = deps.taskWorktrees.get(taskId);
  const worktree =
    remembered && fs.existsSync(remembered.worktreePath)
      ? remembered
      : projectPath
        ? recoverTaskWorktree(projectPath, taskId, deps.db)
        : null;
  if (!worktree || !fs.existsSync(worktree.worktreePath)) {
    waiting(deps).wait(taskId, "run-worktree", "Run recovery waiting for its retained worktree", () =>
      resumeQueuedTaskRun(deps, taskId),
    );
    return false;
  }
  deps.taskWorktrees.set(taskId, worktree);
  waiting(deps).clear(taskId, "run-worktree");
  const reason = event.slice(QUEUED.length).trim();
  deps.appendTaskLog(
    taskId,
    "system",
    reason.startsWith("Recovery (")
      ? `${reason}; resuming in ${worktree.worktreePath}`
      : `${reason}; retrying in ${worktree.worktreePath}`,
  );
  deps.startTaskExecutionForAgent(
    taskId,
    agent,
    agent.department_id ?? task.department_id,
    agent.department_id ? deps.getDeptName(agent.department_id, task.workflow_pack_key) : "Unassigned",
    {
      reuseWorktree: true,
      recoveryNote: `${reason}. Continue the previous task in this existing worktree and branch; all prior changes are kept.`,
    },
  );
  return true;
}

export function hasLiveTaskRunProcess(deps: any, taskId: string): boolean {
  const row = deps.db
    .prepare(
      `SELECT message FROM task_logs WHERE task_id = ? AND
    (message LIKE 'Run process: pid=%' OR message LIKE 'RUN start%' OR message LIKE 'RUN completed%' OR message LIKE 'RUN failed%')
    ORDER BY rowid DESC LIMIT 1`,
    )
    .get(taskId);
  const pid = /^Run process: pid=(\d+)$/.exec(row?.message ?? "");
  return Boolean(pid && deps.isPidAlive(Number(pid[1])));
}

// Also reconstruct queued children: the ready-root sweep intentionally skips them.
export function sweepQueuedTaskRuns(deps: any, reason: string): void {
  const tasks = deps.db.prepare("SELECT * FROM tasks WHERE status IN ('planned','inbox') ORDER BY updated_at").all();
  for (const task of tasks) {
    if (deps.activeProcesses.has(task.id) || isRunRecoveryHeld(deps, task)) continue;
    if (task.status === "inbox" && isInterruptedTaskRun(deps.db, task.id) && !hasLiveTaskRunProcess(deps, task.id)) {
      queueTaskRunRecovery(deps, task.id, `Recovery (${reason}): run interrupted by a restart`);
    }
    resumeQueuedTaskRun(deps, task.id);
  }
}
