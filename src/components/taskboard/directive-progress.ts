import type { SubTask, Task } from "../../types";

/**
 * Directive-level view of a root task: one shared integration branch, every
 * department's part (including review revisions), and whether the directive is
 * ready for its single consolidated CEO approval.
 */

export type DirectivePartState =
  | "integrated"
  | "awaiting_approval"
  | "working"
  | "waiting"
  | "queued"
  | "conflict"
  | "blocked";

export type DirectiveReadiness = "integrated" | "ready_for_approval" | "not_ready";

export interface DirectivePart {
  subtask: SubTask;
  state: DirectivePartState;
  isRevision: boolean;
  departmentId: string | null;
  childTask: Task | null;
  waitingOn: SubTask[];
  conflictFiles: string[];
}

export interface DirectiveLane {
  departmentId: string | null;
  state: DirectivePartState;
  parts: DirectivePart[];
  integrated: number;
}

export interface DirectiveSummary {
  rootTaskId: string;
  branch: string;
  parts: DirectivePart[];
  lanes: DirectiveLane[];
  counts: Record<DirectivePartState, number>;
  revisionTotal: number;
  revisionIntegrated: number;
  childTaskCount: number;
  parallelLaneCount: number;
  readiness: DirectiveReadiness;
}

export const DIRECTIVE_PART_STATES: DirectivePartState[] = [
  "integrated",
  "awaiting_approval",
  "working",
  "waiting",
  "queued",
  "conflict",
  "blocked",
];

// Lane state follows the most urgent part so a single conflict is never hidden.
const LANE_PRIORITY: DirectivePartState[] = [
  "conflict",
  "blocked",
  "working",
  "waiting",
  "queued",
  "awaiting_approval",
  "integrated",
];

const REVISION_PREFIXES = ["[Review Revision]", "[검토보완]", "[レビュー補完]", "[评审整改]"];

export function directiveBranchName(rootTaskId: string): string {
  return `climpire/d-${rootTaskId}`;
}

export function resolveDirectiveRootId(task: Task, tasksById: Map<string, Task>): string {
  let current = task;
  const visited = new Set<string>([current.id]);
  while (current.source_task_id) {
    const parent = tasksById.get(current.source_task_id);
    if (!parent) return current.source_task_id;
    if (visited.has(parent.id)) break;
    visited.add(parent.id);
    current = parent;
  }
  return current.id;
}

export function parseSubtaskDependencyIds(value: SubTask["depends_on"]): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((id) => typeof id === "string" && id.trim());
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && !!id.trim()) : [];
  } catch {
    return [];
  }
}

// Server-side integration failures name the directive branch and append the
// conflicting files as the last line of the blocked reason.
export function parseIntegrationConflict(reason: string | null): { isConflict: boolean; files: string[] } {
  if (!reason || !reason.includes("climpire/d-")) return { isConflict: false, files: [] };
  const lines = reason.trim().split("\n");
  const files =
    lines.length > 1
      ? lines[lines.length - 1]
          .split(",")
          .map((file) => file.trim())
          .filter(Boolean)
      : [];
  return { isConflict: true, files };
}

