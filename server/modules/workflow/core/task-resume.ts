import { parseStoredMeetingVerdict } from "../../../../src/lib/meeting-verdict.ts";
import { createPersistentWait, hasExhaustedWait } from "./persistent-wait.ts";
import { isPlanningAgent } from "../../routes/collab/planner-selection.ts";
import { resolveConstrainedAgentScopeForTask } from "../../routes/core/tasks/execution-run-auto-assign.ts";
import { parsePlanningGraph } from "../agents/planning-graph.ts";

const ownerWaits = new WeakMap<object, ReturnType<typeof createPersistentWait>>();
function ownerWait(deps: any) {
  let waiting = ownerWaits.get(deps.db);
  if (!waiting) {
    waiting = createPersistentWait(deps);
    ownerWaits.set(deps.db, waiting);
  }
  return waiting;
}

export function isTaskAutoRecoveryHeld(deps: any, taskId: string): boolean {
  if (deps.stopRequestedTasks?.has(taskId) || hasExhaustedWait(deps.db, taskId)) return true;
  const task = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (task?.planning_attention_reason) return true;
  const control = deps.db
    .prepare(
      `SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system'
    AND (message LIKE 'PAUSE_BREAK%' OR message LIKE 'RESUME:%' OR message LIKE '%action=apply_review_pick%')
    ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(taskId);
  return String(control?.message ?? "").startsWith("PAUSE_BREAK");
}

// Both the HTTP control and recovery sweep use this driver. It deliberately
// re-reads the owner at dispatch time rather than trusting a captured CLI slot.
export function resumeTaskExecution(
  deps: any,
  taskId: string,
  reason: string,
  options?: { planning?: boolean },
): boolean {
  const { db, activeProcesses, startTaskExecutionForAgent, appendTaskLog, getDeptName } = deps;
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task || activeProcesses.has(taskId) || !["pending", "planned", "collaborating"].includes(task.status))
    return false;
  if (deps.stopRequestedTasks?.has(taskId) || hasExhaustedWait(db, taskId)) return false;
  // Retrying a held graph restores dependency dispatch; consolidation must
  // still wait for every child to be approved and integrated.
  if (!options?.planning && deps.processSubtaskDelegations) {
    const graph = db
      .prepare("SELECT 1 FROM task_logs WHERE task_id = ? AND message LIKE 'Planned graph seeded %' LIMIT 1")
      .get(taskId);
    const unfinished =
      graph &&
      db
        .prepare(
          `SELECT 1 FROM subtasks s LEFT JOIN tasks child ON child.id = s.delegated_task_id
      WHERE s.task_id = ? AND (s.status NOT IN ('done','cancelled') OR
      (s.status = 'done' AND (child.status IS NULL OR child.status != 'done'))) LIMIT 1`,
        )
        .get(taskId);
    if (unfinished) {
      if (task.status !== "collaborating") {
        db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(
          "collaborating",
          deps.nowMs(),
          taskId,
        );
        appendTaskLog(taskId, "system", `Automatic re-queue: ${reason}: restoring planning graph dependency dispatch`);
        deps.broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      }
      db.prepare(
        "UPDATE agents SET current_task_id = NULL WHERE id = ? AND current_task_id = ? AND status IN ('idle','break')",
      ).run(task.assigned_agent_id, taskId);
      deps.processSubtaskDelegations(taskId);
      ownerWait(deps).wait(
        taskId,
        "planning-integration",
        "Planning graph waiting for child approval and integration",
        () => resumeTaskExecution(deps, taskId, reason),
        { maxWaitMs: 60 * 60_000 },
      );
      return true;
    }
    ownerWait(deps).clear(taskId, "planning-integration");
  }
  const agent = task.assigned_agent_id
    ? db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id)
    : null;
  if (
    !agent ||
    !["idle", "break"].includes(agent.status) ||
    (agent.current_task_id && agent.current_task_id !== taskId)
  ) {
    ownerWait(deps).wait(
      taskId,
      "root-owner",
      `Root waiting for assigned agent ${task.assigned_agent_id ?? "unassigned"} (${agent?.status ?? "missing"}; current_task=${agent?.current_task_id ?? "none"})`,
      () => resumeTaskExecution(deps, taskId, reason, options),
    );
    return false;
  }
  ownerWait(deps).clear(taskId, "root-owner");
  const deptId = agent.department_id ?? task.department_id ?? null;
  const launch = () => {
    const fresh = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    const owner = db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id);
    if (!fresh || fresh.status !== "planned" || activeProcesses.has(taskId) || deps.stopRequestedTasks?.has(taskId))
      return;
    if (
      !owner ||
      !["idle", "break"].includes(owner.status) ||
      (owner.current_task_id && owner.current_task_id !== taskId)
    )
      return;
    startTaskExecutionForAgent(
      taskId,
      owner,
      deptId,
      deptId ? getDeptName(deptId, task.workflow_pack_key) : "Unassigned",
    );
  };
  db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run("planned", deps.nowMs(), taskId);
  appendTaskLog(taskId, "system", `Automatic re-queue: ${reason}`);
  deps.broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
  if (options?.planning && deps.startPlannedApprovalMeeting) {
    db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agent.id);
    deps.startPlannedApprovalMeeting(taskId, task.title, deptId, (notes: string[] = []) => {
      const fresh = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
      if (fresh?.status !== "planned" || deps.stopRequestedTasks?.has(taskId)) return;
      deps.seedApprovedPlanSubtasks(taskId, deptId, notes);
      if (notes.some((note: string) => parsePlanningGraph(note) !== null)) {
        db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(
          "collaborating",
          deps.nowMs(),
          taskId,
        );
        db.prepare("UPDATE agents SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(
          agent.id,
          taskId,
        );
        deps.broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
        deps.processSubtaskDelegations(taskId);
      } else {
        deps.processSubtaskDelegations(taskId);
        // Legacy prose plans can name a department without seeding its work.
        // Reconstruct that cooperation too, preserving the project's agent scope.
        const mentioned = deps.detectTargetDepartments?.(task.description ?? task.title) ?? [];
        if (isPlanningAgent(agent) && deps.startCrossDeptCooperation) {
          const scope = resolveConstrainedAgentScopeForTask(db, task);
          for (const departmentId of new Set<string>(mentioned)) {
            if (departmentId === deptId) continue;
            const existing = db
              .prepare("SELECT 1 FROM subtasks WHERE task_id = ? AND target_department_id = ? LIMIT 1")
              .get(taskId, departmentId);
            if (existing) continue;
            deps.startCrossDeptCooperation([departmentId], 0, {
              teamLeader: agent,
              taskTitle: task.title,
              ceoMessage: task.description ?? task.title,
              leaderDeptId: deptId,
              leaderDeptName: deptId ? getDeptName(deptId) : "Unassigned",
              leaderName: agent.name,
              lang: deps.resolveLang(task.description ?? task.title),
              taskId,
              projectId: task.project_id,
              projectCandidateAgentIds: scope,
            });
          }
        }
        launch();
      }
    });
  } else launch();
  return true;
}

export function recoverReadyRoot(deps: any, taskId: string, trigger: string): boolean {
  const { db } = deps;
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (
    !task ||
    task.source_task_id ||
    task.planning_attention_reason ||
    deps.activeProcesses.has(taskId) ||
    deps.stopRequestedTasks?.has(taskId)
  )
    return false;
  if (deps.reviewInFlight?.has(taskId) || deps.reviewInFlight?.has(`planned:${taskId}`)) return false;
  // Explicit pauses and exhausted waits survive restarts until manual Resume.
  if (isTaskAutoRecoveryHeld(deps, taskId)) return false;
  const open = db
    .prepare(
      `SELECT 1 FROM subtasks s LEFT JOIN tasks child ON child.id = s.delegated_task_id
    WHERE s.task_id = ? AND (s.status NOT IN ('done','cancelled') OR
      (s.status = 'done' AND s.delegated_task_id IS NOT NULL AND s.delegated_task_id != '' AND (child.status IS NULL OR child.status != 'done'))) LIMIT 1`,
    )
    .get(taskId);
  if (open) return false;
  const activeChild = db
    .prepare("SELECT 1 FROM tasks WHERE source_task_id = ? AND status NOT IN ('done','cancelled') LIMIT 1")
    .get(taskId);
  if (activeChild) return false;
  if (task.status === "pending") {
    const revision = db
      .prepare(
        `SELECT 1 FROM subtasks WHERE task_id = ? AND
      (title LIKE '%[Review Revision]%' OR title LIKE '%[검토보완]%' OR title LIKE '%[レビュー補完]%' OR title LIKE '%[评审整改]%' OR description LIKE '%review-meeting revision%') LIMIT 1`,
      )
      .get(taskId);
    if (!revision) return false;
    return resumeTaskExecution(deps, taskId, `${trigger}: all revision subtasks completed or cancelled`);
  }
  if (task.status === "collaborating") {
    const children = db.prepare("SELECT 1 FROM subtasks WHERE task_id = ? LIMIT 1").get(taskId);
    if (!children) return false;
    return resumeTaskExecution(deps, taskId, `${trigger}: collaboration children integrated; root consolidation ready`);
  }
  if (task.status === "planned") {
    const completedMeeting = db
      .prepare(
        "SELECT 1 FROM meeting_minutes WHERE task_id = ? AND meeting_type = 'planned' AND status = 'completed' LIMIT 1",
      )
      .get(taskId);
    return resumeTaskExecution(deps, taskId, `${trigger}: planned root has no active driver`, {
      planning: !completedMeeting && !task.started_at,
    });
  }
  if (task.status === "review") {
    const latest = db
      .prepare(
        "SELECT id, status FROM meeting_minutes WHERE task_id = ? AND meeting_type = 'review' ORDER BY started_at DESC, created_at DESC LIMIT 1",
      )
      .get(taskId);
    if (latest?.status === "revision_requested") return false;
    if (latest?.status === "failed") {
      const entries = db
        .prepare("SELECT content FROM meeting_minute_entries WHERE meeting_id = ?")
        .all(latest.id) as Array<{ content: string }>;
      if (entries.some((entry) => parseStoredMeetingVerdict(entry.content)?.verdict === "no_verdict")) return false;
    }
    appendRecoveryReview(deps, task, trigger);
    return true;
  }
  return false;
}

function appendRecoveryReview(deps: any, task: any, trigger: string): void {
  // finishReview owns project decision gates, review automation and merge policy.
  deps.appendTaskLog(task.id, "system", `Automatic re-queue: ${trigger}: review root has no active driver`);
  deps.finishReview(task.id, task.title, { trigger: "recovery_sweep" });
}

export function sweepReadyRoots(deps: any): void {
  const roots = deps.db
    .prepare(
      `SELECT id FROM tasks WHERE source_task_id IS NULL
    AND status IN ('pending','planned','collaborating','review') AND updated_at <= ? ORDER BY updated_at`,
    )
    .all(deps.nowMs() - 30_000);
  for (const { id } of roots) {
    try {
      recoverReadyRoot(deps, id, "persistent recovery sweep");
    } catch (error) {
      deps.appendTaskLog(id, "error", `Automatic re-queue failed: ${String(error)}`);
    }
  }
}
