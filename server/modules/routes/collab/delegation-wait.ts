import type { DatabaseSync } from "node:sqlite";

export const DELEGATION_WAIT_LIMIT_MS = 10 * 60_000;

interface WaitDeps {
  db: Pick<DatabaseSync, "prepare">;
  nowMs: () => number;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  notifyCeo: (message: string, taskId: string) => void;
  broadcast: (event: string, payload: unknown) => void;
}

// Store the clock in task_logs, rather than a closure, so a restart cannot
// silently grant another full waiting period to a stuck directive.
export function createDelegationWait(deps: WaitDeps) {
  const prefix = (key: string) => `Delegation wait ${JSON.stringify(key)}: `;
  function latest(taskId: string, key: string): { state: string; startedAt: number } | null {
    const row = deps.db
      .prepare("SELECT message FROM task_logs WHERE task_id = ? AND substr(message, 1, ?) = ? ORDER BY id DESC LIMIT 1")
      .get(taskId, prefix(key).length, prefix(key)) as { message: string } | undefined;
    return row ? JSON.parse(row.message.slice(prefix(key).length)) : null;
  }
  function record(taskId: string, key: string, state: string, startedAt: number, waitingFor: string) {
    deps.appendTaskLog(taskId, "system", prefix(key) + JSON.stringify({ state, startedAt, waitingFor }));
  }
  return {
    wait(taskId: string, key: string, waitingFor: string, subtaskIds: string[] = []): boolean {
      const previous = latest(taskId, key);
      if (previous?.state === "escalated") return false;
      const startedAt = previous?.state === "waiting" ? previous.startedAt : deps.nowMs();
      if (previous?.state !== "waiting") record(taskId, key, "waiting", startedAt, waitingFor);
      const expired = deps.nowMs() - startedAt >= DELEGATION_WAIT_LIMIT_MS;
      const reason = expired ? `Needs CEO attention: waiting for ${waitingFor}` : `Waiting for ${waitingFor}`;
      for (const id of subtaskIds) {
        deps.db.prepare("UPDATE subtasks SET status = 'blocked', blocked_reason = ? WHERE id = ?").run(reason, id);
        deps.broadcast("subtask_update", deps.db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id));
      }
      if (!expired) return true;
      record(taskId, key, "escalated", startedAt, waitingFor);
      deps.appendTaskLog(taskId, "system", `Workflow attention required: delegation wait exhausted for ${waitingFor}`);
      // Pending exposes the task-card Resume action without interrupting a running
      // parent CLI while one of its departments is still waiting.
      const moved = deps.db
        .prepare(
          "UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status IN ('planned', 'pending', 'collaborating')",
        )
        .run(deps.nowMs(), taskId);
      if (moved.changes) {
        const reserved = deps.db
          .prepare("SELECT id FROM agents WHERE current_task_id = ? AND status IN ('idle', 'break')")
          .all(taskId) as Array<{ id: string }>;
        for (const agent of reserved) {
          deps.db
            .prepare("UPDATE agents SET current_task_id = NULL WHERE id = ? AND current_task_id = ?")
            .run(agent.id, taskId);
          deps.broadcast("agent_status", deps.db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id));
        }
      }
      deps.broadcast("task_update", deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      deps.notifyCeo(
        `Needs attention: directive waited 10 minutes for ${waitingFor}. Automatic waiting stopped; review its assignment and resume it.`,
        taskId,
      );
      return false;
    },
    resolve(taskId: string, key: string) {
      const previous = latest(taskId, key);
      if (previous && previous.state !== "resolved") record(taskId, key, "resolved", previous.startedAt, "available");
    },
  };
}

// Only explicit task-card Resume resets an exhausted resource wait.
export function resetDelegationWaits(deps: Pick<WaitDeps, "db" | "appendTaskLog" | "broadcast">, taskId: string): void {
  const rows = deps.db
    .prepare("SELECT message FROM task_logs WHERE task_id = ? AND message LIKE 'Delegation wait %' ORDER BY id DESC")
    .all(taskId) as { message: string }[];
  const seen = new Set<string>();
  for (const { message } of rows) {
    const split = message.indexOf(": ");
    if (split < 0) continue;
    const prefix = message.slice(0, split + 2);
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    const state = JSON.parse(message.slice(split + 2));
    if (state.state === "resolved") continue;
    deps.appendTaskLog(
      taskId,
      "system",
      prefix + JSON.stringify({ ...state, state: "resolved", waitingFor: "CEO requested retry" }),
    );
  }
  if (!seen.size) return;
  const blocked = deps.db
    .prepare("SELECT id FROM subtasks WHERE task_id = ? AND blocked_reason LIKE 'Needs CEO attention:%'")
    .all(taskId) as { id: string }[];
  for (const { id } of blocked) {
    deps.db.prepare("UPDATE subtasks SET status = 'pending', blocked_reason = NULL WHERE id = ?").run(id);
    deps.broadcast("subtask_update", deps.db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id));
  }
}

// A queued callback may outlive its parent entering attention or a manual pause.
export function isDelegationSuspended(db: Pick<DatabaseSync, "prepare">, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT message FROM task_logs WHERE task_id = ? AND
    (message LIKE 'Workflow attention%' OR message LIKE 'RESUME:%' OR message LIKE 'PAUSE%'
      OR message LIKE 'STOP%' OR message LIKE '%supplement round opened (review -> pending)%')
    ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { message: string } | undefined;
  return /^(Workflow attention required|PAUSE|STOP)/.test(row?.message ?? "");
}