function isRevisionTitle(title: string): boolean {
  const trimmed = title.trim();
  return REVISION_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function classifyPart(
  subtask: SubTask,
  childTask: Task | null,
  rootTask: Task,
  waitingOn: SubTask[],
): { state: DirectivePartState; conflictFiles: string[] } {
  if (subtask.status === "blocked") {
    const conflict = parseIntegrationConflict(subtask.blocked_reason);
    return conflict.isConflict
      ? { state: "conflict", conflictFiles: conflict.files }
      : { state: "blocked", conflictFiles: [] };
  }
  if (subtask.status === "done") {
    // Root-local items land with the root's own approval; delegated items are
    // done only after their branch integrated into the directive branch.
    const integrated = subtask.delegated_task_id
      ? !childTask || childTask.status === "done"
      : rootTask.status === "done";
    return { state: integrated ? "integrated" : "awaiting_approval", conflictFiles: [] };
  }
  if (childTask?.status === "review") return { state: "awaiting_approval", conflictFiles: [] };
  if (subtask.status === "in_progress") return { state: "working", conflictFiles: [] };
  return { state: waitingOn.length > 0 ? "waiting" : "queued", conflictFiles: [] };
}

export function summarizeDirective(
  rootTask: Task,
  subtasks: SubTask[],
  tasksById: Map<string, Task>,
  allTasks: Task[],
): DirectiveSummary {
  const subtasksById = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
  const parts: DirectivePart[] = subtasks.map((subtask) => {
    const childTask = subtask.delegated_task_id ? (tasksById.get(subtask.delegated_task_id) ?? null) : null;
    const waitingOn = parseSubtaskDependencyIds(subtask.depends_on)
      .map((id) => subtasksById.get(id))
      .filter((dep): dep is SubTask => !!dep && dep.status !== "done");
    const { state, conflictFiles } = classifyPart(subtask, childTask, rootTask, waitingOn);
    return {
      subtask,
      state,
      isRevision: isRevisionTitle(subtask.title),
      departmentId: subtask.target_department_id ?? rootTask.department_id ?? null,
      childTask,
      waitingOn,
      conflictFiles,
    };
  });

  const counts = Object.fromEntries(DIRECTIVE_PART_STATES.map((state) => [state, 0])) as Record<
    DirectivePartState,
    number
  >;
  for (const part of parts) counts[part.state] += 1;

  const lanesByDept = new Map<string | null, DirectivePart[]>();
  for (const part of parts) {
    const lane = lanesByDept.get(part.departmentId) ?? [];
    lane.push(part);
    lanesByDept.set(part.departmentId, lane);
  }
  const lanes: DirectiveLane[] = [...lanesByDept.entries()].map(([departmentId, laneParts]) => ({
    departmentId,
    parts: laneParts,
    integrated: laneParts.filter((part) => part.state === "integrated").length,
    state: LANE_PRIORITY.find((state) => laneParts.some((part) => part.state === state)) ?? "queued",
  }));

  const revisions = parts.filter((part) => part.isRevision);
  const open = counts.working + counts.waiting + counts.queued + counts.conflict + counts.blocked;
  const readiness: DirectiveReadiness =
    parts.length > 0 && counts.integrated === parts.length
      ? "integrated"
      : parts.length > 0 && open === 0
        ? "ready_for_approval"
        : "not_ready";

  return {
    rootTaskId: rootTask.id,
    branch: directiveBranchName(rootTask.id),
    parts,
    lanes,
    counts,
    revisionTotal: revisions.length,
    revisionIntegrated: revisions.filter((part) => part.state === "integrated").length,
    childTaskCount: allTasks.filter((task) => task.source_task_id === rootTask.id).length,
    parallelLaneCount: lanes.filter((lane) => lane.state === "working").length,
    readiness,
  };
}

export interface TaskDirectiveContext {
  branch: string;
  isRoot: boolean;
  /** Summary of the whole directive; null when the directive has no tracked parts. */
  summary: DirectiveSummary | null;
  /** This task's own part within the directive, for child and revision tasks. */
  part: DirectivePart | null;
}

export function buildDirectiveContexts(
  tasks: Task[],
  subtasksByTask: Record<string, SubTask[]>,
): Map<string, TaskDirectiveContext> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const summaries = new Map<string, DirectiveSummary | null>();
  const summaryFor = (rootId: string) => {
    if (!summaries.has(rootId)) {
      const root = tasksById.get(rootId);
      const rootSubtasks = subtasksByTask[rootId] ?? [];
      summaries.set(
        rootId,
        root && rootSubtasks.length > 0 ? summarizeDirective(root, rootSubtasks, tasksById, tasks) : null,
      );
    }
    return summaries.get(rootId) ?? null;
  };

  const contexts = new Map<string, TaskDirectiveContext>();
  for (const task of tasks) {
    const rootId = resolveDirectiveRootId(task, tasksById);
    const summary = summaryFor(rootId);
    contexts.set(task.id, {
      branch: directiveBranchName(rootId),
      isRoot: rootId === task.id,
      summary,
      part: summary?.parts.find((part) => part.subtask.delegated_task_id === task.id) ?? null,
    });
  }
  return contexts;
}
