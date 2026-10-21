import { implementationIntentFromTask, implementationPlanningRules } from "../agents/implementation-intent.ts";
import { parsePlanningGraph, validateImplementationCoverage } from "../agents/planning-graph.ts";
import { isPlanningAgent } from "../../routes/collab/planner-selection.ts";

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
    reviewMeetingOneShotTimeoutMs,
  } = deps;

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
      const leaders = getTaskReviewLeaders(taskId, departmentId);
      try {
        const round = (reviewRoundState.get(lockKey) ?? 0) + 1;
        reviewRoundState.set(lockKey, round);

        let hasSupplementSignals = false;
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
        const oneShotTimeoutMs = Math.max(5_000, Number(reviewMeetingOneShotTimeoutMs ?? 65_000));
        const oneShotOptions = { projectPath, timeoutMs: oneShotTimeoutMs, noTools: true };
        const wantsRevision = (content: string): boolean =>
          /보완|수정|보류|리스크|추가.?필요|hold|revise|revision|required|pending|risk|block|保留|修正|补充|暂缓/i.test(
            content,
          );
        const isTimeoutRun = (run: { text?: string; error?: string } | null | undefined): boolean => {
          const source = `${run?.error ?? ""}\n${run?.text ?? ""}`;
          return /timeout after|timed out|request timed out|aborted/i.test(source);
        };
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
            return {
              leader,
              text: String(run.text).trim(),
              displayText: chooseSafeReply(run, lang, "feedback", leader),
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
          if (wantsRevision(draft.value.text)) hasSupplementSignals = true;
        }

        const summaryPrompt = buildMeetingPrompt(planningLeader, {
          meetingType: "planned",
          planningPhase: "consolidation",
          ...implementationIntent,
          round,
          taskTitle,
          taskDescription,
          workflowPackKey: taskWorkflowPackKey,
          transcript,
          turnObjective: `Consolidate the department drafts into one executable plan. Preserve department ownership and explicit prerequisites; do not redraft their work. End with a JSON fenced block: {"plan_items":[{"key":"stable_local_key","title":"Action","description":"Evidence and checks","department_id":"actual_department_id","depends_on":[]}]}. Use local keys in depends_on only for real prerequisites, including cross-department dependencies; never invent department-order dependencies. Every item must name its owning department. The server will resolve keys into subtask IDs; independent items start together. Department IDs: ${[...new Set(leaders.map((leader: any) => leader.department_id).filter(Boolean))].join(", ")}.`,
          stanceHint: "Keep kickoff moving and show concrete planned next steps instead of blocking.",
          lang,
        });
        let summaryRun = await runMeetingOneShotWithRetry(planningLeader, summaryPrompt, "summary");
        if (abortIfInactive()) return;
        if (summaryRun?.error || isTimeoutRun(summaryRun)) {
          throw new Error(summaryRun?.error || "Planning consolidation did not complete");
        }
        let graph: ReturnType<typeof parsePlanningGraph> = null;
        for (let attempt = 0; attempt <= 2; attempt++) {
          let reasons: string[];
          try {
            graph = parsePlanningGraph(String(summaryRun?.text ?? ""));
            reasons = validateImplementationCoverage(graph, implementationIntent);
            if (graph) {
              for (const item of graph) {
                if (!db.prepare("SELECT id FROM departments WHERE id = ?").get(item.department_id))
                  reasons.push(
                    `Unknown department ${item.department_id} for ${item.key}; use an existing department ID.`,
                  );
              }
            }
          } catch (error) {
            if (!implementationIntent.requiresImplementation) throw error;
            reasons = [error instanceof Error ? error.message : String(error)];
          }
          if (reasons.length === 0) break;
          appendTaskLog(taskId, "error", `Planning graph rejected (attempt ${attempt + 1}): ${reasons.join(" ")}`);
          if (attempt === 2)
            throw new Error(`Implementation coverage blocked after correction attempts: ${reasons.join(" ")}`);
          const repairPrompt = `${summaryPrompt}\n\n[Correct rejected planning graph]\n${reasons.join("\n")}\n${implementationPlanningRules(implementationIntent)}\nPrevious rejected output:\n${String(summaryRun?.text ?? "")}\nReturn a complete corrected graph preserving valid items and real prerequisite keys.`;
          summaryRun = await runMeetingOneShotWithRetry(planningLeader, repairPrompt, "summary");
          if (abortIfInactive()) return;
          if (summaryRun?.error || isTimeoutRun(summaryRun))
            throw new Error(summaryRun?.error || "Planning correction did not complete");
        }
        const summaryText = chooseSafeReply(summaryRun, lang, "summary", planningLeader);
        speak(planningLeader, "report", "all", null, summaryText);
        const planItems = graph ? [JSON.stringify({ plan_items: graph })] : collectPlannedActionItems(transcript, 10);
        const memoItems = graph
          ? graph.map(
              (item) =>
                `${item.department_id}: ${item.title}${item.depends_on.length ? ` (depends on: ${item.depends_on.join(", ")})` : ""}`,
            )
          : planItems;
        appendTaskProjectMemo(taskId, "planned", round, memoItems, lang);
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
        const errLang = resolveLang(taskTitle);
        notifyCeo(
          pickL(
            l(
              [`[CEO OFFICE] '${taskTitle}' Planned 회의 처리 중 오류가 발생했습니다: ${msg}`],
              [`[CEO OFFICE] Error while processing planned meeting for '${taskTitle}': ${msg}`],
              [`[CEO OFFICE] '${taskTitle}' のPlanned会議処理中にエラーが発生しました: ${msg}`],
              [`[CEO OFFICE] 处理'${taskTitle}'的 Planned 会议时发生错误：${msg}`],
            ),
            errLang,
          ),
          taskId,
        );
        if (meetingId) finishMeetingMinutes(meetingId, "failed");
        dismissLeadersFromCeoOffice(taskId, leaders);
        reviewInFlight.delete(lockKey);
      }
    })();
  }

  return {
    startPlannedApprovalMeeting,
  };
}
