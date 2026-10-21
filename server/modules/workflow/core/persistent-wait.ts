import type { DatabaseSync } from "node:sqlite";

export const DEFAULT_WORKFLOW_WAIT_LIMIT_MS = 15 * 60_000;
const WAIT_PREFIX = "Workflow wait ";

type WaitDeps = {
  db: Pick<DatabaseSync, "prepare">;
  nowMs: () => number;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  notifyCeo: (message: string, taskId?: string | null) => void;
  broadcast?: (event: string, payload: unknown) => void;
};

export type WaitState = {
  state: "waiting" | "resolved" | "exhausted";
  startedAt: number;
  maxWaitMs?: number;
  reason?: string;
};

// The log is the durable clock. Timers only reduce latency while this process is
// alive; the recovery sweep re-enters the workflow after a restart.
export function createPersistentWait(deps: WaitDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function read(taskId: string, key: string): WaitState | null {
    const row = deps.db
      .prepare("SELECT message FROM task_logs WHERE task_id = ? AND message LIKE ? ORDER BY rowid DESC LIMIT 1")
      .get(taskId, `${WAIT_PREFIX}${key}: %`) as { message: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.message.slice(`${WAIT_PREFIX}${key}: `.length)) as WaitState;
    } catch {
      return null;
    }
  }
  function record(taskId: string, key: string, state: WaitState, reason: string) {
    deps.appendTaskLog(taskId, "system", `${WAIT_PREFIX}${key}: ${JSON.stringify({ ...state, reason })}`);
  }
  function clear(taskId: string, key: string) {
    const timerKey = `${taskId}:${key}`;
    const timer = timers.get(timerKey);
    if (timer) clearTimeout(timer);
    timers.delete(timerKey);
    const previous = read(taskId, key);
    if (previous?.state === "waiting") record(taskId, key, { ...previous, state: "resolved" }, "Dependency ready");
  }
  function wait(
    taskId: string,
    key: string,
    reason: string,
    retry: () => void,
    options: { delayMs?: number; maxWaitMs?: number } = {},
  ): boolean {
    const previous = read(taskId, key);
    if (previous?.state === "exhausted") return false;
    const maxWaitMs =
      previous?.state === "waiting"
        ? (previous.maxWaitMs ?? options.maxWaitMs ?? DEFAULT_WORKFLOW_WAIT_LIMIT_MS)
        : (options.maxWaitMs ?? DEFAULT_WORKFLOW_WAIT_LIMIT_MS);
    const startedAt = previous?.state === "waiting" ? previous.startedAt : deps.nowMs();
    if (previous?.state !== "waiting") record(taskId, key, { state: "waiting", startedAt, maxWaitMs }, reason);
    const elapsed = deps.nowMs() - startedAt;
    if (elapsed >= maxWaitMs) {
      clear(taskId, key);
      record(taskId, key, { state: "exhausted", startedAt }, reason);
      deps.appendTaskLog(taskId, "system", `Workflow needs attention: ${reason} (wait limit ${maxWaitMs}ms reached)`);
      const changed = deps.db
        .prepare(
          "UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status IN ('planned', 'collaborating')",
        )
        .run(deps.nowMs(), taskId);
      if (changed.changes > 0)
        deps.broadcast?.("task_update", deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      deps.notifyCeo(
        `Workflow needs attention: ${reason}. Retry from the task card after resolving the dependency.`,
        taskId,
      );
      return false;
    }
    const timerKey = `${taskId}:${key}`;
    if (!timers.has(timerKey)) {
      const timer = setTimeout(
        () => {
          timers.delete(timerKey);
          retry();
        },
        Math.min(options.delayMs ?? 5_000, maxWaitMs - elapsed),
      );
      timer.unref?.();
      timers.set(timerKey, timer);
    }
    return true;
  }
  return { wait, clear };
}

export function hasExhaustedWait(db: Pick<DatabaseSync, "prepare">, taskId: string): boolean {
  const rows = db
    .prepare("SELECT message FROM task_logs WHERE task_id = ? AND message LIKE ? ORDER BY rowid DESC")
    .all(taskId, `${WAIT_PREFIX}%`) as Array<{ message: string }>;
  const seen = new Set<string>();
  for (const row of rows) {
    const boundary = row.message.indexOf(": {", WAIT_PREFIX.length);
    if (boundary < 0) continue;
    const key = row.message.slice(WAIT_PREFIX.length, boundary);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if ((JSON.parse(row.message.slice(boundary + 2)) as WaitState).state === "exhausted") return true;
    } catch {
      // Ignore legacy or malformed log lines.
    }
  }
  return false;
}

// Manual Resume starts a new bounded waiting window. Keeping the old records
// makes both the exhausted wait and the CEO's intervention auditable.
export function resetPersistentWaits(db: Pick<DatabaseSync, "prepare">, taskId: string, now = Date.now()): void {
  const rows = db
    .prepare("SELECT message FROM task_logs WHERE task_id = ? AND message LIKE ? ORDER BY rowid DESC")
    .all(taskId, `${WAIT_PREFIX}%`) as Array<{ message: string }>;
  const seen = new Set<string>();
  for (const row of rows) {
    const boundary = row.message.indexOf(": {", WAIT_PREFIX.length);
    if (boundary < 0) continue;
    const key = row.message.slice(WAIT_PREFIX.length, boundary);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if ((JSON.parse(row.message.slice(boundary + 2)) as WaitState).state === "resolved") continue;
    } catch {
      continue;
    }
    db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'system', ?, ?)").run(
      taskId,
      `${WAIT_PREFIX}${key}: ${JSON.stringify({ state: "resolved", startedAt: now, reason: "Manual resume" })}`,
      now,
    );
  }
}

// Expire durable waits even when their original callback was lost at restart.
// Live dispatch and the root sweep reconstruct work; this sweep owns deadlines.
export function sweepExpiredWorkflowWaits(deps: WaitDeps): void {
  const rows = deps.db
    .prepare(
      `SELECT l.task_id, l.message, t.status FROM task_logs l
    JOIN tasks t ON t.id = l.task_id WHERE l.message LIKE 'Workflow wait %'
    AND t.status IN ('pending','planned','collaborating','in_progress','review') ORDER BY l.rowid DESC`,
    )
    .all() as Array<{ task_id: string; message: string; status: string }>;
  const seen = new Set<string>();
  const waiting = createPersistentWait(deps);
  for (const row of rows) {
    const boundary = row.message.indexOf(": {", WAIT_PREFIX.length);
    if (boundary < 0) continue;
    const key = row.message.slice(WAIT_PREFIX.length, boundary);
    const identity = `${row.task_id}:${key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    let state: WaitState;
    try {
      state = JSON.parse(row.message.slice(boundary + 2));
    } catch {
      continue;
    }
    if (state.state !== "waiting") continue;
    const rootWait = [
      "planning-agent",
      "root-execution-agent",
      "root-owner",
      "root-consolidation",
      "planning-integration",
    ].includes(key);
    if (rootWait && ["in_progress", "review"].includes(row.status)) {
      waiting.clear(row.task_id, key);
      continue;
    }
    const limit = state.maxWaitMs ?? DEFAULT_WORKFLOW_WAIT_LIMIT_MS;
    if (deps.nowMs() - state.startedAt >= limit) {
      waiting.wait(row.task_id, key, state.reason ?? `Waiting for ${key}`, () => {}, { maxWaitMs: limit });
    }
  }
}
