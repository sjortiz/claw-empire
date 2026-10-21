import { createPersistentWait } from "../../workflow/core/persistent-wait.ts";
import { isTaskAutoRecoveryHeld, recoverReadyRoot, resumeTaskExecution } from "../../workflow/core/task-resume.ts";
import { hasUnfinishedDependencies } from "./subtask-dependencies.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import type { Lang } from "../../../types/lang.ts";
import type { AgentRow } from "./direct-chat.ts";
import { reconcileVideoRenderDelegationState } from "../../workflow/orchestration/video-render-delegation-state.ts";
import { readYoloModeEnabled } from "../../routes/ops/messages/decision-inbox/yolo-mode.ts";
import { createSubtaskDelegationBatch } from "./subtask-delegation-batch.ts";
import { createSubtaskDelegationPromptBuilder } from "./subtask-delegation-prompt.ts";
import { initializeSubtaskSummary, type SubtaskRow } from "./subtask-summary.ts";
import type { L10n } from "./language-policy.ts";

interface SubtaskDelegationDeps {
  taskWorktrees?: RuntimeContext["taskWorktrees"];
  db: any;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  getPreferredLanguage: () => Lang;
  getDeptName: (deptId: string, workflowPackKey?: string | null) => string;
  getDeptRoleConstraint: (deptId: string, deptName: string) => string;
  getRecentConversationContext: (agentId: string, limit?: number) => string;
  getAgentDisplayName: (agent: AgentRow, lang: string) => string;
  buildTaskExecutionPrompt: (parts: string[], opts?: { allowWarningFix?: boolean }) => string;
  hasExplicitWarningFixRequest: (...textParts: Array<string | null | undefined>) => boolean;
  delegatedTaskToSubtask: Map<string, string>;
  subtaskDelegationCallbacks: Map<string, () => void>;
  subtaskDelegationDispatchInFlight: Set<string>;
  subtaskDelegationCompletionNoticeSent: Set<string>;
  notifyCeo: (content: string, taskId?: string | null, messageType?: string) => void;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
  appendTaskLog: (taskId: string, source: string, message: string) => void;
  finishReview: (
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
  ) => void;
  findTeamLeader: (deptId: string | null, candidateAgentIds?: string[] | null) => AgentRow | null;
  findBestSubordinate: (deptId: string, excludeId: string, candidateAgentIds?: string[] | null) => AgentRow | null;
  nowMs: () => number;
  broadcast: (event: string, payload: unknown) => void;
  handleTaskRunComplete: (taskId: string, exitCode: number) => void;
  stopRequestedTasks: Set<string>;
  stopRequestModeByTask: Map<string, "pause" | "cancel">;
  recordTaskCreationAudit: (payload: any) => void;
  resolveProjectPath: (taskLike: {
    project_id?: string | null;
    project_path?: string | null;
    description?: string | null;
    title?: string | null;
  }) => string;
  createWorktree: (projectPath: string, taskId: string, agentName: string, baseBranch?: string) => string | null;
  logsDir: string;
  ensureTaskExecutionSession: (
    taskId: string,
    agentId: string,
    provider: string,
  ) => {
    sessionId: string;
    agentId: string;
    provider: string;
  };
  ensureClaudeMd: (projectPath: string, worktreePath: string) => void;
  getProviderModelConfig: () => Record<string, { model?: string; reasoningLevel?: string }>;
  spawnCliAgent: RuntimeContext["spawnCliAgent"];
  getNextHttpAgentPid: () => number;
  launchApiProviderAgent: (
    taskId: string,
    apiProviderId: string | null,
    apiModel: string | null,
    prompt: string,
    cwd: string,
    logFilePath: string,
    controller: AbortController,
    fakePid: number,
    onComplete?: (exitCode: number) => void,
    reasoningLevel?: string | null,
  ) => void;
  launchHttpAgent: (
    taskId: string,
    provider: string,
    prompt: string,
    cwd: string,
    logFilePath: string,
    controller: AbortController,
    fakePid: number,
    oauthAccountId: string | null,
  ) => void;
  startProgressTimer: (taskId: string, taskTitle: string, departmentId: string | null) => void;
  startTaskExecutionForAgent: (taskId: string, agent: AgentRow, deptId: string | null, deptName: string) => void;
  activeProcesses: Map<string, unknown>;
}

