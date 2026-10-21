import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolveTaskMergePolicy } from "../core/worktree/merge-policy.ts";
import { REVIEW_AUTO_START_LOG, resolveReviewAutomation } from "../core/review-automation.ts";
import path from "node:path";
import {
  discoverVideoArtifact,
  resolveVideoArtifactRelativeCandidates,
  resolveVideoArtifactSpecForTask,
} from "../packs/video-artifact.ts";
import { evaluateRemotionOnlyGateFromLogFiles } from "../packs/video-render-engine-gate.ts";
import { readYoloModeEnabled } from "../../routes/ops/messages/decision-inbox/yolo-mode.ts";
import { createWorktreeLifecycleTools, findTaskBranch, recoverTaskWorktree } from "../core/worktree/lifecycle.ts";
import { resolveDirectiveRoot } from "../core/worktree/directive-branch.ts";
import { reconcileVideoRenderDelegationState } from "./video-render-delegation-state.ts";

type CreateReviewFinalizeToolsDeps = Record<string, any>;

function localBranchExists(projectPath: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export function createReviewFinalizeTools(deps: CreateReviewFinalizeToolsDeps) {
  const {
    db,
    nowMs,
    logsDir,
    broadcast,
    appendTaskLog,
    getPreferredLanguage,
    pickL,
    l,
    resolveLang,
    getProjectReviewGateSnapshot,
    projectReviewGateNotifiedAt,
    notifyCeo,
    taskWorktrees,
    mergeWorktree,
    mergeIntoCheckout,
    cleanupWorktree,
    startTaskExecutionForAgent,
    getDeptName,
    findTeamLeader,
    getAgentDisplayName,
    setTaskCreationAuditCompletion,
    endTaskExecutionSession,
    notifyTaskStatus,
    refreshCliUsageData,
    shouldDeferTaskReportUntilPlanningArchive,
    emitTaskReportEvent,
    formatTaskSubtaskProgressSummary,
    reviewRoundState,
    reviewInFlight,
    archivePlanningConsolidatedReport,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    startReviewConsensusMeeting,
    processSubtaskDelegations,
  } = deps;

  function reconcileDelegatedSubtasksAfterRun(taskId: string, exitCode: number): void {
    const linked = db
      .prepare(
        `
  SELECT id, task_id
  FROM subtasks
  WHERE delegated_task_id = ?
    AND status NOT IN ('done', 'cancelled')
`,
      )
      .all(taskId) as Array<{ id: string; task_id: string }>;

    const touchedParents = new Set<string>();
    const task = db.prepare("SELECT source_task_id FROM tasks WHERE id = ?").get(taskId) as
      | { source_task_id: string | null }
      | undefined;
    if (task?.source_task_id) touchedParents.add(task.source_task_id);
    for (const sub of linked) {
      if (sub.task_id) touchedParents.add(sub.task_id);
    }

    if (exitCode === 0) {
      const doneAt = nowMs();
      for (const sub of linked) {
        db.prepare("UPDATE subtasks SET status = 'done', completed_at = ?, blocked_reason = NULL WHERE id = ?").run(
          doneAt,
          sub.id,
        );
        broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
      }
      appendTaskLog(taskId, "system", `Delegated subtask sync: marked ${linked.length} linked subtask(s) as done`);

      for (const parentTaskId of touchedParents) {
        const parent = db.prepare("SELECT id, title, status FROM tasks WHERE id = ?").get(parentTaskId) as
          | {
              id: string;
              title: string;
              status: string;
            }
          | undefined;
        if (!parent) continue;
        const remaining = db
          .prepare("SELECT COUNT(*) AS cnt FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')")
          .get(parentTaskId) as { cnt: number } | undefined;
        if ((remaining?.cnt ?? 0) === 0 && parent.status === "review") {
          appendTaskLog(
            parentTaskId,
            "system",
            "All delegated subtasks completed after resume; retrying review completion",
          );
          const yolo = readYoloModeEnabled(db);
          setTimeout(
            () =>
              finishReview(parentTaskId, parent.title, {
                bypassProjectDecisionGate: yolo,
                trigger: "delegated_subtask_completion",
              }),
            1200,
          );
        }
      }
      return;
    }

    const lang = getPreferredLanguage();
    const blockedReason = pickL(
      l(["위임 작업 실패"], ["Delegated task failed"], ["委任タスク失敗"], ["委派任务失败"]),
      lang,
    );
    for (const sub of linked) {
      db.prepare("UPDATE subtasks SET status = 'blocked', blocked_reason = ?, completed_at = NULL WHERE id = ?").run(
        blockedReason,
        sub.id,
      );
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
    }
    appendTaskLog(taskId, "system", `Delegated subtask sync: marked ${linked.length} linked subtask(s) as blocked`);
  }

  // Start the project-level review meeting the gate would otherwise hold for a CEO decision.
  function autoStartProjectReview(projectId: string, lang: string, taskId: string): void {
    projectReviewGateNotifiedAt.delete(projectId);
    // Same conditions as the Decision Inbox item: never run over a running meeting or a pending revision pick.
    const blockingMeeting = db
      .prepare(
        `
  SELECT mm.status
  FROM tasks t
  JOIN meeting_minutes mm ON mm.task_id = t.id
  WHERE t.project_id = ?
    AND t.status = 'review'
    AND t.source_task_id IS NULL
    AND mm.meeting_type = 'review'
    AND (mm.status = 'in_progress' OR mm.status = 'revision_requested')
    AND mm.id = (
      SELECT mm2.id
      FROM meeting_minutes mm2
      WHERE mm2.task_id = t.id
        AND mm2.meeting_type = 'review'
      ORDER BY mm2.started_at DESC, mm2.created_at DESC
      LIMIT 1
    )
  LIMIT 1
`,
      )
      .get(projectId) as { status: string } | undefined;
    if (blockingMeeting) {
      appendTaskLog(
        taskId,
        "system",
        blockingMeeting.status === "in_progress"
          ? "Review gate: waiting for the running project review meeting before starting automatically (setting)"
          : "Review gate: waiting for a pending review round decision before starting automatically (setting)",
      );
      return;
    }
    const reviewTasks = db
      .prepare(
        `
  SELECT id, title
  FROM tasks
  WHERE project_id = ?
    AND status = 'review'
    AND source_task_id IS NULL
  ORDER BY updated_at ASC, created_at ASC
`,
      )
      .all(projectId) as Array<{ id: string; title: string }>;
    const startedTasks: Array<{ id: string; title: string }> = [];
    for (const task of reviewTasks) {
      if (reviewInFlight.has(task.id)) continue;
      finishReview(task.id, task.title, { bypassProjectDecisionGate: true, trigger: "review_auto_start" });
      const after = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status?: string } | undefined;
      // Tasks held by a review gate (unfinished subtasks, video artifacts) log their own hold reason.
      if (!reviewInFlight.has(task.id) && after?.status === "review") continue;
      appendTaskLog(task.id, "system", REVIEW_AUTO_START_LOG);
      startedTasks.push(task);
    }
    if (startedTasks.length === 0) return;

    db.prepare(
      "INSERT INTO review_auto_start_notices (id, project_id, task_ids_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(randomUUID(), projectId, JSON.stringify(startedTasks.map((task) => task.id)), nowMs());
    const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as
      | { name: string | null }
      | undefined;
    const projectName = (project?.name || projectId).trim();
    notifyCeo(
      pickL(
        l(
          [
            `[CEO OFFICE] 프로젝트 '${projectName}'의 팀장 회의가 설정에 따라 자동으로 시작되었습니다 (${startedTasks.length}건). 의사결정 인박스에서 확인할 수 있습니다.`,
          ],
          [
            `[CEO OFFICE] Project '${projectName}': team-lead review meeting started automatically by setting (${startedTasks.length} task(s)). Details are in the Decision Inbox.`,
          ],
          [
            `[CEO OFFICE] プロジェクト'${projectName}'のチームリーダー会議を設定により自動開始しました（${startedTasks.length}件）。詳細はDecision Inboxで確認できます。`,
          ],
          [
            `[CEO OFFICE] 项目'${projectName}'的组长评审会议已按设置自动启动（${startedTasks.length} 个任务）。详情见 Decision Inbox。`,
          ],
        ),
        lang,
      ),
      startedTasks[0].id,
    );
  }

  // Move a reviewed task to 'done'
  function finishReview(
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; skipConsensus?: boolean; trigger?: string },
  ): void {
    const lang = resolveLang(taskTitle);
    const currentTask = db
      .prepare(
        "SELECT status, department_id, source_task_id, project_id, workflow_pack_key, project_path FROM tasks WHERE id = ?",
      )
      .get(taskId) as
      | {
          status: string;
          department_id: string | null;
          source_task_id: string | null;
          project_id: string | null;
          workflow_pack_key: string | null;
          project_path: string | null;
        }
      | undefined;
    if (!currentTask || currentTask.status !== "review") return; // Already moved or cancelled

    if (!options?.bypassProjectDecisionGate && !currentTask.source_task_id && currentTask.project_id) {
      const gateSnapshot = getProjectReviewGateSnapshot(currentTask.project_id);
      if (resolveReviewAutomation(db, "reviewAutoStart", currentTask.project_id).enabled) {
        if (gateSnapshot.ready) {
          autoStartProjectReview(currentTask.project_id, lang, taskId);
        } else {
          appendTaskLog(
            taskId,
            "system",
            `Review gate: waiting for other project tasks (${gateSnapshot.activeReview}/${gateSnapshot.activeTotal} active tasks in review); the review meeting starts automatically (setting)`,
          );
        }
        return;
      }
      appendTaskLog(
        taskId,
        "system",
        `Review gate: waiting for project-level decision (${gateSnapshot.activeReview}/${gateSnapshot.activeTotal} active tasks in review)`,
      );
      if (gateSnapshot.ready) {
        const now = nowMs();
        const lastNotified = projectReviewGateNotifiedAt.get(currentTask.project_id) ?? 0;
        if (now - lastNotified > 30_000) {
          projectReviewGateNotifiedAt.set(currentTask.project_id, now);
          const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(currentTask.project_id) as
            | { name: string | null }
            | undefined;
          const projectName = (project?.name || currentTask.project_id).trim();
          notifyCeo(
            pickL(
              l(
                [
                  `[CEO OFFICE] 프로젝트 '${projectName}'의 활성 항목 ${gateSnapshot.activeTotal}건이 모두 Review 상태입니다. 의사결정 인박스에서 승인하면 팀장 회의를 시작합니다.`,
                ],
                [
                  `[CEO OFFICE] Project '${projectName}' now has all ${gateSnapshot.activeTotal} active tasks in Review. Approve from Decision Inbox to start team-lead review meetings.`,
                ],
                [
                  `[CEO OFFICE] プロジェクト'${projectName}'のアクティブタスク${gateSnapshot.activeTotal}件がすべてReviewに到達しました。Decision Inboxで承認するとチームリーダー会議を開始します。`,
                ],
                [
                  `[CEO OFFICE] 项目'${projectName}'的 ${gateSnapshot.activeTotal} 个活跃任务已全部进入 Review。请在 Decision Inbox 批准后启动组长评审会议。`,
                ],
              ),
              lang,
            ),
            taskId,
          );
        }
      } else {
        projectReviewGateNotifiedAt.delete(currentTask.project_id);
      }
      return;
    }
    if (options?.bypassProjectDecisionGate && currentTask.project_id) {
      projectReviewGateNotifiedAt.delete(currentTask.project_id);
      appendTaskLog(taskId, "system", `Review gate bypassed (trigger=${options.trigger ?? "manual"})`);
    }

    const healed = db
      .prepare(
        `
  UPDATE subtasks
  SET status = 'done',
      completed_at = COALESCE(completed_at, ?),
      blocked_reason = NULL
  WHERE task_id = ?
    AND status = 'blocked'
    AND delegated_task_id IS NOT NULL
    AND delegated_task_id != ''
    AND EXISTS (
      SELECT 1
      FROM tasks dt
      WHERE dt.id = subtasks.delegated_task_id
        AND dt.status = 'done'
    )
`,
      )
      .run(nowMs(), taskId) as { changes?: number } | undefined;
    if ((healed?.changes ?? 0) > 0) {
      appendTaskLog(
        taskId,
        "system",
        `Review gate auto-heal: recovered ${healed?.changes ?? 0} blocked delegated subtask(s) after successful resume`,
      );
    }

    let remainingSubtaskCount = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')")
        .get(taskId) as { cnt: number }
    ).cnt;
    if (remainingSubtaskCount > 0) {
      // Check if only VIDEO_FINAL_RENDER subtask(s) remain — trigger delegation instead of blocking forever
      let pendingRender = db
        .prepare(
          "SELECT * FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled') AND title LIKE '%[VIDEO_FINAL_RENDER]%'",
        )
        .all(taskId) as Array<{ id: string; status: string; delegated_task_id: string | null }>;
      let nonRenderRemaining = remainingSubtaskCount - pendingRender.length;

      if (nonRenderRemaining === 0 && pendingRender.length > 0) {
        const repair = reconcileVideoRenderDelegationState({ db, nowMs, broadcast }, pendingRender);
        if (repair.staleResetCount > 0 || repair.recoveredDoneCount > 0) {
          appendTaskLog(
            taskId,
            "system",
            `Review hold repair: VIDEO_FINAL_RENDER delegation reconciled (stale_reset=${repair.staleResetCount}, recovered_done=${repair.recoveredDoneCount})`,
          );
          remainingSubtaskCount = (
            db
              .prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')")
              .get(taskId) as { cnt: number }
          ).cnt;
          pendingRender = db
            .prepare(
              "SELECT * FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled') AND title LIKE '%[VIDEO_FINAL_RENDER]%'",
            )
            .all(taskId) as Array<{ id: string; status: string; delegated_task_id: string | null }>;
          nonRenderRemaining = remainingSubtaskCount - pendingRender.length;
        }
      }

      if (nonRenderRemaining === 0 && pendingRender.length > 0) {
        const undelegated = pendingRender.filter((s) => !String(s.delegated_task_id ?? "").trim());
        if (undelegated.length > 0) {
          // Unblock and delegate render subtasks
          for (const sub of undelegated) {
            if (sub.status === "blocked") {
              db.prepare("UPDATE subtasks SET status = 'pending', blocked_reason = NULL WHERE id = ?").run(sub.id);
              broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
            }
          }
          appendTaskLog(
            taskId,
            "system",
            "Review hold: only VIDEO_FINAL_RENDER remains — unblocking and triggering delegation.",
          );
          processSubtaskDelegations(taskId, { includeRender: true });
        } else {
          appendTaskLog(taskId, "system", `Review hold: VIDEO_FINAL_RENDER already delegated, waiting for completion.`);
        }
        return;
      }

      notifyCeo(
        pickL(
          l(
            [`'${taskTitle}' 는 아직 ${remainingSubtaskCount}개 서브태스크가 남아 있어 Review 단계에서 대기합니다.`],
            [`'${taskTitle}' is waiting in Review because ${remainingSubtaskCount} subtasks are still unfinished.`],
            [`'${taskTitle}' は未完了サブタスクが${remainingSubtaskCount}件あるため、Reviewで待機しています。`],
            [`'${taskTitle}' 仍有 ${remainingSubtaskCount} 个 SubTask 未完成，当前在 Review 阶段等待。`],
          ),
          lang,
        ),
        taskId,
      );
      appendTaskLog(taskId, "system", `Review hold: waiting for ${remainingSubtaskCount} unfinished subtasks`);
      return;
    }

    // Every parent waits for its collaboration children, including nested delegation.
    {
      const childProgress = db
        .prepare(
          `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review_cnt,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_cnt
    FROM tasks
    WHERE source_task_id = ?
  `,
        )
        .get(taskId) as { total: number; review_cnt: number | null; done_cnt: number | null } | undefined;
      const childTotal = childProgress?.total ?? 0;
      const childReview = childProgress?.review_cnt ?? 0;
      const childDone = childProgress?.done_cnt ?? 0;
      const childReady = childReview + childDone;
      if (childTotal > 0 && childReady < childTotal) {
        const waiting = childTotal - childReady;
        notifyCeo(
          pickL(
            l(
              [`'${taskTitle}' 는 협업 하위 태스크 ${waiting}건이 아직 Review 진입 전이라 전체 팀장회의를 대기합니다.`],
              [
                `'${taskTitle}' is waiting for ${waiting} collaboration child task(s) to reach review before the single team-lead meeting starts.`,
              ],
              [
                `'${taskTitle}' は協業子タスク${waiting}件がまだReview未到達のため、全体チームリーダー会議を待機しています。`,
              ],
              [`'${taskTitle}' 仍有 ${waiting} 个协作子任务尚未进入 Review，当前等待后再开启一次团队负责人会议。`],
            ),
            lang,
          ),
          taskId,
        );
        appendTaskLog(
          taskId,
          "system",
          `Review hold: waiting for collaboration children to reach review (${childReady}/${childTotal})`,
        );
        return;
      }
    }

    if (currentTask.workflow_pack_key === "video_preprod" && !currentTask.source_task_id) {
      const wtInfo = taskWorktrees.get(taskId) as
        | { worktreePath?: string; projectPath?: string; branchName?: string }
        | undefined;
      const outputRoot = currentTask.project_path || wtInfo?.projectPath || process.cwd();
      const videoArtifactSpec = resolveVideoArtifactSpecForTask(db as any, {
        project_id: currentTask.project_id,
        project_path: currentTask.project_path,
        department_id: currentTask.department_id,
        workflow_pack_key: currentTask.workflow_pack_key,
      });
      const candidateRelativePaths = resolveVideoArtifactRelativeCandidates(videoArtifactSpec);
      const candidatePaths = [
        ...candidateRelativePaths.map((relative) =>
          wtInfo?.worktreePath ? path.join(wtInfo.worktreePath, relative) : null,
        ),
        ...candidateRelativePaths.map((relative) => (outputRoot ? path.join(outputRoot, relative) : null)),
      ].filter((entry): entry is string => Boolean(entry));

      let verifiedPath: string | null = null;
      let verifiedSize = 0;
      for (const candidate of candidatePaths) {
        if (!fs.existsSync(candidate)) continue;
        try {
          const stat = fs.statSync(candidate);
          if (stat.size > 0) {
            verifiedPath = candidate;
            verifiedSize = stat.size;
            break;
          }
        } catch {
          // best effort
        }
      }

      // Fallback: discover any .mp4 in video_output/ or out/ directories
      if (!verifiedPath) {
        const searchRoots = [wtInfo?.worktreePath, outputRoot].filter(Boolean) as string[];
        for (const root of searchRoots) {
          const discovered = discoverVideoArtifact(root);
          if (discovered) {
            try {
              const stat = fs.statSync(discovered);
              if (stat.size > 0) {
                verifiedPath = discovered;
                verifiedSize = stat.size;
                appendTaskLog(
                  taskId,
                  "system",
                  `Review gate: video artifact discovered via directory scan: ${discovered} (${stat.size} bytes)`,
                );
                break;
              }
            } catch {
              // best effort
            }
          }
        }
      }

      if (!verifiedPath) {
        appendTaskLog(
          taskId,
          "system",
          `Review hold: video artifact gate blocked approval (missing/empty video file). checked=${candidatePaths.join(", ")}`,
        );
        notifyCeo(
          pickL(
            l(
              [
                `'${taskTitle}' 는 영상 산출물(\`${videoArtifactSpec.relativePath}\`)이 확인되지 않아 팀장회의 승인/머지가 보류되었습니다. 렌더 결과를 확인한 뒤 다시 승인해 주세요.`,
              ],
              [
                `'${taskTitle}' approval/merge is on hold because \`${videoArtifactSpec.relativePath}\` is not verified. Verify rendered output first, then approve again.`,
              ],
              [
                `'${taskTitle}' は \`${videoArtifactSpec.relativePath}\` 未確認のため承認/マージが保留されました。レンダー結果確認後に再承認してください。`,
              ],
              [
                `'${taskTitle}' 因 \`${videoArtifactSpec.relativePath}\` 未验证，审批/合并已暂停。请先确认渲染结果后再审批。`,
              ],
            ),
            lang,
          ),
          taskId,
        );
        return;
      }

      appendTaskLog(
        taskId,
        "system",
        `Review gate: video artifact verified for approval (${verifiedPath}, ${verifiedSize} bytes)`,
      );

      const remotionEvidenceTaskIds = new Set<string>([taskId]);
      try {
        const renderDelegatedRows = db
          .prepare(
            `
              SELECT delegated_task_id
              FROM subtasks
              WHERE task_id = ?
                AND title LIKE '%[VIDEO_FINAL_RENDER]%'
                AND delegated_task_id IS NOT NULL
                AND TRIM(delegated_task_id) != ''
            `,
          )
          .all(taskId) as Array<{ delegated_task_id: string | null }>;
        for (const row of renderDelegatedRows) {
          const id = String(row?.delegated_task_id ?? "").trim();
          if (id) remotionEvidenceTaskIds.add(id);
        }
      } catch {
        // best effort
      }
      try {
        const childRows = db
          .prepare(
            `
              SELECT id
              FROM tasks
              WHERE source_task_id = ?
                AND status IN ('in_progress', 'review', 'done')
            `,
          )
          .all(taskId) as Array<{ id: string }>;
        for (const row of childRows) {
          const id = String(row?.id ?? "").trim();
          if (id) remotionEvidenceTaskIds.add(id);
        }
      } catch {
        // best effort
      }

      const remotionGate = evaluateRemotionOnlyGateFromLogFiles({
        logsDir: String(logsDir ?? process.cwd()),
        taskIds: [...remotionEvidenceTaskIds],
      });
      if (!remotionGate.passed) {
        appendTaskLog(
          taskId,
          "system",
          `Review hold: video artifact gate blocked approval (remotion evidence missing/invalid). checked_tasks=${remotionGate.checkedTaskIds.join(", ")}, remotion_tasks=${remotionGate.remotionEvidenceTaskIds.join(", ") || "none"}, forbidden_tasks=${remotionGate.forbiddenEngineTaskIds.join(", ") || "none"}`,
        );
        notifyCeo(
          pickL(
            l(
              [
                `'${taskTitle}' 는 Remotion 렌더 실행 증빙이 확인되지 않아 승인/머지가 보류되었습니다. [VIDEO_FINAL_RENDER]는 Remotion으로 다시 렌더 후 승인해 주세요.`,
              ],
              [
                `'${taskTitle}' approval/merge is on hold because Remotion render evidence was not verified. Re-render [VIDEO_FINAL_RENDER] with Remotion, then approve again.`,
              ],
              [
                `'${taskTitle}' は Remotion レンダー実行の証跡が確認できないため承認/マージを保留しました。[VIDEO_FINAL_RENDER] を Remotion で再レンダー後に再承認してください。`,
              ],
              [
                `'${taskTitle}' 因未验证到 Remotion 渲染证据，审批/合并已暂停。请使用 Remotion 重新渲染 [VIDEO_FINAL_RENDER] 后再审批。`,
              ],
            ),
            lang,
          ),
          taskId,
        );
        return;
      }

      appendTaskLog(
        taskId,
        "system",
        `Review gate: remotion runtime evidence verified (${remotionGate.remotionEvidenceTaskIds.join(", ")})`,
      );
    }

    const finalizeApprovedReview = () => {
      const t = nowMs();
      const latestTask = db.prepare("SELECT status, department_id FROM tasks WHERE id = ?").get(taskId) as
        | { status: string; department_id: string | null }
        | undefined;
      if (!latestTask || latestTask.status !== "review") return;

      // Integrate children before declaring the directive complete. A failed child
      // remains actionable and must not be hidden by a completed parent.
      {
        const children = db
          .prepare("SELECT id, title FROM tasks WHERE source_task_id = ? AND status = 'review' ORDER BY created_at ASC")
          .all(taskId) as Array<{ id: string; title: string }>;
        for (const child of children) {
          finishReview(child.id, child.title);
          const childState = db.prepare("SELECT status FROM tasks WHERE id = ?").get(child.id) as { status: string };
          if (childState.status !== "done") {
            appendTaskLog(taskId, "system", `Finalization held: collaboration task ${child.id} requires revision`);
            return;
          }
        }
      }

      let wtInfo = taskWorktrees.get(taskId);
      let recoveryError = "";
      if (!wtInfo) {
        const project =
          !currentTask.project_path && currentTask.project_id
            ? (db.prepare("SELECT project_path FROM projects WHERE id = ?").get(currentTask.project_id) as
                | { project_path: string | null }
                | undefined)
            : undefined;
        const projectPath = currentTask.project_path || project?.project_path;
        if (projectPath) {
          wtInfo = recoverTaskWorktree(projectPath, taskId, db);
          if (wtInfo) taskWorktrees.set(taskId, wtInfo);
          else if (findTaskBranch(projectPath, taskId)) {
            // An orphaned legacy branch still contains task work. Reattach it
            // instead of approving a task with no in-memory worktree metadata.
            const lifecycle = createWorktreeLifecycleTools({ db, appendTaskLog, taskWorktrees });
            const restored = lifecycle.createWorktree(projectPath, taskId, "review recovery");
            wtInfo = restored ? taskWorktrees.get(taskId) : undefined;
            if (!wtInfo) recoveryError = "Existing task branch could not be recovered; task work requires revision";
          }
        }
      }
      let mergeNote = "";
      if (wtInfo || recoveryError) {
        const mergeResult = recoveryError
          ? { success: false, message: recoveryError, conflicts: undefined }
          : mergeWorktree(wtInfo.projectPath, taskId);
        const integrationBranch = wtInfo?.integrationBranch || wtInfo?.branchName || "unrecovered task branch";
        if (!mergeResult.success) {
          appendTaskLog(taskId, "system", `Directive integration failed: ${mergeResult.message}`);
          const conflictFiles = mergeResult.conflicts?.length ? `\n${mergeResult.conflicts.join(", ")}` : "";
          const revisionNote = pickL(
            l(
              [
                `'${taskTitle}' 통합에 실패했습니다. 담당 에이전트가 기존 작업 트리에서 수정한 뒤 다시 승인받아야 합니다. 통합 브랜치: ${integrationBranch}. 오류: ${mergeResult.message}${conflictFiles}`,
              ],
              [
                `Integration of '${taskTitle}' failed. The owning agent must revise the existing worktree and request approval again. Integration branch: ${integrationBranch}. Error: ${mergeResult.message}${conflictFiles}`,
              ],
              [
                `'${taskTitle}' の統合に失敗しました。担当エージェントは既存の作業ツリーで修正し、再承認を依頼してください。統合ブランチ: ${integrationBranch}。エラー: ${mergeResult.message}${conflictFiles}`,
              ],
              [
                `'${taskTitle}' 集成失败。原负责人须在现有工作树中修订后重新申请审批。集成分支: ${integrationBranch}。错误: ${mergeResult.message}${conflictFiles}`,
              ],
            ),
            lang,
          );
          // Keep the task, its owner, and its worktree for revision instead of
          // creating a sibling task from an outdated base.
          db.prepare(
            "UPDATE tasks SET status = 'planned', completed_at = NULL, description = COALESCE(description, '') || ?, updated_at = ? WHERE id = ?",
          ).run(`\n\n[Integration revision]\n${revisionNote}`, t, taskId);
          const linked = db
            .prepare("SELECT id FROM subtasks WHERE delegated_task_id = ? AND status != 'cancelled'")
            .all(taskId) as Array<{ id: string }>;
          for (const sub of linked) {
            db.prepare(
              "UPDATE subtasks SET status = 'blocked', completed_at = NULL, blocked_reason = ? WHERE id = ?",
            ).run(revisionNote, sub.id);
            broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
          }
          reviewRoundState.delete(taskId);
          reviewInFlight.delete(taskId);
          endTaskExecutionSession(taskId, "integration_revision");
          broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
          notifyTaskStatus(taskId, taskTitle, "planned", lang);
          notifyCeo(revisionNote, taskId);
          const owner = db
            .prepare("SELECT a.* FROM agents a JOIN tasks t ON t.assigned_agent_id = a.id WHERE t.id = ?")
            .get(taskId) as
            | { id: string; status: string; current_task_id: string | null; department_id: string | null }
            | undefined;
          if (owner && owner.status !== "offline" && (owner.status !== "working" || owner.current_task_id === taskId)) {
            const deptId = owner.department_id || latestTask.department_id;
            startTaskExecutionForAgent(taskId, owner, deptId, getDeptName(deptId || ""));
          }
          return;
        }
        appendTaskLog(taskId, "system", `Directive integration completed: ${mergeResult.message}`);
        cleanupWorktree(wtInfo.projectPath, taskId);
        appendTaskLog(taskId, "system", "Worktree cleaned up after successful integration");
        mergeNote = pickL(
          l(
            [` (통합 브랜치: ${integrationBranch}; CEO 수동 검토/병합 대기)`],
            [` (integration branch: ${integrationBranch}; ready for CEO manual review/merge)`],
            [` (統合ブランチ: ${integrationBranch}、CEOの手動レビュー/マージ待ち)`],
            [`（集成分支: ${integrationBranch}；等待 CEO 手动审查/合并）`],
          ),
          lang,
        );
      }

      // The merge policy applies once per directive, to its integration branch, when
      // the root task completes. Child and revision tasks only integrate.
      const directiveRootId = resolveDirectiveRoot(taskId, db).rootTaskId;
      const directiveBranch = `climpire/d-${directiveRootId}`;
      const policyProjectPath =
        wtInfo?.projectPath ||
        currentTask.project_path ||
        (currentTask.project_id
          ? (
              db.prepare("SELECT project_path FROM projects WHERE id = ?").get(currentTask.project_id) as
                | { project_path?: string | null }
                | undefined
            )?.project_path
          : null);
      if (directiveRootId === taskId && policyProjectPath && localBranchExists(policyProjectPath, directiveBranch)) {
        const mergePolicy = resolveTaskMergePolicy(db, currentTask.project_id);
        if (mergePolicy.policy === "manual") {
          // Completion must not mutate the project checkout.
          const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
          const mergeCommand = `git -C ${quote(policyProjectPath)} merge -- ${quote(directiveBranch)}`;
          appendTaskLog(
            taskId,
            "system",
            pickL(
              l(
                [
                  `병합 정책: manual (${mergePolicy.source}). 디렉티브 브랜치를 체크아웃에 병합하지 않았습니다: ${directiveBranch}. 검토 후 프로젝트의 대상 브랜치를 체크아웃하고 ${mergeCommand} 실행 또는 태스크의 '지금 병합'을 사용하세요. 원격 푸시는 별도 작업입니다.`,
                ],
                [
                  `Merge policy: manual (${mergePolicy.source}). Directive branch not merged into the checkout: ${directiveBranch}. Review it, then check out the intended target branch in the project and run ${mergeCommand}, or use Merge now in task details. Remote pushing is a separate action.`,
                ],
                [
                  `マージポリシー: manual (${mergePolicy.source})。ディレクティブブランチはチェックアウトにマージしていません: ${directiveBranch}。レビュー後、プロジェクトで対象ブランチをチェックアウトし ${mergeCommand} を実行するか、タスク詳細の「今すぐマージ」を使用してください。リモートへのプッシュは別操作です。`,
                ],
                [
                  `合并策略: manual (${mergePolicy.source})。指令分支未合并到检出: ${directiveBranch}。审查后，在项目中检出目标分支并运行 ${mergeCommand}，或使用任务详情中的“立即合并”。远程推送需要单独操作。`,
                ],
              ),
              lang,
            ),
          );
          mergeNote = pickL(
            l(
              [` (수동 검토를 위해 디렉티브 브랜치 보존: ${directiveBranch})`],
              [` (directive branch kept for manual review: ${directiveBranch})`],
              [` (手動レビュー用にディレクティブブランチを保持: ${directiveBranch})`],
              [`（保留指令分支以供人工审查: ${directiveBranch}）`],
            ),
            lang,
          );
        } else {
          // Repository metadata never authorizes a remote push or PR creation.
          appendTaskLog(taskId, "system", `Merge policy: auto (${mergePolicy.source}); local merge only`);
          const checkoutMerge = mergeIntoCheckout(policyProjectPath, taskId, directiveBranch);
          if (checkoutMerge.success) {
            appendTaskLog(taskId, "system", `Git merge completed: ${checkoutMerge.message}`);
            mergeNote = pickL(l([" (병합 완료)"], [" (merged)"], [" (マージ完了)"], ["（已合并）"]), lang);
          } else {
            appendTaskLog(taskId, "system", `Git merge failed: ${checkoutMerge.message}`);
            const conflictFiles = checkoutMerge.conflicts?.length ? `\n${checkoutMerge.conflicts.join(", ")}` : "";
            notifyCeo(
              pickL(
                l(
                  [
                    `'${taskTitle}' 디렉티브 브랜치를 체크아웃에 병합하지 못했습니다. 수동 해결이 필요합니다.${conflictFiles}\n브랜치: ${directiveBranch}`,
                  ],
                  [
                    `Could not merge the directive branch for '${taskTitle}' into the checkout. Manual resolution is required.${conflictFiles}\nBranch: ${directiveBranch}`,
                  ],
                  [
                    `'${taskTitle}' のディレクティブブランチをチェックアウトにマージできませんでした。手動解決が必要です。${conflictFiles}\nブランチ: ${directiveBranch}`,
                  ],
                  [
                    `无法将 '${taskTitle}' 的指令分支合并到检出，需要手动解决。${conflictFiles}\n分支: ${directiveBranch}`,
                  ],
                ),
                lang,
              ),
              taskId,
            );
            mergeNote = pickL(
              l(
                [" (병합 충돌 - 수동 해결 필요)"],
                [" (merge conflict - manual resolution required)"],
                [" (マージ競合 - 手動解決が必要)"],
                ["（合并冲突 - 需要手动解决）"],
              ),
              lang,
            );
          }
        }
      }

      db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(t, t, taskId);
      setTaskCreationAuditCompletion(taskId, true);

      appendTaskLog(taskId, "system", "Status → done (all leaders approved)");
      endTaskExecutionSession(taskId, "task_done");

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);
      notifyTaskStatus(taskId, taskTitle, "done", lang);

      refreshCliUsageData()
        .then((usage: unknown) => broadcast("cli_usage_update", usage))
        .catch(() => {});
      const deferTaskReport = shouldDeferTaskReportUntilPlanningArchive(currentTask);
      if (deferTaskReport) {
        appendTaskLog(taskId, "system", "Task report popup deferred until planning consolidated archive is ready");
      } else {
        emitTaskReportEvent(taskId);
      }

      const leader = findTeamLeader(latestTask.department_id);
      const leaderName = leader
        ? getAgentDisplayName(leader, lang)
        : pickL(l(["팀장"], ["Team Lead"], ["チームリーダー"], ["组长"]), lang);
      const subtaskProgressSummary = formatTaskSubtaskProgressSummary(taskId, lang);
      const progressSuffix = subtaskProgressSummary
        ? `\n${pickL(l(["보완/협업 완료 현황"], ["Remediation/Collaboration completion"], ["補完/協業 完了状況"], ["整改/协作完成情况"]), lang)}\n${subtaskProgressSummary}`
        : "";
      notifyCeo(
        pickL(
          l(
            [`${leaderName}: '${taskTitle}' 최종 승인 완료 보고드립니다.${mergeNote}${progressSuffix}`],
            [`${leaderName}: Final approval completed for '${taskTitle}'.${mergeNote}${progressSuffix}`],
            [`${leaderName}: '${taskTitle}' の最終承認が完了しました。${mergeNote}${progressSuffix}`],
            [`${leaderName}：'${taskTitle}' 最终审批已完成。${mergeNote}${progressSuffix}`],
          ),
          lang,
        ),
        taskId,
      );

      reviewRoundState.delete(taskId);
      reviewInFlight.delete(taskId);
      reconcileDelegatedSubtasksAfterRun(taskId, 0);

      if (!currentTask.source_task_id) {
        // Archive one consolidated directive report after every integration succeeds.
        void archivePlanningConsolidatedReport(taskId);
      }

      const nextCallback = crossDeptNextCallbacks.get(taskId);
      if (nextCallback) {
        crossDeptNextCallbacks.delete(taskId);
        nextCallback();
      } else {
        // pause/resume or restart can drop in-memory callback chain; reconstruct from DB when possible
        recoverCrossDeptQueueAfterMissingCallback(taskId);
      }

      const subtaskNext = subtaskDelegationCallbacks.get(taskId);
      if (subtaskNext) {
        subtaskDelegationCallbacks.delete(taskId);
        subtaskNext();
      }
    };

    if (currentTask.source_task_id || options?.skipConsensus) {
      appendTaskLog(taskId, "system", "Review consensus skipped; directive integration is still required");
      finalizeApprovedReview();
      return;
    }

    startReviewConsensusMeeting(taskId, taskTitle, currentTask.department_id, finalizeApprovedReview);
  }

  return {
    reconcileDelegatedSubtasksAfterRun,
    finishReview,
  };
}
