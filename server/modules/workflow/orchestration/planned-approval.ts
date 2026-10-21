import { implementationIntentFromTask, implementationPlanningRules } from "../agents/implementation-intent.ts";
import {
  parsePlanningGraph,
  validateImplementationCoverage,
  repairImplementationCoverage,
} from "../agents/planning-graph.ts";
import { resolveMeetingVerdict, planningWorkFromVerdict, meetingVerdictClarification } from "../meeting-verdict.ts";
import { formatMeetingVerdict, stripMeetingVerdict } from "../../../../src/lib/meeting-verdict.ts";
import type { MeetingReviewDecision } from "../core/conversation-types.ts";
import { mergeOversizedPlanningGraph, PLANNING_ITEM_TARGET } from "./planning-graph-size.ts";
import { isPlanningAgent } from "../../routes/collab/planner-selection.ts";
import { isTimeoutRun } from "../core/meeting-run.ts";

type CreatePlannedApprovalToolsDeps = {
  reviewInFlight: Set<string>;
  reviewRoundState: Map<string, number>;
  db: any;
  getTaskReviewLeaders: (...args: any[]) => any[];
  resolveProjectPath: (...args: any[]) => any;
  resolveLang: (...args: any[]) => any;
  beginMeetingMinutes: (...args: any[]) => any;
  isTaskWorkflowInterrupted: (...args: any[]) => any;
  getTaskStatusById: (...args: any[]) => any;
  finishMeetingMinutes: (...args: any[]) => any;
  dismissLeadersFromCeoOffice: (...args: any[]) => any;
  clearTaskWorkflowState: (...args: any[]) => any;
  getAgentDisplayName: (...args: any[]) => any;
  getDeptName: (...args: any[]) => any;
  getRoleLabel: (...args: any[]) => any;
  sendAgentMessage: (...args: any[]) => any;
  emitMeetingSpeech: (...args: any[]) => any;
  appendMeetingMinuteEntry: (...args: any[]) => any;
  callLeadersToCeoOffice: (...args: any[]) => any;
  notifyCeo: (...args: any[]) => any;
  pickL: (...args: any[]) => any;
  l: (...args: any[]) => any;
  buildMeetingPrompt: (...args: any[]) => any;
  runAgentOneShot: (...args: any[]) => Promise<any>;
  chooseSafeReply: (...args: any[]) => any;
  sleepMs: (...args: any[]) => Promise<void>;
  randomDelay: (...args: any[]) => any;
  collectPlannedActionItems: (...args: any[]) => any[];
  appendTaskProjectMemo: (...args: any[]) => any;
  appendTaskLog: (...args: any[]) => any;
  broadcast?: (...args: any[]) => any;
  classifyMeetingReviewDecision: (text: string) => MeetingReviewDecision;
  reviewMeetingOneShotTimeoutMs?: number;
};

