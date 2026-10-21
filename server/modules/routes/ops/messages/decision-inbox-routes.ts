import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow } from "../../shared/types.ts";
import type { DecisionInboxRouteItem } from "./decision-inbox/types.ts";
import {
  createDecisionInboxMessengerBridge,
  type DecisionReplyBridgeInput,
  type DecisionReplyBridgeResult,
} from "./decision-inbox/messenger-bridge.ts";
import { handleProjectReviewDecisionReply } from "./decision-inbox/project-review-reply.ts";
import { handleReviewRoundDecisionReply } from "./decision-inbox/review-round-reply.ts";
import { handleTimeoutResumeDecisionReply } from "./decision-inbox/timeout-reply.ts";
import { createProjectAndTimeoutDecisionItems } from "./decision-inbox/project-timeout-items.ts";
import { createReviewRoundDecisionItems } from "./decision-inbox/review-round-items.ts";
import { createDecisionStateHelpers } from "./decision-inbox/state-helpers.ts";
import { createProjectReviewPlanningHelpers } from "./decision-inbox/project-review-planning.ts";
import { createReviewRoundPlanningHelpers } from "./decision-inbox/review-round-planning.ts";
import { readYoloModeEnabled, runYoloDecisionAutopilot } from "./decision-inbox/yolo-mode.ts";
import {
  createReviewAutoStartNoticeItems,
  handleReviewAutoStartNoticeReply,
  isReviewAutoApplyConfigured,
  runReviewAutoApplyAutopilot,
} from "./decision-inbox/review-automation.ts";

export type { DecisionReplyBridgeInput, DecisionReplyBridgeResult };

export type DecisionInboxRouteBridge = {
  tryHandleInboxDecisionReply: (input: DecisionReplyBridgeInput) => Promise<DecisionReplyBridgeResult>;
};

