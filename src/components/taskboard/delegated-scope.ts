import type { Task } from "../../types";

// Section markers written by server/modules/routes/collab/subtask-delegation-batch-messages.ts (ko/en/ja/zh).
const CHECKLIST_MARKERS = ["[순차 체크리스트]", "[Sequential checklist]", "[順次チェックリスト]", "[顺序清单]"];
const PARENT_CONTEXT_MARKERS = [
  "[상위 업무 배경 — 참고 전용]",
  "[Parent context — reference only]",
  "[親タスクの背景 — 参照専用]",
  "[父任务背景 — 仅供参考]",
];
const SOURCE_PATTERN =
  /^\[(?:서브태스크 위임 from|Subtasks delegated from|サブタスク委任元|SubTask 委派来源)\s+([^\]]+)\]\s*/;
const SCOPE_PATTERN = /^\[(?:담당 범위|Department scope|担当範囲|负责范围)\s*[:：]\s*([^\]]+)\]\s*$/m;
const CHECKLIST_ITEM_PATTERN = /^(\d+)\.\s+(.*?)(?:\s+\[([^\]\s]+)\])?(?:\s+-\s+([\s\S]*))?$/;

export const RELATED_WORK_MAX_TASKS = 6;
export const RELATED_REPORT_MAX_CHARS = 160;

export interface DelegatedChecklistItem {
  index: number;
  title: string;
  subtaskId: string | null;
  detail: string | null;
}

export interface DelegatedScope {
  sourceDept: string | null;
  scopeDept: string | null;
  instruction: string | null;
  items: DelegatedChecklistItem[];
  parentContext: string;
}

function findMarker(text: string, markers: string[]): { index: number; marker: string } | null {
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0) return { index, marker };
  }
  return null;
}

function parseChecklist(block: string): DelegatedChecklistItem[] {
  const items: DelegatedChecklistItem[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = CHECKLIST_ITEM_PATTERN.exec(trimmed);
    if (match) {
      items.push({
        index: Number(match[1]),
        title: match[2].trim(),
        subtaskId: match[3] ?? null,
        detail: match[4]?.trim() || null,
      });
    } else if (items.length > 0) {
      const last = items[items.length - 1];
      last.detail = last.detail ? `${last.detail}\n${trimmed}` : trimmed;
    }
  }
  return items;
}

/**
 * Splits a delegated task description into the department's own checklist and the parent context.
 * Returns null for ordinary task descriptions so they keep their existing plain rendering.
 */
export function parseDelegatedScope(description: string | null | undefined): DelegatedScope | null {
  if (!description) return null;
  const checklist = findMarker(description, CHECKLIST_MARKERS);
  if (!checklist) return null;

  let head = description.slice(0, checklist.index).trim();
  const afterChecklist = description.slice(checklist.index + checklist.marker.length);
  const parent = findMarker(afterChecklist, PARENT_CONTEXT_MARKERS);
  const checklistBlock = parent ? afterChecklist.slice(0, parent.index) : afterChecklist;
  const items = parseChecklist(checklistBlock);
  if (items.length === 0) return null;

  const sourceMatch = SOURCE_PATTERN.exec(head);
  const sourceDept = sourceMatch ? sourceMatch[1].trim() : null;
  if (sourceMatch) head = head.slice(sourceMatch[0].length).trim();
  const scopeMatch = SCOPE_PATTERN.exec(head);
  const scopeDept = scopeMatch ? scopeMatch[1].trim() : null;
  if (scopeMatch) head = head.replace(scopeMatch[0], "").trim();

  if (parent) {
    return {
      sourceDept,
      scopeDept,
      instruction: head || null,
      items,
      parentContext: afterChecklist.slice(parent.index + parent.marker.length).trim(),
    };
  }
  // Legacy format: the parent summary sat on the header line before the checklist.
  return { sourceDept, scopeDept, instruction: null, items, parentContext: head };
}

function taskFamilyRoot(task: Task, byId: Map<string, Task>): string {
  let current = task;
  const seen = new Set<string>([current.id]);
  while (current.source_task_id && !seen.has(current.source_task_id)) {
    const parent = byId.get(current.source_task_id);
    if (!parent) return current.source_task_id;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

function isInFlight(task: Task): boolean {
  return task.status === "in_progress" || task.status === "collaborating";
}

/**
 * Maps each task to the other tasks in its source-task family (parent, siblings, children),
 * in-flight work first, then most recently updated. Tasks without a family are omitted.
 */
export function buildRelatedTaskIndex(tasks: Task[]): Map<string, Task[]> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const families = new Map<string, Task[]>();
  for (const task of tasks) {
    const root = taskFamilyRoot(task, byId);
    const family = families.get(root);
    if (family) family.push(task);
    else families.set(root, [task]);
  }

  const related = new Map<string, Task[]>();
  for (const family of families.values()) {
    if (family.length < 2) continue;
    const ordered = [...family].sort(
      (a, b) => Number(isInFlight(b)) - Number(isInFlight(a)) || b.updated_at - a.updated_at,
    );
    for (const task of family) {
      related.set(
        task.id,
        ordered.filter((item) => item.id !== task.id),
      );
    }
  }
  return related;
}

export function clipReport(text: string | null | undefined, maxChars = RELATED_REPORT_MAX_CHARS): string | null {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  return value.length > maxChars ? `${value.slice(0, maxChars - 1).trimEnd()}…` : value;
}