export function createPlannedApprovalTools(deps: CreatePlannedApprovalToolsDeps) {
  const {
    reviewInFlight,
    reviewRoundState,
    db,
    getTaskReviewLeaders,
    resolveProjectPath,
    resolveLang,
    beginMeetingMinutes,
    isTaskWorkflowInterrupted,
    getTaskStatusById,
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice,
    clearTaskWorkflowState,
    getAgentDisplayName,
    getDeptName,
    getRoleLabel,
    sendAgentMessage,
    emitMeetingSpeech,
    appendMeetingMinuteEntry,
    callLeadersToCeoOffice,
    notifyCeo,
    pickL,
    l,
    buildMeetingPrompt,
    runAgentOneShot,
    chooseSafeReply,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskLog,
    classifyMeetingReviewDecision,
    reviewMeetingOneShotTimeoutMs,
    broadcast,
  } = deps;

  function markPlanningAttention(taskId: string, reason: string): void {
    db.prepare("UPDATE tasks SET status = 'pending', planning_attention_reason = ?, updated_at = ? WHERE id = ?").run(
      reason,
      Date.now(),
      taskId,
    );
    db.prepare(
      "UPDATE agents SET current_task_id = NULL WHERE current_task_id = ? AND status IN ('idle', 'break')",
    ).run(taskId);
    broadcast?.("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    appendTaskLog(taskId, "error", `Planning needs attention: ${reason}. Retry planning meeting from the task card.`);
  }

  function startPlannedApprovalMeeting(
    taskId: string,
    taskTitle: string,
    departmentId: string | null,
    onApproved: (planningNotes?: string[]) => void,
  ): void {
    const lockKey = `planned:${taskId}`;
    if (reviewInFlight.has(lockKey)) {
      return;
    }
    reviewInFlight.add(lockKey);

    void (async () => {
      let meetingId: string | null = null;
      let leaders: any[] = [];
      try {
        leaders = getTaskReviewLeaders(taskId, departmentId);
        const round = (reviewRoundState.get(lockKey) ?? 0) + 1;
        reviewRoundState.set(lockKey, round);

        let hasSupplementSignals = false;
        let hasMissingVerdicts = false;
        const seatIndexByAgent = new Map(leaders.slice(0, 6).map((leader: any, idx: number) => [leader.id, idx]));

        const taskCtx = db
          .prepare("SELECT description, project_path, workflow_pack_key, assigned_agent_id FROM tasks WHERE id = ?")
          .get(taskId) as
          | {
              description: string | null;
              project_path: string | null;
              workflow_pack_key: string | null;
              assigned_agent_id: string | null;
            }
          | undefined;
        const implementationIntent = implementationIntentFromTask(taskTitle, taskCtx?.description);
        if (leaders.length === 0) {
          if (implementationIntent.requiresImplementation)
            throw new Error(
              "Implementation planning blocked: no eligible planning leaders; Development code coverage cannot be approved.",
            );
          reviewInFlight.delete(lockKey);
          onApproved([]);
          return;
        }
        const assignedPlanner = taskCtx?.assigned_agent_id
          ? db.prepare("SELECT * FROM agents WHERE id = ?").get(taskCtx.assigned_agent_id)
          : null;
        const planningLeader =
          assignedPlanner && isPlanningAgent(assignedPlanner)
            ? assignedPlanner
            : (leaders.find((leader: any) => leader.department_id === "planning") ?? leaders[0]);
        if (!leaders.some((leader: any) => leader.id === planningLeader.id)) leaders.unshift(planningLeader);
        const otherLeaders = leaders.filter((leader: any) => leader.id !== planningLeader.id);
        const taskDescription = taskCtx?.description ?? null;
        const taskWorkflowPackKey = taskCtx?.workflow_pack_key ?? null;
        const projectPath = resolveProjectPath({
          title: taskTitle,
          description: taskDescription,
          project_path: taskCtx?.project_path ?? null,
        });
        const lang = resolveLang(taskDescription ?? taskTitle);
        const transcript: any[] = [];
        const informationalNotes: string[] = [];
        const workTranscript: any[] = [];
        const oneShotTimeoutMs = Math.max(5_000, Number(reviewMeetingOneShotTimeoutMs ?? 65_000));
        const oneShotOptions = { projectPath, timeoutMs: oneShotTimeoutMs, noTools: true };
        const compactPromptForRetry = (prompt: string): string => {
          const raw = String(prompt ?? "");
          const maxHead = 2600;
          const maxTail = 1400;
          const compacted =
            raw.length > maxHead + maxTail + 64
              ? `${raw.slice(0, maxHead)}\n\n[...timeout retry compacted...]\n\n${raw.slice(-maxTail)}`
              : raw;
          return `${compacted}\n\n[retry] Previous attempt timed out. Respond concisely in short actionable points.`;
        };
        const runMeetingOneShotWithRetry = async (
          agent: any,
          prompt: string,
          phase: "opening" | "feedback" | "summary" | "approval",
        ): Promise<any> => {
          const options =
            phase === "summary" || phase === "feedback" ? { ...oneShotOptions, rawOutput: true } : oneShotOptions;
          const first = await runAgentOneShot(agent, prompt, options);
          if (!isTimeoutRun(first)) return first;
          appendTaskLog(taskId, "system", `Planned meeting ${phase} timed out (${oneShotTimeoutMs}ms); retrying once`);
          const retryPrompt =
            phase === "summary"
              ? `${prompt}\n\n[retry] Previous attempt timed out. Return a concise complete plan, preserving all item and prerequisite keys from every department draft.`
              : compactPromptForRetry(prompt);
          const second = await runAgentOneShot(agent, retryPrompt, options);
          if (isTimeoutRun(second)) {
            appendTaskLog(taskId, "system", `Planned meeting ${phase} retry timed out (${oneShotTimeoutMs}ms)`);
          }
          return second;
        };
        meetingId = beginMeetingMinutes(taskId, "planned", round, taskTitle);
        let minuteSeq = 1;
        const abortIfInactive = (): boolean => {
          if (!isTaskWorkflowInterrupted(taskId)) return false;
          const status = getTaskStatusById(taskId);
          if (meetingId) finishMeetingMinutes(meetingId, "failed");
          dismissLeadersFromCeoOffice(taskId, leaders);
          clearTaskWorkflowState(taskId);
          if (status) {
            appendTaskLog(taskId, "system", `Planned meeting aborted due to task state change (${status})`);
          }
          return true;
        };

        const pushTranscript = (leader: any, content: string) => {
          transcript.push({
            speaker_agent_id: leader.id,
            speaker: getAgentDisplayName(leader, lang),
            department: getDeptName(leader.department_id ?? "", taskWorkflowPackKey),
            role: getRoleLabel(leader.role, lang),
            content,
          });
        };
        const speak = (
          leader: any,
          messageType: string,
          receiverType: string,
          receiverId: string | null,
          content: string,
          planningContent = content,
        ) => {
          if (isTaskWorkflowInterrupted(taskId)) return;
          sendAgentMessage(leader, content, messageType, receiverType, receiverId, taskId);
          const seatIndex = seatIndexByAgent.get(leader.id) ?? 0;
          emitMeetingSpeech(leader.id, seatIndex, "kickoff", taskId, content, lang);
          pushTranscript(leader, planningContent);
          if (meetingId) {
            appendMeetingMinuteEntry(meetingId, minuteSeq++, leader, lang, messageType, content, taskWorkflowPackKey);
          }
        };

        if (abortIfInactive()) return;
        callLeadersToCeoOffice(taskId, leaders, "kickoff");
        notifyCeo(
          pickL(
            l(
              [
                `[CEO OFFICE] '${taskTitle}' Planned 계획 라운드 ${round} 시작. 부서별 보완점 수집 후 실행계획(SubTask)으로 정리합니다.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' planned round ${round} started. Collecting supplement points and turning them into executable subtasks.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' のPlanned計画ラウンド${round}を開始。補完項目を収集し、実行SubTaskへ落とし込みます。`,
              ],
              [`[CEO OFFICE] 已开始'${taskTitle}'第${round}轮 Planned 规划，正在收集补充点并转为可执行 SubTask。`],
            ),
            lang,
          ),
          taskId,
        );

        // Department leaders receive the same initial context and draft together.
        // The planning lead consumes their complete drafts only in consolidation.
        const draftLeaders = otherLeaders.length > 0 ? otherLeaders : [planningLeader];
        const draftTranscript = [...transcript];
        const drafts = await Promise.allSettled(
          draftLeaders.map(async (leader: any) => {
            const draftPrompt = buildMeetingPrompt(leader, {
              meetingType: "planned",
              planningPhase: "draft",
              ...implementationIntent,
              verdictRequired: true,
              round,
              taskTitle,
              taskDescription,
              workflowPackKey: taskWorkflowPackKey,
              transcript: draftTranscript,
              turnObjective:
                "Draft your department's executable plan: concrete work items, owner, evidence/checks, and stable local item keys with explicit prerequisite keys only where work truly depends on another item. Independent items must start in parallel.",
              stanceHint:
                "Own your department's plan. Do not wait for the origin department or invent dependencies based on department order. Return actionable items for the planning lead to consolidate.",
              lang,
            });
            const run = await runMeetingOneShotWithRetry(leader, draftPrompt, "feedback");
            if (run?.error || isTimeoutRun(run) || !String(run?.text ?? "").trim()) {
              throw new Error(run?.error || "Department planning draft did not complete");
            }
            const resolved = await resolveMeetingVerdict({
              text: String(run.text),
              lang,
              reviewer: leader.id,
              phase: "planned draft",
              retry: (prompt) => runAgentOneShot(leader, prompt, { ...oneShotOptions, rawOutput: true }),
              log: (message) => appendTaskLog(taskId, "system", message),
            });
            const workText = planningWorkFromVerdict(String(run.text), resolved.verdict);
            return {
              leader,
              verdict: resolved.verdict,
              workText,
              text: `${workText}\n\n${formatMeetingVerdict({ ...resolved.verdict, non_blocking_notes: [] })}`,
              displayText: `${chooseSafeReply({ ...run, text: stripMeetingVerdict(String(run.text)) }, lang, "feedback", leader)}\n\n${formatMeetingVerdict(resolved.verdict)}`,
            };
          }),
        );
        if (abortIfInactive()) return;
        for (const draft of drafts) {
          if (draft.status === "rejected") throw draft.reason;
          speak(
            draft.value.leader,
            "status_update",
            "agent",
            planningLeader.id,
            draft.value.displayText,
            draft.value.text,
          );
          workTranscript.push({
            speaker_agent_id: draft.value.leader.id,
            speaker: getAgentDisplayName(draft.value.leader, lang),
            department: getDeptName(draft.value.leader.department_id ?? "", taskWorkflowPackKey),
            role: getRoleLabel(draft.value.leader.role, lang),
            content: draft.value.workText,
          });
          if (draft.value.verdict.verdict === "no_verdict") hasMissingVerdicts = true;
          if (classifyMeetingReviewDecision(draft.value.text) === "hold") hasSupplementSignals = true;
          informationalNotes.push(
            ...draft.value.verdict.non_blocking_notes.map(
              (note) => `${getAgentDisplayName(draft.value.leader, lang)}: ${note}`,
            ),
          );
        }

        const summaryPrompt = buildMeetingPrompt(planningLeader, {
          meetingType: "planned",
          planningPhase: "consolidation",
          ...implementationIntent,
          verdictRequired: true,
          round,
          taskTitle,
          taskDescription,
          workflowPackKey: taskWorkflowPackKey,
          transcript,
          turnObjective: `Consolidate the department drafts into one executable plan. Preserve department ownership and explicit prerequisites; do not redraft their work. Include a JSON fenced plan block before the verdict metadata block and final APPROVE/REVISE line: {"plan_items":[{"key":"stable_local_key","title":"Action","description":"Evidence and checks","department_id":"actual_department_id","depends_on":[]}]}. Use local keys in depends_on only for real prerequisites, including cross-department dependencies; never invent department-order dependencies. Every item must name its owning department. The server will resolve keys into subtask IDs; independent items start together. Department IDs: ${[...new Set(leaders.map((leader: any) => leader.department_id).filter(Boolean))].join(", ")}.`,
          stanceHint:
            "Keep kickoff moving and show concrete planned next steps. Nonblocking reviewer notes are informational only; never turn them into plan_items or remediation work.",
          lang,
        });
        let summaryRun = await runMeetingOneShotWithRetry(planningLeader, summaryPrompt, "summary");
        if (abortIfInactive()) return;
        if (summaryRun?.error || isTimeoutRun(summaryRun)) {
          throw new Error(summaryRun?.error || "Planning consolidation did not complete");
        }
        let graph: ReturnType<typeof parsePlanningGraph> = null;
        const graphViolations = (items: ReturnType<typeof parsePlanningGraph>): string[] => {
          const reasons = validateImplementationCoverage(items, implementationIntent);
          for (const item of items ?? []) {
            if (!db.prepare("SELECT id FROM departments WHERE id = ?").get(item.department_id))
              reasons.push(`Unknown department ${item.department_id} for ${item.key}; use an existing department ID.`);
          }
          return reasons;
        };
        for (let attempt = 0; attempt <= 1; attempt++) {
          let reasons: string[];
          try {
            graph = null;
            // The trailing verdict block is metadata, not part of the plan.
            graph = parsePlanningGraph(stripMeetingVerdict(String(summaryRun?.text ?? "")));
            reasons = graphViolations(graph);
          } catch (error) {
            if (!implementationIntent.requiresImplementation) throw error;
            reasons = [error instanceof Error ? error.message : String(error)];
          }
          if (reasons.length === 0) break;
          appendTaskLog(taskId, "error", `Planning graph rejected (attempt ${attempt + 1}): ${reasons.join(" ")}`);
          if (attempt === 1) {
            if (implementationIntent.requiresImplementation && graph) {
              try {
                const repaired = repairImplementationCoverage(graph, implementationIntent);
                graph = parsePlanningGraph(JSON.stringify({ plan_items: repaired }));
                reasons = graphViolations(graph);
                if (reasons.length === 0) {
                  appendTaskLog(
                    taskId,
                    "system",
                    "Planning graph repaired: added missing Development deliverables and implementation prerequisites; revalidation passed.",
                  );
                  break;
                }
              } catch (error) {
                reasons = [error instanceof Error ? error.message : String(error)];
              }
            }
            throw new Error(
              `Implementation coverage blocked after correction attempts and repair: ${reasons.join(" ")}`,
            );
          }
          const repairPrompt = `${summaryPrompt}\n\n[Correct rejected planning graph]\n${reasons.join("\n")}\n${implementationPlanningRules(implementationIntent)}\nPrevious rejected output:\n${String(summaryRun?.text ?? "")}\nReturn a complete corrected graph preserving valid items and real prerequisite keys.`;
          summaryRun = await runMeetingOneShotWithRetry(planningLeader, repairPrompt, "summary");
          if (abortIfInactive()) return;
          if (summaryRun?.error || isTimeoutRun(summaryRun))
            throw new Error(summaryRun?.error || "Planning correction did not complete");
        }
        if (graph && graph.length > PLANNING_ITEM_TARGET) {
          const validated = graph;
          const merged = await mergeOversizedPlanningGraph(
            "```json\n" + JSON.stringify({ plan_items: validated }) + "\n```",
            (prompt) => runAgentOneShot(planningLeader, prompt, { ...oneShotOptions, rawOutput: true }),
            (message) => appendTaskLog(taskId, "system", message),
          );
          if (abortIfInactive()) return;
          const mergedViolations = merged ? graphViolations(merged) : ["merge returned no graph"];
          if (merged && mergedViolations.length === 0) graph = merged;
          else
            appendTaskLog(
              taskId,
              "system",
              `Planning graph merge kept the validated plan: merged graph failed coverage (${mergedViolations.join(" ")})`,
            );
        }
        const summaryVerdict = await resolveMeetingVerdict({
          text: String(summaryRun?.text ?? ""),
          lang,
          reviewer: planningLeader.id,
          phase: "planned consolidation",
          retry: (prompt) => runAgentOneShot(planningLeader, prompt, { ...oneShotOptions, rawOutput: true }),
          log: (message) => appendTaskLog(taskId, "system", message),
        });
        if (abortIfInactive()) return;
        informationalNotes.push(
          ...summaryVerdict.verdict.non_blocking_notes.map(
            (note) => `${getAgentDisplayName(planningLeader, lang)}: ${note}`,
          ),
        );
        if (classifyMeetingReviewDecision(formatMeetingVerdict(summaryVerdict.verdict)) === "hold")
          hasSupplementSignals = true;
        const summaryText = `${chooseSafeReply({ ...summaryRun, text: stripMeetingVerdict(String(summaryRun?.text ?? "")) }, lang, "summary", planningLeader)}\n\n${formatMeetingVerdict(summaryVerdict.verdict)}`;
        speak(planningLeader, "report", "all", null, summaryText);
        if (hasMissingVerdicts || summaryVerdict.verdict.verdict === "no_verdict") {
          if (informationalNotes.length)
            appendTaskProjectMemo(taskId, "planned", round, [...new Set(informationalNotes)], lang, "non_blocking");
          appendTaskLog(taskId, "system", `Planned meeting round ${round}: no verdict; clarification required`);
          notifyCeo(`[CEO OFFICE] '${taskTitle}': ${meetingVerdictClarification(lang)}`, taskId);
          if (meetingId) finishMeetingMinutes(meetingId, "failed");
          dismissLeadersFromCeoOffice(taskId, leaders);
          reviewRoundState.delete(lockKey);
          reviewInFlight.delete(lockKey);
          markPlanningAttention(taskId, "A planning reviewer did not provide a structured verdict after clarification");
          return;
        }
        // Only stripped department drafts feed fallback work. Consolidation repeats
        // those drafts, and verdict notes are informational rather than executable.
        const planItems = graph
          ? [JSON.stringify({ plan_items: graph })]
          : collectPlannedActionItems(workTranscript, 10);
        const memoItems = graph
          ? graph.map(
              (item) =>
                `${item.department_id}: ${item.title}${item.depends_on.length ? ` (depends on: ${item.depends_on.join(", ")})` : ""}`,
            )
          : planItems;
        if (memoItems.length) appendTaskProjectMemo(taskId, "planned", round, memoItems, lang);
        if (informationalNotes.length)
          appendTaskProjectMemo(taskId, "planned", round, [...new Set(informationalNotes)], lang, "non_blocking");
        appendTaskLog(
          taskId,
          "system",
          `Planned meeting round ${round}: action items collected (${memoItems.length}, supplement-signals=${hasSupplementSignals ? "yes" : "no"})`,
        );
        notifyCeo(
          pickL(
            l(
              [
                `[CEO OFFICE] '${taskTitle}' Planned 회의 종료. 보완점 ${memoItems.length}건을 계획 항목으로 기록하고 In Progress로 진행합니다.`,
              ],
              [
                `[CEO OFFICE] Planned meeting for '${taskTitle}' is complete. Recorded ${memoItems.length} improvement items and moving to In Progress.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' のPlanned会議が完了。補完項目${memoItems.length}件を計画化し、In Progressへ進みます。`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' 的 Planned 会议已结束，已记录 ${memoItems.length} 个改进项并转入 In Progress。`,
              ],
            ),
            lang,
          ),
          taskId,
        );
        if (meetingId) finishMeetingMinutes(meetingId, "completed");
        dismissLeadersFromCeoOffice(taskId, leaders);
        db.prepare("UPDATE tasks SET planning_meeting_failures = 0, planning_attention_reason = NULL WHERE id = ?").run(
          taskId,
        );
        reviewRoundState.delete(lockKey);
        reviewInFlight.delete(lockKey);
        onApproved(planItems);
      } catch (err: any) {
        if (isTaskWorkflowInterrupted(taskId)) {
          if (meetingId) finishMeetingMinutes(meetingId, "failed");
          dismissLeadersFromCeoOffice(taskId, leaders);
          clearTaskWorkflowState(taskId);
          return;
        }
        const msg = err?.message ? String(err.message) : String(err);
        appendTaskLog(taskId, "error", `Planned meeting error: ${msg}`);
        db.prepare(
          "UPDATE agents SET current_task_id = NULL WHERE current_task_id = ? AND status IN ('idle', 'break')",
        ).run(taskId);
        if (meetingId) finishMeetingMinutes(meetingId, "failed");
        dismissLeadersFromCeoOffice(taskId, leaders);
        reviewInFlight.delete(lockKey);
        db.prepare(
          "UPDATE tasks SET planning_meeting_failures = COALESCE(planning_meeting_failures, 0) + 1 WHERE id = ?",
        ).run(taskId);
        const failureState = db.prepare("SELECT planning_meeting_failures FROM tasks WHERE id = ?").get(taskId) as
          | { planning_meeting_failures: number }
          | undefined;
        if (failureState?.planning_meeting_failures === 1) {
          appendTaskLog(taskId, "system", `Automatic re-queue: planned meeting failed; retrying once: ${msg}`);
          startPlannedApprovalMeeting(taskId, taskTitle, departmentId, onApproved);
          return;
        }
        markPlanningAttention(taskId, msg);
        const errLang = resolveLang(taskTitle);
        notifyCeo(
          pickL(
            l(
              [
                `[CEO OFFICE] '${taskTitle}' Planned 회의가 재시도 후에도 실패하여 확인이 필요합니다: ${msg}. 작업 카드에서 계획 회의를 재시도하세요.`,
              ],
              [
                `[CEO OFFICE] Planned meeting for '${taskTitle}' failed after one retry and needs attention: ${msg}. Use Retry planning meeting on the task card.`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' のPlanned会議が再試行後も失敗し、確認が必要です: ${msg}。タスクカードから計画会議を再試行してください。`,
              ],
              [
                `[CEO OFFICE] '${taskTitle}' 的 Planned 会议在重试后仍失败，需要关注：${msg}。请在任务卡中重试规划会议。`,
              ],
            ),
            errLang,
          ),
          taskId,
        );
      }
    })();
  }

  return {
    startPlannedApprovalMeeting,
  };
}
