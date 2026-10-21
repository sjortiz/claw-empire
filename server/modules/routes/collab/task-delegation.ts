import { createPersistentWait } from "../../workflow/core/persistent-wait.ts";
import { randomUUID } from "node:crypto";
import { isPlanningAgent, selectPlanningAgent } from "./planner-selection.ts";
import {
  detectImplementationIntent,
  includeImplementationDepartment,
} from "../../workflow/agents/implementation-intent.ts";
import { parsePlanningGraph, validateImplementationCoverage } from "../../workflow/agents/planning-graph.ts";

import type { AgentRow } from "./direct-chat.ts";
import type { DelegationOptions } from "./project-resolution.ts";
import type { Lang } from "../../../types/lang.ts";
import type { L10n } from "./language-policy.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { resolveWorkflowPackKeyForTask } from "../../workflow/packs/task-pack-resolver.ts";
import { isWorkflowPackKey } from "../../workflow/packs/definitions.ts";
import { resolveConstrainedAgentScopeForTask } from "../core/tasks/execution-run-auto-assign.ts";
import {
  buildDelegateMessage,
  buildLeaderAckMessage,
  buildManualFallbackNotice,
  buildSelfExecutionMessage,
  buildSubordinateAckMessage,
} from "./task-delegation-messages.ts";

interface TaskDelegationDeps {
  db: RuntimeContext["db"];
  nowMs: () => number;
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  getDeptName: (deptId: string) => string;
  getRoleLabel: (role: string, lang: Lang) => string;
  detectTargetDepartments: (message: string) => string[];
  findBestSubordinate: (deptId: string, excludeId: string, candidateAgentIds?: string[] | null) => AgentRow | null;
  normalizeTextField: (value: unknown) => string | null;
  resolveProjectFromOptions: (options: DelegationOptions) => {
    id: string | null;
    name: string | null;
    projectPath: string | null;
    coreGoal: string | null;
  };
  buildRoundGoal: (projectCoreGoal: string | null, ceoMessage: string, lang?: Lang) => string;
  resolveDirectiveProjectPath: (
    text: string,
    options: DelegationOptions,
  ) => {
    projectPath: string | null;
    source: string;
  };
  recordTaskCreationAudit: (payload: any) => void;
  appendTaskLog: (taskId: string, source: string, message: string) => void;
  broadcast: (event: string, payload: unknown) => void;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  notifyCeo: (content: string, taskId?: string | null, messageType?: string) => void;
  isTaskWorkflowInterrupted: (taskId: string) => boolean;
  hasOpenForeignSubtasks: (taskId: string, targetDeptIds?: string[]) => boolean;
  processSubtaskDelegations: (taskId: string, opts?: { includeRender?: boolean }) => void;
  startCrossDeptCooperation: (
    mentionedDepts: string[],
    index: number,
    context: {
      teamLeader: AgentRow;
      taskTitle: string;
      ceoMessage: string;
      leaderDeptId: string;
      leaderDeptName: string;
      leaderName: string;
      lang: Lang;
      taskId: string;
      projectId?: string | null;
      projectCandidateAgentIds?: string[] | null;
    },
    onComplete?: () => void,
  ) => void;
  seedApprovedPlanSubtasks: (taskId: string, leaderDeptId: string, planningNotes: string[]) => void;
  startPlannedApprovalMeeting: (
    taskId: string,
    taskTitle: string,
    leaderDeptId: string,
    onApproved: (planningNotes: string[]) => void,
  ) => void;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
  registerTaskMessengerRoute: (taskId: string, options?: DelegationOptions) => void;
  startTaskExecutionForAgent: (taskId: string, agent: AgentRow, leaderDeptId: string, leaderDeptName: string) => void;
}

