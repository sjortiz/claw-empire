import type { AgentRow } from "../../routes/shared/types.ts";
import { parsePlanningGraph } from "../agents/planning-graph.ts";

type RecoveryDeps = {
  db: any;
  activeProcesses: Map<string, unknown>;
  nowMs: () => number;
  appendTaskLog: (id: string, kind: string, message: string) => void;
  broadcast: (event: string, payload: unknown) => void;
  getDeptName: (...args: any[]) => string;
  startTaskExecutionForAgent: (...args: any[]) => void;
  reviewInFlight?: Set<string>;
  finishReview?: (...args: any[]) => void;
  startPlannedApprovalMeeting?: (...args: any[]) => void;
  seedApprovedPlanSubtasks?: (...args: any[]) => void;
  processSubtaskDelegations?: (...args: any[]) => void;
};

// Shared by the authenticated resume route and workflow recovery. The caller
// chooses when to start; availability is always read again immediately before it.
export function resumeTaskExecution(deps: RecoveryDeps, taskId: string, reason: string): boolean {
  const { db, activeProcesses } = deps;
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task || !["pending", "planned", "collaborating"].includes(task.status) || activeProcesses.has(taskId))
    return false;
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as AgentRow | undefined;
  if (
    !agent ||
    !["idle", "break"].includes(agent.status) ||
    (agent.current_task_id && agent.current_task_id !== taskId)
  )
    return false;
  db.prepare("UPDATE tasks SET status = 'planned', updated_at = ? WHERE id = ?").run(deps.nowMs(), taskId);
  deps.appendTaskLog(taskId, "system", `Automatic re-queue: ${reason}`);
  deps.broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
  const deptId = agent.department_id ?? task.department_id ?? null;
  deps.startTaskExecutionForAgent(
    taskId,
    agent,
    deptId,
    deptId ? deps.getDeptName(deptId, task.workflow_pack_key) : "Unassigned",
  );
  return true;
}

function latestControlLog(db: any, taskId: string): string {
  return (
    db
      .prepare(
        `SELECT message FROM task_logs WHERE task_id = ? AND
    (message LIKE '%supplement round opened (review -> pending)%'
      OR message LIKE 'PAUSE%' OR message LIKE 'STOP%' OR message LIKE 'RESUME:%'
      OR message LIKE 'Workflow attention%')
    ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId)?.message ?? ""
  );
}

export function recoverReadyRoot(deps: RecoveryDeps, taskId: string, source: string): boolean {
  const { db } = deps;
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task || task.source_task_id || deps.activeProcesses.has(taskId)) return false;
  if (deps.reviewInFlight?.has(taskId) || deps.reviewInFlight?.has(`planned:${taskId}`)) return false;
  const control = latestControlLog(db, taskId);
  if (/^(PAUSE|STOP|Workflow attention required)/.test(control)) return false;
  const items = db
    .prepare(
      `SELECT s.*, child.status AS child_status FROM subtasks s
    LEFT JOIN tasks child ON child.id = s.delegated_task_id WHERE s.task_id = ?`,
    )
    .all(taskId) as any[];
  // A delegated completion is not ready until its approval has integrated it.
  const unfinished = items.filter(
    (s) => s.status !== "cancelled" && (s.status !== "done" || (s.delegated_task_id && s.child_status !== "done")),
  );
  if (task.status === "pending") {
    if (!control.includes("supplement round opened (review -> pending)")) return false;
    // The root itself owns nondelegated revision consolidation/local work.
    if (unfinished.some((s) => s.target_department_id || s.delegated_task_id)) return false;
    return resumeTaskExecution(deps, taskId, `${source}: revision department work completed; resume consolidation`);
  }
  if (task.status === "collaborating") {
    if (unfinished.length || !items.length) return false;
    return resumeTaskExecution(deps, taskId, `${source}: all collaboration work approved and integrated`);
  }
  if (task.status === "review") {
    if (unfinished.length || !deps.finishReview) return false;
    const meeting = db
      .prepare(
        `SELECT status FROM meeting_minutes WHERE task_id = ? AND meeting_type = 'review'
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId);
    if (meeting && ["in_progress", "revision_requested", "failed"].includes(meeting.status)) return false;
    // finishReview retains the project gate, review autostart and CEO decisions.
    deps.appendTaskLog(taskId, "system", `Automatic re-queue: ${source}: review prerequisites complete`);
    deps.finishReview(taskId, task.title);
    return true;
  }
  if (task.status !== "planned" || !String(task.description ?? "").includes("[CEO]")) return false;
  if (unfinished.some((s) => s.target_department_id || s.delegated_task_id)) return false;
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id);
  if (
    !agent ||
    !["idle", "break"].includes(agent.status) ||
    (agent.current_task_id && agent.current_task_id !== taskId)
  )
    return false;
  const meeting = db
    .prepare(
      `SELECT status FROM meeting_minutes WHERE task_id = ? AND meeting_type = 'planned'
    ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId);
  const skipped = db
    .prepare(
      `SELECT 1 FROM task_logs WHERE task_id = ? AND message = 'Planned meeting skipped by CEO directive' LIMIT 1`,
    )
    .get(taskId);
  if (meeting?.status === "failed") return false; // explicit retry / attention path
  if (meeting?.status === "completed" || skipped || items.length) {
    return resumeTaskExecution(deps, taskId, `${source}: planned execution lost its driver`);
  }
  if (!deps.startPlannedApprovalMeeting) return false;
  // An in-progress minute with no in-memory lock is a meeting lost on restart.
  if (meeting?.status === "in_progress")
    db.prepare(
      `UPDATE meeting_minutes SET status = 'failed', completed_at = ?
    WHERE task_id = ? AND meeting_type = 'planned' AND status = 'in_progress'`,
    ).run(deps.nowMs(), taskId);
  deps.appendTaskLog(taskId, "system", `Automatic re-queue: ${source}: restore planning meeting`);
  deps.startPlannedApprovalMeeting(taskId, task.title, task.department_id, (notes: string[] = []) => {
    const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
    if (current?.status !== "planned" || deps.activeProcesses.has(taskId)) return;
    deps.seedApprovedPlanSubtasks?.(taskId, task.department_id, notes);
    if (notes.some((note) => parsePlanningGraph(note) !== null)) {
      db.prepare("UPDATE tasks SET status = 'collaborating', updated_at = ? WHERE id = ?").run(deps.nowMs(), taskId);
      db.prepare("UPDATE agents SET current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(
        task.assigned_agent_id,
        taskId,
      );
      deps.broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      deps.processSubtaskDelegations?.(taskId);
    } else resumeTaskExecution(deps, taskId, `${source}: recovered planning meeting completed`);
  });
  return true;
}

export function sweepReadyRoots(deps: RecoveryDeps, source: string): void {
  const roots = deps.db
    .prepare(
      `SELECT id FROM tasks WHERE source_task_id IS NULL
    AND status IN ('pending', 'planned', 'collaborating', 'review') ORDER BY updated_at, id`,
    )
    .all() as { id: string }[];
  for (const root of roots) {
    try {
      recoverReadyRoot(deps, root.id, source);
    } catch (error) {
      deps.appendTaskLog(root.id, "error", `Recovery sweep failed: ${String(error)}`);
    }
  }
}
