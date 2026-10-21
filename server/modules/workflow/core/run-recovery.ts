import fs from "node:fs";
import path from "node:path";
import { recoverTaskWorktree } from "./worktree/lifecycle.ts";
import { isTaskAutoRecoveryHeld, resumeTaskExecution } from "./task-resume.ts";
import { createPersistentWait } from "./persistent-wait.ts";
import { notifyTaskStatus } from "../../../gateway/client.ts";

const QUEUED_PREFIX = "Run recovery queued: ";
const worktreeWaits = new WeakMap<object, ReturnType<typeof createPersistentWait>>();
function worktreeWait(deps: any) {
  let wait = worktreeWaits.get(deps.db);
  if (!wait) {
    wait = createPersistentWait(deps);
    worktreeWaits.set(deps.db, wait);
  }
  return wait;
}

type RecoveryReason = "startup" | "interval";

function latestRun(db: any, taskId: string) {
  return db
    .prepare(
      `SELECT rowid AS sequence, message FROM task_logs WHERE task_id = ?
    AND (message LIKE 'RUN start%' OR message LIKE 'RUN completed %' OR message LIKE 'RUN failed %'
      OR message LIKE 'Agent spawn failed:%') ORDER BY rowid DESC LIMIT 1`,
    )
    .get(taskId) as { sequence: number; message: string } | undefined;
}

function wasRestartFailureReplay(db: any, taskId: string): boolean {
  const start = db
    .prepare(
      "SELECT rowid AS sequence FROM task_logs WHERE task_id = ? AND message LIKE 'RUN start%' ORDER BY rowid DESC LIMIT 1",
    )
    .get(taskId);
  if (!start) return false;
  // Older servers invented a failed exit when recovering an interrupted RUN.
  // Only migrate that exact sequence: a genuine failure recorded first remains
  // a real failure even if an old watchdog subsequently replayed it too.
  const first = db
    .prepare(
      `SELECT message FROM task_logs WHERE task_id = ? AND rowid > ?
    AND (message LIKE 'RUN completed %' OR message LIKE 'RUN failed %' OR message LIKE 'Agent spawn failed:%'
      OR message LIKE 'Recovery (%): orphan in_progress detected %replaying failed completion')
    ORDER BY rowid LIMIT 1`,
    )
    .get(taskId, start.sequence);
  return /^Recovery \(.*\): orphan in_progress detected .*replaying failed completion$/.test(first?.message ?? "");
}

function hasLiveProcess(deps: any, taskId: string, runSequence = 0): boolean {
  const active = deps.activeProcesses.get(taskId);
  if (active) {
    if (!(active.pid > 0) || deps.isPidAlive?.(active.pid) !== false) return true;
    deps.activeProcesses.delete(taskId);
  }
  // CLI children are detached. A server reload can lose the handle while the
  // process is still running, so recent log activity alone is not a safe test.
  const processLog = deps.db
    .prepare(
      `SELECT message FROM task_logs WHERE task_id = ?
    AND rowid > ? AND message LIKE 'Run process pid: %' ORDER BY rowid DESC LIMIT 1`,
    )
    .get(taskId, runSequence);
  const pid = Number(String(processLog?.message ?? "").slice("Run process pid: ".length));
  return pid > 0 && Boolean(deps.isPidAlive?.(pid));
}