export function createTaskDelegationHandler(deps: TaskDelegationDeps) {
  function inferPackKeyFromAgentId(agentId: string | null | undefined): string | null {
    const normalized = String(agentId ?? "").trim();
    if (!normalized) return null;
    const matched = normalized.match(/^([a-z0-9_]+)-seed-\d+$/i);
    if (!matched?.[1]) return null;
    const candidate = matched[1].toLowerCase();
    return isWorkflowPackKey(candidate) ? candidate : null;
  }

  const {
    db,
    nowMs,
    resolveLang,
    getDeptName,
    getRoleLabel,
    detectTargetDepartments,
    findBestSubordinate,
    normalizeTextField,
    resolveProjectFromOptions,
    buildRoundGoal,
    resolveDirectiveProjectPath,
    recordTaskCreationAudit,
    appendTaskLog,
    broadcast,
    l,
    pickL,
    notifyCeo,
    isTaskWorkflowInterrupted,
    hasOpenForeignSubtasks,
    processSubtaskDelegations,
    startCrossDeptCooperation,
    seedApprovedPlanSubtasks,
    startPlannedApprovalMeeting,
    sendAgentMessage,
    registerTaskMessengerRoute,
    startTaskExecutionForAgent,
  } = deps;
  const persistentWait = createPersistentWait({ db, nowMs, appendTaskLog, notifyCeo, broadcast });

  function handleTaskDelegation(
    teamLeader: AgentRow,
    ceoMessage: string,
    ceoMsgId: string,
    options: DelegationOptions = {},
  ): void {
    const lang = resolveLang(ceoMessage);
    const skipPlannedMeeting = !!options.skipPlannedMeeting;
    const skipPlanSubtasks = !!options.skipPlanSubtasks;

    // --- Step 1: Team leader acknowledges (1~2 sec) ---
    const ackDelay = 1000 + Math.random() * 1000;
    setTimeout(() => {
      const selectedProject = resolveProjectFromOptions(options);
      const explicitPackKey = inferPackKeyFromAgentId(teamLeader.id);
      const workflowPackKey = resolveWorkflowPackKeyForTask({
        db: db as any,
        explicitPackKey,
        projectId: selectedProject.id,
      });
      const projectCandidateAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
        workflow_pack_key: workflowPackKey,
        department_id: teamLeader.department_id,
        project_id: selectedProject.id,
      });
      const isPlanningLead = isPlanningAgent(teamLeader);
      if (isPlanningLead) {
        const planner = selectPlanningAgent(db, projectCandidateAgentIds, workflowPackKey);
        if (!planner) {
          notifyCeo(
            pickL(
              l(
                ["사용 가능한 기획 담당자가 없습니다. 워크플로 팩과 공급자 연결을 확인하세요."],
                ["No eligible planner is available. Check workflow pack assignments and provider connections."],
                ["利用可能な企画担当者がいません。ワークフローパックの割り当てとプロバイダー接続を確認してください。"],
                ["没有可用的规划人员。请检查工作流包分配和提供商连接。"],
              ),
              lang,
            ),
          );
          return;
        }
        teamLeader = planner;
      }
      const leaderName = lang === "ko" ? teamLeader.name_ko || teamLeader.name : teamLeader.name;
      const leaderDeptId = teamLeader.department_id!;
      const leaderDeptName = getDeptName(leaderDeptId);
      // Keep the selected planner responsible for consolidation and execution.
      // Delegating every root back to the same senior defeats load balancing.
      const subordinate = isPlanningLead
        ? null
        : findBestSubordinate(leaderDeptId, teamLeader.id, projectCandidateAgentIds);
      const manualFallbackToLeader = !isPlanningLead && Array.isArray(projectCandidateAgentIds) && subordinate === null;

      const taskId = randomUUID();
      const t = nowMs();
      const taskTitle = ceoMessage.length > 60 ? ceoMessage.slice(0, 57) + "..." : ceoMessage;
      const projectContextHint = normalizeTextField(options.projectContext) || selectedProject.coreGoal;
      const roundGoal = buildRoundGoal(selectedProject.coreGoal, ceoMessage, lang);
      const { projectPath: detectedPathRaw, source: projectPathSource } = resolveDirectiveProjectPath(ceoMessage, {
        ...options,
        projectPath: options.projectPath ?? selectedProject.projectPath,
        projectContext: projectContextHint,
      });
      const detectedPath = detectedPathRaw || selectedProject.projectPath || null;
      const taskDescriptionLines = [`[CEO] ${ceoMessage}`];
      if (selectedProject.name) taskDescriptionLines.push(`[PROJECT] ${selectedProject.name}`);
      if (selectedProject.coreGoal) taskDescriptionLines.push(`[PROJECT CORE GOAL] ${selectedProject.coreGoal}`);
      taskDescriptionLines.push(`[ROUND GOAL] ${roundGoal}`);
      if (projectContextHint && projectContextHint !== selectedProject.coreGoal) {
        taskDescriptionLines.push(`[PROJECT CONTEXT] ${projectContextHint}`);
      }
      db.prepare(
        `
      INSERT INTO tasks (id, title, description, department_id, assigned_agent_id, project_id, status, priority, task_type, workflow_pack_key, project_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'planned', 1, 'general', ?, ?, ?, ?)
    `,
      ).run(
        taskId,
        taskTitle,
        taskDescriptionLines.join("\n"),
        leaderDeptId,
        teamLeader.id,
        selectedProject.id,
        workflowPackKey,
        detectedPath,
        t,
        t,
      );
      registerTaskMessengerRoute(taskId, options);
      recordTaskCreationAudit({
        taskId,
        taskTitle,
        taskStatus: "planned",
        departmentId: leaderDeptId,
        assignedAgentId: teamLeader.id,
        taskType: "general",
        projectPath: detectedPath ?? null,
        trigger: "workflow.delegation.ceo_message",
        triggerDetail: `skip_planned_meeting=${skipPlannedMeeting}; skip_plan_subtasks=${skipPlanSubtasks}`,
        actorType: "agent",
        actorId: teamLeader.id,
        actorName: teamLeader.name,
        body: {
          ceo_message: ceoMessage,
          options: {
            skip_planned_meeting: skipPlannedMeeting,
            skip_plan_subtasks: skipPlanSubtasks,
            project_id: selectedProject.id,
            project_context: projectContextHint,
            round_goal: roundGoal,
          },
        },
      });
      if (selectedProject.id) {
        db.prepare("UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?").run(t, t, selectedProject.id);
      }
      appendTaskLog(taskId, "system", `CEO → ${leaderName}: ${ceoMessage}`);
      if (selectedProject.id) {
        appendTaskLog(taskId, "system", `Project linked: ${selectedProject.name || selectedProject.id}`);
      }
      appendTaskLog(taskId, "system", `Round goal: ${roundGoal}`);
      if (detectedPath) {
        appendTaskLog(taskId, "system", `Project path resolved (${projectPathSource}): ${detectedPath}`);
      }
      if (projectContextHint) {
        appendTaskLog(taskId, "system", `Project context hint: ${projectContextHint}`);
      }
      if (manualFallbackToLeader) {
        appendTaskLog(
          taskId,
          "system",
          `Manual assignment fallback: no eligible subordinate found among ${(projectCandidateAgentIds ?? []).length} assigned agent(s). Team leader will execute.`,
        );
      }

      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));

      const implementationIntent = detectImplementationIntent(ceoMessage, projectContextHint ?? "");
      const inferredDepartments = detectTargetDepartments(ceoMessage);
      const mentionedDepts = includeImplementationDepartment(inferredDepartments, implementationIntent).filter(
        (d) => d !== leaderDeptId,
      );
      if (implementationIntent.requiresImplementation) {
        appendTaskLog(
          taskId,
          "system",
          `Planning coverage: Development required by code-change intent; units=${implementationIntent.implementationUnits.map((unit) => unit.key).join(", ")}${!inferredDepartments.includes("dev") ? `; override=added dev; inferred=${inferredDepartments.join(", ") || "none"}` : ""}`,
        );
      }

      if (isPlanningLead) {
        const relatedLabel =
          mentionedDepts.length > 0
            ? mentionedDepts.map(getDeptName).join(", ")
            : pickL(l(["없음"], ["None"], ["なし"], ["无"]), lang);
        appendTaskLog(taskId, "system", `Planning pre-check related departments: ${relatedLabel}`);
        notifyCeo(
          pickL(
            l(
              [`[기획팀] '${taskTitle}' 유관부서 사전 파악 완료: ${relatedLabel}`],
              [`[Planning] Related departments identified for '${taskTitle}': ${relatedLabel}`],
              [`[企画] '${taskTitle}' の関連部門の事前把握が完了: ${relatedLabel}`],
              [`[企划] 已完成'${taskTitle}'相关部门预识别：${relatedLabel}`],
            ),
            lang,
          ),
          taskId,
        );
      }

      const runCrossDeptBeforeDelegationIfNeeded = (next: () => void) => {
        if (isTaskWorkflowInterrupted(taskId)) return;
        if (!(isPlanningLead && mentionedDepts.length > 0)) {
          next();
          return;
        }

        const crossDeptNames = mentionedDepts.map(getDeptName).join(", ");
        if (hasOpenForeignSubtasks(taskId, mentionedDepts)) {
          notifyCeo(
            pickL(
              l(
                [`[CEO OFFICE] 기획팀 선행 협업을 서브태스크 통합 디스패처로 실행합니다: ${crossDeptNames}`],
                [`[CEO OFFICE] Running planning pre-collaboration via unified subtask dispatcher: ${crossDeptNames}`],
                [`[CEO OFFICE] 企画先行協業を統合サブタスクディスパッチャで実行します: ${crossDeptNames}`],
                [`[CEO OFFICE] 企划前置协作改为统一 SubTask 调度执行：${crossDeptNames}`],
              ),
              lang,
            ),
            taskId,
          );
          appendTaskLog(
            taskId,
            "system",
            `Planning pre-collaboration unified to batched subtask dispatch (${crossDeptNames})`,
          );
          processSubtaskDelegations(taskId);
          next();
          return;
        }

        notifyCeo(
          pickL(
            l(
              [`[CEO OFFICE] 기획팀 선행 협업 처리 시작: ${crossDeptNames}`],
              [`[CEO OFFICE] Planning pre-collaboration started with: ${crossDeptNames}`],
              [`[CEO OFFICE] 企画チームの先行協業を開始: ${crossDeptNames}`],
              [`[CEO OFFICE] 企划团队前置协作已启动：${crossDeptNames}`],
            ),
            lang,
          ),
          taskId,
        );
        // Mark original task as 'collaborating' while cross-dept work proceeds
        db.prepare("UPDATE tasks SET status = 'collaborating', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
        broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));

        for (const departmentId of mentionedDepts)
          startCrossDeptCooperation([departmentId], 0, {
            teamLeader,
            taskTitle,
            ceoMessage,
            leaderDeptId,
            leaderDeptName,
            leaderName,
            lang,
            taskId,
            projectId: selectedProject.id,
            projectCandidateAgentIds,
          });
        next();
      };

      let usesPlanningGraph = false;
      const runCrossDeptAfterMainIfNeeded = () => {
        if (usesPlanningGraph || isPlanningLead || mentionedDepts.length === 0) return;
        const crossDelay = 3000 + Math.random() * 1000;
        setTimeout(() => {
          if (isTaskWorkflowInterrupted(taskId)) return;
          if (hasOpenForeignSubtasks(taskId, mentionedDepts)) {
            appendTaskLog(
              taskId,
              "system",
              `Cross-dept collaboration unified to batched subtask dispatch (${mentionedDepts.map(getDeptName).join(", ")})`,
            );
            processSubtaskDelegations(taskId);
            return;
          }
          // Only set 'collaborating' if the task hasn't already moved to 'in_progress' (avoid status regression)
          const currentTask = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
            | { status: string }
            | undefined;
          if (currentTask && currentTask.status !== "in_progress") {
            db.prepare("UPDATE tasks SET status = 'collaborating', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
            broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
          }
          startCrossDeptCooperation(mentionedDepts, 0, {
            teamLeader,
            taskTitle,
            ceoMessage,
            leaderDeptId,
            leaderDeptName,
            leaderName,
            lang,
            taskId,
            projectId: selectedProject.id,
            projectCandidateAgentIds,
          });
        }, crossDelay);
      };

      const continueAfterPlan = (planningNotes: string[], afterPlan: () => void) => {
        try {
          const approvedGraph = planningNotes.map(parsePlanningGraph).find((graph) => graph !== null) ?? null;
          const reasons = validateImplementationCoverage(approvedGraph, implementationIntent);
          if (implementationIntent.requiresImplementation && skipPlanSubtasks)
            reasons.push("Implementation task creation cannot be skipped for a code-change directive.");
          if (reasons.length) throw new Error(reasons.join(" "));
          if (!skipPlanSubtasks) seedApprovedPlanSubtasks(taskId, leaderDeptId, planningNotes);
        } catch (error) {
          const message = `Implementation planning blocked: ${error instanceof Error ? error.message : String(error)}`;
          appendTaskLog(taskId, "error", message);
          notifyCeo(message, taskId);
          db.prepare("UPDATE agents SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(
            teamLeader.id,
            taskId,
          );
          return;
        }
        const graph = !skipPlanSubtasks && planningNotes.some((note) => parsePlanningGraph(note) !== null);
        if (!graph) {
          processSubtaskDelegations(taskId);
          runCrossDeptBeforeDelegationIfNeeded(afterPlan);
          return;
        }
        usesPlanningGraph = true;
        // Graph items execute as child tasks, including the origin department.
        // Release the planner's CLI slot and start root consolidation only after
        // all child approvals have integrated their work into the directive tip.
        db.prepare("UPDATE agents SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(
          teamLeader.id,
          taskId,
        );
        db.prepare("UPDATE tasks SET status = 'collaborating', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
        broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
        processSubtaskDelegations(taskId);
        const waitForIntegration = () => {
          if (isTaskWorkflowInterrupted(taskId)) return;
          const latest = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
            | { status: string }
            | undefined;
          if (latest?.status !== "collaborating") return;
          const pending = db
            .prepare(
              `SELECT COUNT(*) AS count FROM subtasks s
            LEFT JOIN tasks child ON child.id = s.delegated_task_id
            WHERE s.task_id = ? AND (s.status NOT IN ('done', 'cancelled')
              OR (s.status = 'done' AND (child.status IS NULL OR child.status != 'done')))`,
            )
            .get(taskId) as { count: number };
          if (pending.count > 0) {
            persistentWait.wait(
              taskId,
              "planning-integration",
              `Planning graph waiting for ${pending.count} child integration(s)`,
              waitForIntegration,
              { delayMs: 1_000, maxWaitMs: 60 * 60_000 },
            );
            return;
          }
          persistentWait.clear(taskId, "planning-integration");
          db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(nowMs(), taskId);
          afterPlan();
        };
        waitForIntegration();
      };

      const runPlanningPhase = (afterPlan: () => void) => {
        const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
          | { status: string }
          | undefined;
        if (current?.status !== "planned") {
          persistentWait.clear(taskId, "planning-agent");
          return;
        }
        if (isTaskWorkflowInterrupted(taskId)) return;
        if (isPlanningLead) {
          const fresh = db.prepare("SELECT * FROM agents WHERE id = ?").get(teamLeader.id) as AgentRow | undefined;
          if (
            !fresh ||
            !["idle", "break"].includes(fresh.status) ||
            (fresh.current_task_id && fresh.current_task_id !== taskId)
          ) {
            persistentWait.wait(
              taskId,
              "planning-agent",
              `Planning phase waiting for planner ${teamLeader.id} (current_task=${fresh?.current_task_id ?? "none"})`,
              () => runPlanningPhase(afterPlan),
            );
            return;
          }
          persistentWait.clear(taskId, "planning-agent");
          db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, teamLeader.id);
        }
        if (skipPlannedMeeting) {
          appendTaskLog(taskId, "system", "Planned meeting skipped by CEO directive");
          continueAfterPlan([], afterPlan);
          return;
        }
        startPlannedApprovalMeeting(taskId, taskTitle, leaderDeptId, (planningNotes: string[]) => {
          if (isTaskWorkflowInterrupted(taskId)) return;
          continueAfterPlan(planningNotes ?? [], afterPlan);
        });
      };

      if (subordinate) {
        const subName = lang === "ko" ? subordinate.name_ko || subordinate.name : subordinate.name;
        const subRole = getRoleLabel(subordinate.role, lang);

        const ackMsg = buildLeaderAckMessage({
          l,
          pickL,
          lang,
          subRole,
          subName,
          skipPlannedMeeting,
          isPlanningLead,
          crossDeptNames: mentionedDepts.map(getDeptName).join(", "),
        });
        sendAgentMessage(teamLeader, ackMsg, "chat", "agent", null, taskId);

        const delegateToSubordinate = () => {
          // --- Step 2: Delegate to subordinate (2~3 sec) ---
          const delegateDelay = 2000 + Math.random() * 1000;
          setTimeout(() => {
            if (isTaskWorkflowInterrupted(taskId)) return;
            const t2 = nowMs();
            db.prepare("UPDATE tasks SET assigned_agent_id = ?, status = 'planned', updated_at = ? WHERE id = ?").run(
              subordinate.id,
              t2,
              taskId,
            );
            db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, subordinate.id);
            appendTaskLog(taskId, "system", `${leaderName} → ${subName}`);

            broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
            broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(subordinate.id));

            const delegateMsg = buildDelegateMessage({ l, pickL, lang, subName, ceoMessage });
            sendAgentMessage(teamLeader, delegateMsg, "task_assign", "agent", subordinate.id, taskId);

            // --- Step 3: Subordinate acknowledges (1~2 sec) ---
            const subAckDelay = 1000 + Math.random() * 1000;
            setTimeout(() => {
              if (isTaskWorkflowInterrupted(taskId)) return;
              const leaderRole = getRoleLabel(teamLeader.role, lang);
              const subAckMsg = buildSubordinateAckMessage({ l, pickL, lang, leaderRole, leaderName });
              sendAgentMessage(subordinate, subAckMsg, "chat", "agent", null, taskId);
              startTaskExecutionForAgent(taskId, subordinate, leaderDeptId, leaderDeptName);
              runCrossDeptAfterMainIfNeeded();
            }, subAckDelay);
          }, delegateDelay);
        };

        runPlanningPhase(delegateToSubordinate);
      } else {
        // No subordinate — team leader handles it themselves
        if (manualFallbackToLeader) {
          notifyCeo(buildManualFallbackNotice({ l, pickL, lang, leaderName }), taskId);
        }
        const selfMsg = buildSelfExecutionMessage({ l, pickL, lang, skipPlannedMeeting });
        sendAgentMessage(teamLeader, selfMsg, "chat", "agent", null, taskId);

        const t2 = nowMs();
        db.prepare("UPDATE tasks SET assigned_agent_id = ?, status = 'planned', updated_at = ? WHERE id = ?").run(
          teamLeader.id,
          t2,
          taskId,
        );
        db.prepare(
          "UPDATE agents SET current_task_id = ? WHERE id = ? AND (current_task_id IS NULL OR current_task_id = '')",
        ).run(taskId, teamLeader.id);
        appendTaskLog(taskId, "system", `${leaderName} self-assigned (planned)`);

        broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(teamLeader.id));

        const startWhenAvailable = () => {
          const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
            | { status: string }
            | undefined;
          if (current?.status !== "planned") {
            persistentWait.clear(taskId, "root-execution-agent");
            return;
          }
          if (isTaskWorkflowInterrupted(taskId)) return;
          const fresh = db.prepare("SELECT * FROM agents WHERE id = ?").get(teamLeader.id) as AgentRow | undefined;
          if (
            !fresh ||
            !["idle", "break"].includes(fresh.status) ||
            (fresh.current_task_id && fresh.current_task_id !== taskId)
          ) {
            persistentWait.wait(
              taskId,
              "root-execution-agent",
              `Task execution waiting for agent ${teamLeader.id} (current_task=${fresh?.current_task_id ?? "none"})`,
              startWhenAvailable,
            );
            return;
          }
          persistentWait.clear(taskId, "root-execution-agent");
          db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, fresh.id);
          startTaskExecutionForAgent(taskId, fresh, leaderDeptId, leaderDeptName);
          runCrossDeptAfterMainIfNeeded();
        };
        runPlanningPhase(startWhenAvailable);
      }
    }, ackDelay);
  }

  return handleTaskDelegation;
}
