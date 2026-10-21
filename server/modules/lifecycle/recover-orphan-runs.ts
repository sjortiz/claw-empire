import fs from "node:fs";
import path from "node:path";
import { notifyTaskStatus } from "../../gateway/client.ts";
import {
  hasLiveTaskRunProcess,
  isRunRecoveryHeld,
  latestTaskRunEvent,
  queueTaskRunRecovery,
  resumeQueuedTaskRun,
  sweepQueuedTaskRuns,
} from "../workflow/core/run-recovery.ts";

export function recoverOrphanInProgressTasks(ctx: any, reason: "startup" | "interval"): void {
  const {
    db,
    activeProcesses,
    appendTaskLog,
    isPidAlive,
    nowMs,
    IN_PROGRESS_ORPHAN_GRACE_MS,
    logsDir,
    handleTaskRunComplete,
    stopProgressTimer,
    clearTaskWorkflowState,
    endTaskExecutionSession,
    broadcast,
    resolveLang,
    notifyCeo,
  } = ctx;
  const ORPHAN_RECENT_ACTIVITY_WINDOW_MS = Math.max(120_000, IN_PROGRESS_ORPHAN_GRACE_MS);
  sweepQueuedTaskRuns(ctx, reason);
  const inProgressTasks = db
    .prepare(
      `
    SELECT id, title, assigned_agent_id, created_at, started_at, updated_at
    FROM tasks
    WHERE status = 'in_progress'
    ORDER BY updated_at ASC
  `,
    )
    .all() as Array<{
    id: string;
    title: string;
    assigned_agent_id: string | null;
    created_at: number | null;
    started_at: number | null;
    updated_at: number | null;
  }>;

  const now = nowMs();
  for (const task of inProgressTasks) {
    const active = activeProcesses.get(task.id);
    if (active) {
      const pid = typeof active.pid === "number" ? active.pid : null;
      if (pid !== null && pid > 0 && !isPidAlive(pid)) {
        activeProcesses.delete(task.id);
        appendTaskLog(task.id, "system", `Recovery (${reason}): removed stale process handle (pid=${pid})`);
      } else {
        continue;
      }
    }

    const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
    if (isRunRecoveryHeld(ctx, freshTask) || hasLiveTaskRunProcess(ctx, task.id)) continue;

    const lastTouchedAt = Math.max(task.updated_at ?? 0, task.started_at ?? 0, task.created_at ?? 0);
    const ageMs = lastTouchedAt > 0 ? Math.max(0, now - lastTouchedAt) : IN_PROGRESS_ORPHAN_GRACE_MS + 1;
    if (ageMs < IN_PROGRESS_ORPHAN_GRACE_MS) continue;

    // 추가 안전장치 1: task_logs 활동이 최근 윈도우 내에 있으면 아직 활성 상태로 간주
    const recentLog = db
      .prepare(
        `
      SELECT created_at FROM task_logs
      WHERE task_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT 1
    `,
      )
      .get(task.id, now - ORPHAN_RECENT_ACTIVITY_WINDOW_MS) as { created_at: number } | undefined;
    if (recentLog) {
      continue;
    }

    // 추가 안전장치 2: 터미널 로그 파일이 최근까지 갱신됐다면 여전히 출력이 진행 중인 것으로 간주
    // (예: 서버 리로드/재시작으로 in-memory process handle만 유실된 경우)
    try {
      const logPath = path.join(logsDir, `${task.id}.log`);
      const stat = fs.statSync(logPath);
      const logIdleMs = Math.max(0, now - Math.floor(stat.mtimeMs || 0));
      if (logIdleMs <= ORPHAN_RECENT_ACTIVITY_WINDOW_MS) {
        continue;
      }
    } catch {
      // 로그 파일이 없거나 접근 불가하면 기존 복구 로직 진행
    }

    const latestRunMessage = latestTaskRunEvent(db, task.id);

    if (latestRunMessage.startsWith("Run recovery queued:")) {
      // A restart can land after execution claims in_progress but before it
      // emits RUN start. Re-enter the same queue without consuming a retry.
      if (queueTaskRunRecovery(ctx, task.id, latestRunMessage.slice("Run recovery queued:".length).trim())) {
        resumeQueuedTaskRun(ctx, task.id);
      }
      continue;
    }

    if (latestRunMessage.startsWith("RUN start")) {
      if (queueTaskRunRecovery(ctx, task.id, `Recovery (${reason}): run interrupted by a restart`)) {
        resumeQueuedTaskRun(ctx, task.id);
      }
      continue;
    }

    if (latestRunMessage.startsWith("RUN completed (exit code: 0)")) {
      appendTaskLog(
        task.id,
        "system",
        `Recovery (${reason}): orphan in_progress detected (age_ms=${ageMs}) → replaying successful completion`,
      );
      handleTaskRunComplete(task.id, 0);
      continue;
    }

    if (latestRunMessage.startsWith("RUN ") || latestRunMessage.startsWith("Agent spawn failed:")) {
      appendTaskLog(
        task.id,
        "system",
        `Recovery (${reason}): orphan in_progress detected (age_ms=${ageMs}) → replaying failed completion`,
      );
      handleTaskRunComplete(task.id, 1);
      continue;
    }

    const t = nowMs();
    const move = db
      .prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ? AND status = 'in_progress'")
      .run(t, task.id) as { changes?: number };
    if ((move.changes ?? 0) === 0) continue;

    stopProgressTimer(task.id);
    clearTaskWorkflowState(task.id);
    endTaskExecutionSession(task.id, `orphan_in_progress_${reason}`);
    appendTaskLog(
      task.id,
      "system",
      `Recovery (${reason}): in_progress without active process/run log (age_ms=${ageMs}) → inbox`,
    );

    if (task.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(
        task.assigned_agent_id,
        task.id,
      );
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
      broadcast("agent_status", updatedAgent);
    }

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
    broadcast("task_update", updatedTask);
    const lang = resolveLang(task.title);
    notifyTaskStatus(task.id, task.title, "inbox", lang);
    const watchdogMessage =
      lang === "en"
        ? `[WATCHDOG] '${task.title}' was in progress but had no active process. Recovered to inbox.`
        : lang === "ja"
          ? `[WATCHDOG] '${task.title}' は in_progress でしたが実行プロセスが存在しないため inbox に復旧しました。`
          : lang === "zh"
            ? `[WATCHDOG] '${task.title}' 处于 in_progress，但未发现执行进程，已恢复到 inbox。`
            : `[WATCHDOG] '${task.title}' 작업이 in_progress 상태였지만 실행 프로세스가 없어 inbox로 복구했습니다.`;
    notifyCeo(watchdogMessage, task.id);
  }
}