export function initializeSubtaskDelegation(deps: SubtaskDelegationDeps) {
  const {
    db,
    taskWorktrees,
    l,
    pickL,
    resolveLang,
    getPreferredLanguage,
    getDeptName,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getAgentDisplayName,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    delegatedTaskToSubtask,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    subtaskDelegationCompletionNoticeSent,
    notifyCeo,
    sendAgentMessage,
    appendTaskLog,
    finishReview,
    findTeamLeader,
    findBestSubordinate,
    nowMs,
    broadcast,
    handleTaskRunComplete,
    stopRequestedTasks,
    stopRequestModeByTask,
    recordTaskCreationAudit,
    resolveProjectPath,
    createWorktree,
    logsDir,
    ensureTaskExecutionSession,
    ensureClaudeMd,
    getProviderModelConfig,
    spawnCliAgent,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    startProgressTimer,
    activeProcesses,
  } = deps;
  const scheduledSubtaskIds = new Set<string>();
  const pendingDelegationOptionsByTask = new Map<string, { includeRender?: boolean }>();
  const persistentWait = createPersistentWait(deps);

  // ---------------------------------------------------------------------------
  // Independent departments start together; only explicit prerequisites defer.
  // Reserve scheduled IDs until completion so repeated dispatch is idempotent.
  // ---------------------------------------------------------------------------
  const { formatTaskSubtaskProgressSummary, groupSubtasksByTargetDepartment, orderSubtaskQueuesByDepartment } =
    initializeSubtaskSummary({ db, l, pickL });
  const { buildSubtaskDelegationPrompt } = createSubtaskDelegationPromptBuilder({
    db,
    l,
    pickL,
    resolveLang,
    getDeptName,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getAgentDisplayName,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
  });

  function clearAutoResumeRetry(taskId: string): void {
    persistentWait.clear(taskId, "root-consolidation");
  }

  function scheduleAutoResumeRetry(taskId: string, reason: string): void {
    persistentWait.wait(
      taskId,
      "root-consolidation",
      `Root consolidation waiting: ${reason}`,
      () => maybeNotifyAllSubtasksComplete(taskId),
      { delayMs: 15_000 },
    );
  }

  function hasOpenForeignSubtasks(taskId: string, targetDeptIds: string[] = []): boolean {
    const uniqueDeptIds = [...new Set(targetDeptIds.filter(Boolean))];
    if (uniqueDeptIds.length > 0) {
      const placeholders = uniqueDeptIds.map(() => "?").join(", ");
      const row = db
        .prepare(
          `
    SELECT 1
    FROM subtasks
    WHERE task_id = ?
      AND target_department_id IN (${placeholders})
      AND target_department_id IS NOT NULL
      AND status NOT IN ('done', 'cancelled')
      AND (delegated_task_id IS NULL OR delegated_task_id = '')
    LIMIT 1
  `,
        )
        .get(taskId, ...uniqueDeptIds);
      return !!row;
    }

    const row = db
      .prepare(
        `
  SELECT 1
  FROM subtasks
  WHERE task_id = ?
    AND target_department_id IS NOT NULL
    AND status NOT IN ('done', 'cancelled')
    AND (delegated_task_id IS NULL OR delegated_task_id = '')
  LIMIT 1
`,
      )
      .get(taskId);
    return !!row;
  }

  function processSubtaskDelegations(taskId: string, opts?: { includeRender?: boolean }): void {
    if (isTaskAutoRecoveryHeld(deps, taskId)) return;
    if (subtaskDelegationDispatchInFlight.has(taskId)) {
      const previous = pendingDelegationOptionsByTask.get(taskId);
      pendingDelegationOptionsByTask.set(taskId, {
        includeRender: Boolean(previous?.includeRender || opts?.includeRender),
      });
      if (opts?.includeRender) {
        appendTaskLog(
          taskId,
          "system",
          "Subtask delegation queued: includeRender request deferred until in-flight batch completes",
        );
      }
      return;
    }

    const foreignSubtasks = db
      .prepare(
        "SELECT * FROM subtasks WHERE task_id = ? AND target_department_id IS NOT NULL AND status NOT IN ('done', 'cancelled') AND (delegated_task_id IS NULL OR delegated_task_id = '') ORDER BY created_at",
      )
      .all(taskId) as unknown as SubtaskRow[];

    // VIDEO_FINAL_RENDER must wait for other subtasks — exclude from initial batch
    for (const subtask of foreignSubtasks) {
      if (scheduledSubtaskIds.has(subtask.id) || !hasUnfinishedDependencies(db, subtask)) continue;
      const reason = pickL(
        l(
          ["선행 작업의 승인 및 통합을 기다리는 중"],
          ["Waiting for prerequisite approval and integration"],
          ["前提作業の承認と統合待ち"],
          ["等待前置任务批准并集成"],
        ),
        resolveLang(subtask.description ?? subtask.title),
      );
      if (subtask.blocked_reason !== reason || subtask.status !== "blocked") {
        db.prepare("UPDATE subtasks SET status = 'blocked', blocked_reason = ? WHERE id = ?").run(reason, subtask.id);
        broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtask.id));
      }
    }
    const eligible = foreignSubtasks.filter(
      (subtask) =>
        !scheduledSubtaskIds.has(subtask.id) &&
        !hasUnfinishedDependencies(db, subtask) &&
        (opts?.includeRender || !String(subtask.title ?? "").includes("[VIDEO_FINAL_RENDER]")),
    );

    if (eligible.length === 0) return;

    const parentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          id: string;
          title: string;
          description: string | null;
          status: string;
          project_id: string | null;
          project_path: string | null;
          department_id: string | null;
        }
      | undefined;
    if (!parentTask || !["planned", "pending", "collaborating", "in_progress", "review"].includes(parentTask.status))
      return;
    const lang = resolveLang(parentTask.description ?? parentTask.title);

    const queues = orderSubtaskQueuesByDepartment(groupSubtasksByTargetDepartment(eligible));
    const deptCount = queues.length;
    subtaskDelegationDispatchInFlight.add(taskId);
    subtaskDelegationCompletionNoticeSent.delete(parentTask.id);

    notifyCeo(
      pickL(
        l(
          [`'${parentTask.title}' 의 독립적인 외부 부서 서브태스크 ${eligible.length}건을 부서별로 병렬 위임합니다.`],
          [
            `Delegating ${eligible.length} independent external-department subtasks for '${parentTask.title}' in parallel department batches.`,
          ],
          [`'${parentTask.title}' の独立した他部門サブタスク${eligible.length}件を部門ごとに並列委任します。`],
          [`将把'${parentTask.title}'的${eligible.length}个独立外部门 SubTask 按部门并行委派。`],
        ),
        lang,
      ),
      taskId,
    );
    appendTaskLog(
      taskId,
      "system",
      `Subtask delegation mode: parallel_by_department_batched (queues=${deptCount}, items=${eligible.length})`,
    );
    // Reserve every batch before dispatch because a missing leader can finish
    // synchronously and re-enter the dispatcher from its completion callback.
    for (const subtask of eligible) scheduledSubtaskIds.add(subtask.id);
    queues.forEach((queue, index) => {
      delegateSubtaskBatch(queue, index, deptCount, parentTask, () => {
        for (const subtask of queue) scheduledSubtaskIds.delete(subtask.id);
        if (subtaskDelegationDispatchInFlight.has(taskId)) {
          pendingDelegationOptionsByTask.set(taskId, opts ?? {});
          return;
        }
        processSubtaskDelegations(taskId, opts);
        maybeNotifyAllSubtasksComplete(parentTask.id);
      });
    });
    subtaskDelegationDispatchInFlight.delete(taskId);
    const pending = pendingDelegationOptionsByTask.get(taskId);
    if (pending) {
      pendingDelegationOptionsByTask.delete(taskId);
      processSubtaskDelegations(taskId, pending);
    }
  }

  function maybeNotifyAllSubtasksComplete(parentTaskId: string): void {
    if (isTaskAutoRecoveryHeld(deps, parentTaskId)) return;
    processSubtaskDelegations(parentTaskId);
    const remaining = db
      .prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')")
      .get(parentTaskId) as { cnt: number };

    // Check if VIDEO_FINAL_RENDER is the only incomplete subtask(s)
    if (remaining.cnt > 0) {
      const pendingRender = db
        .prepare(
          "SELECT * FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled') AND title LIKE '%[VIDEO_FINAL_RENDER]%'",
        )
        .all(parentTaskId) as unknown as SubtaskRow[];

      const nonRenderRemaining = remaining.cnt - pendingRender.length;

      if (nonRenderRemaining === 0 && pendingRender.length > 0) {
        const repair = reconcileVideoRenderDelegationState({ db, nowMs, broadcast }, pendingRender);
        if (repair.staleResetCount > 0 || repair.recoveredDoneCount > 0) {
          appendTaskLog(
            parentTaskId,
            "system",
            `VIDEO_FINAL_RENDER delegation state repaired (stale_reset=${repair.staleResetCount}, recovered_done=${repair.recoveredDoneCount})`,
          );
        }

        const refreshedPendingRender = db
          .prepare(
            "SELECT * FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled') AND title LIKE '%[VIDEO_FINAL_RENDER]%'",
          )
          .all(parentTaskId) as unknown as SubtaskRow[];
        const undelegated = refreshedPendingRender.filter((s) => !String(s.delegated_task_id ?? "").trim());
        if (undelegated.length > 0) {
          // Unblock render subtasks so delegation can proceed
          for (const sub of undelegated) {
            if (sub.status === "blocked") {
              db.prepare("UPDATE subtasks SET status = 'pending', blocked_reason = NULL WHERE id = ?").run(sub.id);
              broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
            }
          }
          appendTaskLog(
            parentTaskId,
            "system",
            "All non-render subtasks completed. Unblocked and triggering VIDEO_FINAL_RENDER delegation.",
          );
          processSubtaskDelegations(parentTaskId, { includeRender: true });
          return; // Not all done yet — don't call finishReview
        }
      }
    }

    const parentTask = db
      .prepare(
        `
        SELECT title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id
        FROM tasks
        WHERE id = ?
      `,
      )
      .get(parentTaskId) as
      | {
          title: string;
          description: string | null;
          status: string;
          workflow_pack_key: string | null;
          source_task_id: string | null;
          assigned_agent_id: string | null;
          department_id: string | null;
        }
      | undefined;
    if (!parentTask) return;

    if (
      remaining.cnt === 0 &&
      parentTask.status === "pending" &&
      recoverReadyRoot(deps, parentTaskId, "last subtask completion")
    )
      return;

    if (remaining.cnt === 0 && parentTask.status === "collaborating" && parentTask.assigned_agent_id) {
      const graphMarker = db
        .prepare(
          `SELECT 1 FROM task_logs
        WHERE task_id = ? AND kind = 'system' AND message LIKE 'Planned graph seeded %' LIMIT 1`,
        )
        .get(parentTaskId);
      if (graphMarker) {
        const unintegrated = db
          .prepare(
            `SELECT 1 FROM subtasks s
          LEFT JOIN tasks child ON child.id = s.delegated_task_id
          WHERE s.task_id = ? AND s.status = 'done' AND (child.status IS NULL OR child.status != 'done') LIMIT 1`,
          )
          .get(parentTaskId);
        if (unintegrated) return;
        const planner = db.prepare("SELECT * FROM agents WHERE id = ?").get(parentTask.assigned_agent_id) as
          | AgentRow
          | undefined;
        if (!planner || activeProcesses.has(parentTaskId)) return;
        if (
          !["idle", "break"].includes(planner.status) ||
          (planner.current_task_id && planner.current_task_id !== parentTaskId)
        ) {
          scheduleAutoResumeRetry(parentTaskId, "planning_graph_consolidation_agent_busy");
          return;
        }
        clearAutoResumeRetry(parentTaskId);
        resumeTaskExecution(deps, parentTaskId, "all planning graph children integrated; starting root consolidation");
        return;
      }
    }

    // Auto-resume retry should continue even after completion notice was already sent.
    if (remaining.cnt === 0) {
      if (
        !(
          parentTask.status === "pending" &&
          parentTask.workflow_pack_key === "video_preprod" &&
          !parentTask.source_task_id &&
          parentTask.assigned_agent_id
        )
      ) {
        clearAutoResumeRetry(parentTaskId);
      } else {
        const recentLogs = db
          .prepare(
            `
            SELECT message
            FROM task_logs
            WHERE task_id = ?
              AND kind = 'system'
            ORDER BY created_at DESC
            LIMIT 12
          `,
          )
          .all(parentTaskId) as Array<{ message: string | null }>;
        const heldForRenderOrdering = recentLogs.some((row) =>
          String(row.message ?? "").includes(
            "Video render hold: waiting for documentation/planning completion before final render",
          ),
        );
        if (!heldForRenderOrdering) {
          clearAutoResumeRetry(parentTaskId);
        } else {
          const assignedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(parentTask.assigned_agent_id) as
            | AgentRow
            | undefined;
          if (!assignedAgent) {
            appendTaskLog(parentTaskId, "system", "Auto-resume skipped: assigned agent not found");
            clearAutoResumeRetry(parentTaskId);
          } else if (activeProcesses.has(parentTaskId)) {
            appendTaskLog(parentTaskId, "system", "Auto-resume skipped: task process already active");
            clearAutoResumeRetry(parentTaskId);
          } else if (
            assignedAgent.status === "working" &&
            assignedAgent.current_task_id &&
            assignedAgent.current_task_id !== parentTaskId &&
            activeProcesses.has(assignedAgent.current_task_id)
          ) {
            appendTaskLog(
              parentTaskId,
              "system",
              `Auto-resume deferred: assigned agent busy on ${assignedAgent.current_task_id}`,
            );
            scheduleAutoResumeRetry(parentTaskId, `agent_busy:${assignedAgent.current_task_id}`);
          } else {
            appendTaskLog(
              parentTaskId,
              "system",
              "Video render hold cleared: all subtasks completed. Auto-resuming final render run.",
            );
            resumeTaskExecution(deps, parentTaskId, "video render hold cleared: all subtasks completed");
            clearAutoResumeRetry(parentTaskId);
          }
        }
      }
    }

    if (remaining.cnt !== 0 || subtaskDelegationCompletionNoticeSent.has(parentTaskId)) return;

    const lang = resolveLang(parentTask.description ?? parentTask.title);
    subtaskDelegationCompletionNoticeSent.add(parentTaskId);
    const subtaskProgressSummary = formatTaskSubtaskProgressSummary(parentTaskId, lang);
    const progressSuffix = subtaskProgressSummary
      ? `\n${pickL(l(["보완/협업 완료 현황"], ["Remediation/Collaboration completion"], ["補完/協業 完了状況"], ["整改/协作完成情况"]), lang)}\n${subtaskProgressSummary}`
      : "";
    notifyCeo(
      pickL(
        l(
          [`'${parentTask.title}' 의 모든 서브태스크(부서간 협업 포함)가 완료되었습니다. ✅${progressSuffix}`],
          [
            `All subtasks for '${parentTask.title}' (including cross-department collaboration) are complete. ✅${progressSuffix}`,
          ],
          [`'${parentTask.title}' の全サブタスク（部門間協業含む）が完了しました。✅${progressSuffix}`],
          [`'${parentTask.title}'的全部 SubTask（含跨部门协作）已完成。✅${progressSuffix}`],
        ),
        lang,
      ),
      parentTaskId,
    );
    if (parentTask.status === "review") {
      const yolo = readYoloModeEnabled(db);
      setTimeout(
        () =>
          finishReview(parentTaskId, parentTask.title, {
            bypassProjectDecisionGate: yolo,
            trigger: "subtask_completion",
          }),
        1200,
      );
    }
  }

  function finalizeDelegatedSubtasks(delegatedTaskId: string, subtaskIds: string[], exitCode: number): void {
    if (subtaskIds.length === 0) return;

    const pausedRun =
      exitCode !== 0 &&
      stopRequestedTasks.has(delegatedTaskId) &&
      stopRequestModeByTask.get(delegatedTaskId) === "pause";
    if (pausedRun) {
      appendTaskLog(
        delegatedTaskId,
        "system",
        "Delegated subtask finalization deferred (pause requested, waiting for resume)",
      );
      handleTaskRunComplete(delegatedTaskId, exitCode);
      return;
    }

    handleTaskRunComplete(delegatedTaskId, exitCode);
    // A successful run with late peer notes continues before delegated items finish.
    const afterRun = db.prepare("SELECT status FROM tasks WHERE id = ?").get(delegatedTaskId) as
      | { status: string }
      | undefined;
    if (afterRun?.status === "in_progress" || afterRun?.status === "pending") return;
    if (exitCode === 0) {
      appendTaskLog(delegatedTaskId, "system", "Delegated work awaits approval and directive integration");
      return;
    }
    delegatedTaskToSubtask.delete(delegatedTaskId);

    const lang = getPreferredLanguage();
    const blockedReason = pickL(
      l(["위임 작업 실패"], ["Delegated task failed"], ["委任タスク失敗"], ["委派任务失败"]),
      lang,
    );
    for (const subtaskId of subtaskIds) {
      db.prepare("UPDATE subtasks SET status = 'blocked', blocked_reason = ? WHERE id = ?").run(
        blockedReason,
        subtaskId,
      );
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtaskId));
    }
  }

  const { delegateSubtaskBatch } = createSubtaskDelegationBatch({
    taskWorktrees,
    db,
    l,
    pickL,
    resolveLang,
    getDeptName,
    getAgentDisplayName,
    findTeamLeader,
    findBestSubordinate,
    nowMs,
    broadcast,
    notifyCeo,
    sendAgentMessage,
    appendTaskLog,
    recordTaskCreationAudit,
    resolveProjectPath,
    createWorktree,
    logsDir,
    ensureTaskExecutionSession,
    ensureClaudeMd,
    getProviderModelConfig,
    spawnCliAgent,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    startProgressTimer,
    subtaskDelegationCallbacks,
    delegatedTaskToSubtask,
    maybeNotifyAllSubtasksComplete,
    finalizeDelegatedSubtasks,
    buildSubtaskDelegationPrompt,
  });

  return {
    formatTaskSubtaskProgressSummary,
    hasOpenForeignSubtasks,
    processSubtaskDelegations,
    maybeNotifyAllSubtasksComplete,
  };
}