export function queueTaskRunRecovery(deps: any, taskId: string, reason: string): boolean {
  const task = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task || !["in_progress", "inbox", "planned"].includes(task.status) || isTaskAutoRecoveryHeld(deps, taskId))
    return false;
  const run = latestRun(deps.db, taskId);
  if (hasLiveProcess(deps, taskId, run?.sequence)) return false;

  const existing = deps.taskWorktrees?.get(taskId);
  const projectPath =
    existing?.projectPath ||
    task.project_path ||
    (task.project_id
      ? deps.db.prepare("SELECT project_path FROM projects WHERE id = ?").get(task.project_id)?.project_path
      : null);
  const worktree = existing || (projectPath ? recoverTaskWorktree(projectPath, taskId, deps.db) : null);
  if (worktree) deps.taskWorktrees?.set(taskId, worktree);

  // This marker is the durable dispatch driver, including for delegated children.
  // Retain it even if the worktree is missing: execution will hold visibly rather
  // than silently starting on a fresh branch or in the project checkout.
  const marker = deps.db
    .prepare(
      `SELECT message FROM task_logs WHERE task_id = ? AND rowid > ?
    AND message LIKE 'Run recovery queued: %' ORDER BY rowid DESC LIMIT 1`,
    )
    .get(taskId, run?.sequence ?? 0);
  if (!marker) deps.appendTaskLog(taskId, "system", `${QUEUED_PREFIX}${reason}`);
  if (task.status !== "planned") {
    deps.db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(deps.nowMs(), taskId);
    // Release only this task's stale ownership; another task's slot stays intact.
    deps.db
      .prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ? AND current_task_id = ?")
      .run(task.assigned_agent_id, taskId);
    deps.broadcast("task_update", deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    if (task.assigned_agent_id)
      deps.broadcast("agent_status", deps.db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id));
  }
  deps.stopProgressTimer?.(taskId);
  if (!worktree || !fs.existsSync(worktree.worktreePath)) {
    worktreeWait(deps).wait(taskId, "run-worktree", "Run recovery waiting for its retained worktree", () =>
      queueTaskRunRecovery(deps, taskId, reason),
    );
    return false;
  }
  worktreeWait(deps).clear(taskId, "run-worktree");
  return resumeTaskExecution(deps, taskId, reason, {
    reuseWorktree: true,
    recoveryNote: `The previous run was interrupted or failed. Continue from its existing worktree and branch; all previous changes are kept. ${reason}`,
  });
}

export function sweepQueuedRunRecoveries(deps: any): void {
  const tasks = deps.db
    .prepare(
      `SELECT id FROM tasks WHERE status IN ('planned','inbox','in_progress')
    AND EXISTS (SELECT 1 FROM task_logs WHERE task_id = tasks.id AND
      (message LIKE 'Run recovery queued: %' OR message LIKE 'Run automatic retry: 1/1%'))`,
    )
    .all();
  for (const { id } of tasks) {
    if (isTaskAutoRecoveryHeld(deps, id)) continue;
    const run = latestRun(deps.db, id);
    // A new RUN start consumes a queued dispatch; its orphan is handled below.
    const queued = deps.db
      .prepare(
        `SELECT message FROM task_logs WHERE task_id = ? AND rowid > ?
      AND (message LIKE 'Run recovery queued: %' OR message LIKE 'Run automatic retry: 1/1%')
      ORDER BY rowid DESC LIMIT 1`,
      )
      .get(id, run?.sequence ?? 0);
    if (queued) queueTaskRunRecovery(deps, id, String(queued.message).replace(QUEUED_PREFIX, ""));
  }
}