export function registerDecisionInboxRoutes(ctx: RuntimeContext): DecisionInboxRouteBridge {
  const __ctx: RuntimeContext = ctx;
  const {
    app,
    db,
    nowMs,
    activeProcesses,
    appendTaskLog,
    broadcast,
    finishReview,
    getAgentDisplayName,
    getDeptName,
    getPreferredLanguage,
    l,
    pickL,
    findTeamLeader,
    normalizeTextField,
    processSubtaskDelegations,
    resolveLang,
    runAgentOneShot,
    scheduleNextReviewRound,
    seedReviewRevisionSubtasks,
    startTaskExecutionForAgent,
    chooseSafeReply,
  } = __ctx;

  const PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX = "Decision inbox: project review task option selected";
  const REVIEW_DECISION_RESOLVED_LOG_PREFIX = "Decision inbox: review decision resolved";

  const {
    buildProjectReviewSnapshotHash,
    getProjectReviewDecisionState,
    upsertProjectReviewDecisionState,
    buildReviewRoundSnapshotHash,
    getReviewRoundDecisionState,
    upsertReviewRoundDecisionState,
    recordProjectReviewDecisionEvent,
  } = createDecisionStateHelpers({ db, nowMs });

  const { formatPlannerSummaryForDisplay, resolvePlanningLeadMeta, queueProjectReviewPlanningConsolidation } =
    createProjectReviewPlanningHelpers({
      db,
      nowMs,
      l,
      pickL,
      findTeamLeader,
      runAgentOneShot,
      chooseSafeReply,
      getAgentDisplayName,
      getProjectReviewDecisionState,
      recordProjectReviewDecisionEvent,
    });

  const { queueReviewRoundPlanningConsolidation } = createReviewRoundPlanningHelpers({
    db,
    nowMs,
    l,
    pickL,
    findTeamLeader,
    runAgentOneShot,
    chooseSafeReply,
    getAgentDisplayName,
    getReviewRoundDecisionState,
    formatPlannerSummaryForDisplay,
    recordProjectReviewDecisionEvent,
    getProjectReviewDecisionState,
  });

  const { getProjectReviewTaskChoices, buildProjectReviewDecisionItems, buildTimeoutResumeDecisionItems } =
    createProjectAndTimeoutDecisionItems({
      db,
      nowMs,
      getPreferredLanguage,
      pickL,
      l,
      buildProjectReviewSnapshotHash,
      getProjectReviewDecisionState,
      upsertProjectReviewDecisionState,
      resolvePlanningLeadMeta,
      formatPlannerSummaryForDisplay,
      queueProjectReviewPlanningConsolidation,
      PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX,
    });

  const { getReviewDecisionFallbackLabel, getReviewDecisionNotes, buildReviewRoundDecisionItems } =
    createReviewRoundDecisionItems({
      db,
      nowMs,
      getPreferredLanguage,
      pickL,
      l,
      buildReviewRoundSnapshotHash,
      getReviewRoundDecisionState,
      upsertReviewRoundDecisionState,
      resolvePlanningLeadMeta,
      formatPlannerSummaryForDisplay,
      queueReviewRoundPlanningConsolidation,
    });

  const { buildReviewAutoStartNoticeItems } = createReviewAutoStartNoticeItems({ db, getPreferredLanguage, pickL, l });

  function openSupplementRound(
    taskId: string,
    assignedAgentId: string | null,
    fallbackDepartmentId: string | null,
    logPrefix = "Decision inbox",
  ): { started: boolean; reason: string } {
    const branchTs = nowMs();
    db.prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?").run(branchTs, taskId);
    const pendingTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    broadcast("task_update", pendingTask);
    appendTaskLog(taskId, "system", `${logPrefix}: supplement round opened (review -> pending)`);

    if (!assignedAgentId) {
      appendTaskLog(taskId, "system", `${logPrefix}: supplement round pending (no assigned agent)`);
      return { started: false, reason: "no_assignee" };
    }

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(assignedAgentId) as AgentRow | undefined;
    if (!agent) {
      appendTaskLog(taskId, "system", `${logPrefix}: supplement round pending (assigned agent not found)`);
      return { started: false, reason: "agent_not_found" };
    }
    if (agent.status === "offline") {
      appendTaskLog(taskId, "system", `${logPrefix}: supplement round pending (assigned agent offline)`);
      return { started: false, reason: "agent_offline" };
    }
    if (activeProcesses.has(taskId)) {
      return { started: false, reason: "already_running" };
    }
    if (
      agent.status === "working" &&
      agent.current_task_id &&
      agent.current_task_id !== taskId &&
      activeProcesses.has(agent.current_task_id)
    ) {
      appendTaskLog(
        taskId,
        "system",
        `${logPrefix}: supplement round pending (agent busy on ${agent.current_task_id})`,
      );
      return { started: false, reason: "agent_busy" };
    }

    const deptId = agent.department_id ?? fallbackDepartmentId ?? null;
    const deptName = deptId ? getDeptName(deptId) : "Unassigned";
    appendTaskLog(taskId, "system", `${logPrefix}: supplement round execution started`);
    startTaskExecutionForAgent(taskId, agent, deptId, deptName);
    return { started: true, reason: "started" };
  }

  function getDecisionInboxItems(): DecisionInboxRouteItem[] {
    const items = [
      ...buildProjectReviewDecisionItems(),
      ...buildReviewRoundDecisionItems(),
      ...buildTimeoutResumeDecisionItems(),
      ...buildReviewAutoStartNoticeItems(),
    ];
    items.sort((a, b) => b.created_at - a.created_at);
    return items;
  }

  function applyDecisionReply(
    decisionId: string,
    body: Record<string, unknown>,
  ): {
    status: number;
    payload: Record<string, unknown>;
  } {
    const optionNumber = Number(body.option_number ?? body.optionNumber ?? body.option);
    if (!Number.isFinite(optionNumber)) {
      return { status: 400, payload: { error: "option_number_required" } };
    }

    const currentItem = getDecisionInboxItems().find((item) => item.id === decisionId);
    if (!currentItem) {
      return { status: 404, payload: { error: "decision_not_found" } };
    }
    const selectedOption = currentItem.options.find((option) => option.number === optionNumber);
    if (!selectedOption) {
      if (currentItem.options.length <= 0) {
        return { status: 409, payload: { error: "decision_options_not_ready", kind: currentItem.kind } };
      }
      return { status: 400, payload: { error: "option_not_found", option_number: optionNumber } };
    }

    let status = 200;
    let payload: Record<string, unknown> = { ok: true };
    const req = { body } as any;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: Record<string, unknown>) {
        payload = value;
        return this;
      },
    } as any;

    if (
      handleProjectReviewDecisionReply({
        req,
        res,
        currentItem,
        selectedOption,
        optionNumber,
        deps: {
          db,
          appendTaskLog,
          nowMs,
          normalizeTextField,
          getPreferredLanguage,
          pickL,
          l,
          broadcast,
          finishReview,
          getProjectReviewDecisionState,
          recordProjectReviewDecisionEvent,
          getProjectReviewTaskChoices,
          openSupplementRound,
          processSubtaskDelegations,
          PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX,
        },
      })
    ) {
      return { status, payload };
    }

    if (
      handleReviewRoundDecisionReply({
        req,
        res,
        currentItem,
        selectedOption,
        optionNumber,
        deps: {
          db,
          l,
          pickL,
          nowMs,
          resolveLang,
          normalizeTextField,
          appendTaskLog,
          processSubtaskDelegations,
          seedReviewRevisionSubtasks,
          scheduleNextReviewRound,
          getProjectReviewDecisionState,
          getReviewDecisionNotes,
          getReviewDecisionFallbackLabel,
          recordProjectReviewDecisionEvent,
          openSupplementRound,
          REVIEW_DECISION_RESOLVED_LOG_PREFIX,
        },
      })
    ) {
      return { status, payload };
    }

    if (handleReviewAutoStartNoticeReply({ res, currentItem, selectedOption, deps: { db, nowMs } })) {
      return { status, payload };
    }

    if (
      handleTimeoutResumeDecisionReply({
        res,
        currentItem,
        selectedOption,
        deps: {
          db,
          activeProcesses,
          getDeptName,
          appendTaskLog,
          startTaskExecutionForAgent,
        },
      })
    ) {
      return { status, payload };
    }

    return { status: 400, payload: { error: "unknown_decision_id" } };
  }

  const { tryHandleInboxDecisionReply, flushDecisionInboxMessengerNotices, startBackgroundNoticeSync } =
    createDecisionInboxMessengerBridge({
      db,
      nowMs,
      getPreferredLanguage,
      normalizeTextField,
      getDecisionInboxItems,
      applyDecisionReply,
    });

  startBackgroundNoticeSync();

  let reviewAutoApplyInFlight = false;

  const runReviewAutoApply = () => {
    if (reviewAutoApplyInFlight) return;
    if (!isReviewAutoApplyConfigured(db)) return;
    reviewAutoApplyInFlight = true;
    try {
      runReviewAutoApplyAutopilot({
        db,
        getReviewRoundItems: buildReviewRoundDecisionItems,
        applyDecisionReply,
        appendTaskLog,
      });
    } catch (err) {
      console.warn(`[decision-review-auto-apply] autopilot failed: ${String(err)}`);
    } finally {
      reviewAutoApplyInFlight = false;
    }
  };

  let yoloAutopilotInFlight = false;

  const runYoloAutopilot = () => {
    // The narrower review auto-apply setting gets first pick of review rounds.
    runReviewAutoApply();
    if (yoloAutopilotInFlight) return;
    if (!readYoloModeEnabled(db)) return;
    yoloAutopilotInFlight = true;
    try {
      runYoloDecisionAutopilot({
        getDecisionInboxItems,
        applyDecisionReply,
        shouldSkipItem: (item) => {
          if (item.kind === "review_round_pick" && item.task_id) {
            const row = db.prepare("SELECT workflow_pack_key FROM tasks WHERE id = ? LIMIT 1").get(item.task_id) as
              | { workflow_pack_key?: string | null }
              | undefined;
            return row?.workflow_pack_key === "video_preprod";
          }
          if (item.kind === "project_review_ready" && item.project_id) {
            const recentHold = db
              .prepare(
                `
                SELECT 1
                FROM task_logs tl
                JOIN tasks t ON t.id = tl.task_id
                WHERE t.project_id = ?
                  AND t.status = 'review'
                  AND t.source_task_id IS NULL
                  AND t.workflow_pack_key = 'video_preprod'
                  AND tl.kind = 'system'
                  AND tl.message LIKE 'Review hold: video artifact gate blocked approval%'
                  AND tl.created_at >= ?
                ORDER BY tl.created_at DESC
                LIMIT 1
              `,
              )
              .get(item.project_id, nowMs() - 120_000);
            if (recentHold) return true;
          }

          return false;
        },
      });
    } catch (err) {
      console.warn(`[decision-yolo] autopilot failed: ${String(err)}`);
    } finally {
      yoloAutopilotInFlight = false;
    }
  };
  const yoloTimer = setInterval(runYoloAutopilot, 2500);
  (yoloTimer as NodeJS.Timeout).unref?.();
  setTimeout(runYoloAutopilot, 1200);

  // ---------------------------------------------------------------------------
  // Messages / Chat
  // ---------------------------------------------------------------------------
  app.get("/api/decision-inbox", (req, res) => {
    runYoloAutopilot();
    const forceRaw = String((req.query as Record<string, unknown>)?.force ?? "")
      .trim()
      .toLowerCase();
    const forceResend = forceRaw === "1" || forceRaw === "true" || forceRaw === "yes";
    const items = getDecisionInboxItems();
    void flushDecisionInboxMessengerNotices({ force: forceResend }).catch((err) => {
      console.warn(`[decision-messenger] on-demand notice flush failed: ${String(err)}`);
    });
    res.json({ items });
  });

  app.post("/api/decision-inbox/:id/reply", (req, res) => {
    const decisionId = String(req.params.id || "");
    const result = applyDecisionReply(decisionId, (req.body ?? {}) as Record<string, unknown>);
    runYoloAutopilot();
    return res.status(result.status).json(result.payload);
  });

  return {
    tryHandleInboxDecisionReply,
  };
}