export function recoverOrphanInProgressTasks(deps: any, reason: RecoveryReason): void {
  // Inbox is intentionally restricted to unfinished RUN starts. Real failures
  // that exhausted their retry must remain in Inbox for CEO intervention.
  const tasks = deps.db
    .prepare(`SELECT * FROM tasks WHERE status IN ('in_progress','inbox') ORDER BY updated_at`)
    .all();
  const now = deps.nowMs();
  const graceMs = deps.IN_PROGRESS_ORPHAN_GRACE_MS;
  const activityWindow = Math.max(120_000, graceMs);
  for (const task of tasks) {
    if (isTaskAutoRecoveryHeld(deps, task.id)) continue;
    const run = latestRun(deps.db, task.id);
    if (hasLiveProcess(deps, task.id, run?.sequence)) continue;
    const reservedRetry = deps.db
      .prepare(
        `SELECT 1 FROM task_logs WHERE task_id = ? AND rowid > ?
      AND message LIKE 'Run automatic retry: 1/1%' LIMIT 1`,
      )
      .get(task.id, run?.sequence ?? 0);
    if (reservedRetry) {
      queueTaskRunRecovery(deps, task.id, "automatic retry reserved before restart");
      continue;
    }
    const interrupted =
      run?.message.startsWith("RUN start") ||
      (run?.message.startsWith("RUN failed ") && wasRestartFailureReplay(deps.db, task.id));
    if (task.status === "inbox" && !interrupted) continue;
    const touchedAt = Math.max(task.updated_at ?? 0, task.started_at ?? 0, task.created_at ?? 0);
    if (reason !== "startup" && now - touchedAt < graceMs) continue;

    // Legacy runs did not persist their PID. Keep their output-activity grace
    // window rather than duplicating a detached process immediately on reload.
    const pidLog = deps.db
      .prepare(
        `SELECT 1 FROM task_logs WHERE task_id = ? AND rowid > ?
      AND message LIKE 'Run process pid: %' LIMIT 1`,
      )
      .get(task.id, run?.sequence ?? 0);
    if (!pidLog) {
      const recent = deps.db
        .prepare("SELECT 1 FROM task_logs WHERE task_id = ? AND created_at > ? LIMIT 1")
        .get(task.id, now - activityWindow);
      if (recent) continue;
      try {
        if (now - fs.statSync(path.join(deps.logsDir, `${task.id}.log`)).mtimeMs <= activityWindow) continue;
      } catch {
        /* No terminal log to check. */
      }
    }
    if (interrupted) {
      const existing = deps.taskWorktrees?.get(task.id);
      const project =
        task.project_path ||
        (task.project_id
          ? deps.db.prepare("SELECT project_path FROM projects WHERE id = ?").get(task.project_id)?.project_path
          : null);
      const location =
        existing?.worktreePath ||
        (project ? recoverTaskWorktree(project, task.id, deps.db)?.worktreePath : null) ||
        "the existing task worktree";
      deps.appendTaskLog(
        task.id,
        "system",
        `Recovery (${reason}): run interrupted by a restart; resuming in ${location}`,
      );
      queueTaskRunRecovery(deps, task.id, `Recovery (${reason}): run interrupted by a restart`);
    } else if (task.status === "in_progress" && run) {
      // Replaying a recorded completion is different from inventing an exit for
      // a process lost during shutdown. The completion handler owns retry policy.
      const recordedExit = /exit code: (-?\d+)/.exec(run.message);
      deps.handleTaskRunComplete(task.id, recordedExit ? Number(recordedExit[1]) : 1);
    } else if (task.status === "in_progress") {
      deps.db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(now, task.id);
      deps.stopProgressTimer?.(task.id);
      deps.clearTaskWorkflowState?.(task.id);
      deps.endTaskExecutionSession?.(task.id, `orphan_in_progress_${reason}`);
      deps.db
        .prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ? AND current_task_id = ?")
        .run(task.assigned_agent_id, task.id);
      deps.appendTaskLog(task.id, "system", `Recovery (${reason}): in_progress without active process/run log → inbox`);
      deps.broadcast("task_update", deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id));
      if (task.assigned_agent_id)
        deps.broadcast(
          "agent_status",
          deps.db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id),
        );
      const lang = deps.resolveLang(task.title);
      notifyTaskStatus(task.id, task.title, "inbox", lang);
      const message =
        lang === "en"
          ? `[WATCHDOG] '${task.title}' was in progress but had no active process. Recovered to inbox.`
          : lang === "ja"
            ? `[WATCHDOG] '${task.title}' は in_progress でしたが実行プロセスが存在しないため inbox に復旧しました。`
            : lang === "zh"
              ? `[WATCHDOG] '${task.title}' 处于 in_progress，但未发现执行进程，已恢复到 inbox。`
              : `[WATCHDOG] '${task.title}' 작업이 in_progress 상태였지만 실행 프로세스가 없어 inbox로 복구했습니다.`;
      deps.notifyCeo(message, task.id);
    }
  }
  sweepQueuedRunRecoveries(deps);
}
