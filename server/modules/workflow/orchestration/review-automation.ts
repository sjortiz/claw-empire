import type { DatabaseSync } from "node:sqlite";
import { resolveReviewPolicy } from "../core/review-policy.ts";

type RetryState = { token: string; attempts: number; retryAt: number };
const heldReviewRetries = new WeakMap<object, Map<string, RetryState>>();

type FinishReview = (
  id: string,
  title: string,
  options: { bypassProjectDecisionGate: boolean; trigger: string },
) => void;

/** Re-evaluated on gate arrival and in the background, including after settings changes. */
export function startReadyProjectReviewMeetings(
  db: Pick<DatabaseSync, "prepare">,
  finishReview: FinishReview,
  projectId?: string,
  options?: { forceRetry?: boolean; nowMs?: () => number },
): number {
  const now = options?.nowMs?.() ?? Date.now();
  let retries = heldReviewRetries.get(db);
  if (!retries) {
    retries = new Map();
    heldReviewRetries.set(db, retries);
  }
  const projects = db
    .prepare(
      `
    SELECT project_id FROM tasks
    WHERE project_id IS NOT NULL ${projectId ? "AND project_id = ?" : ""}
    GROUP BY project_id
    HAVING SUM(CASE WHEN status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) > 0
      AND SUM(CASE WHEN status NOT IN ('done', 'cancelled', 'review') THEN 1 ELSE 0 END) = 0
  `,
    )
    .all(...(projectId ? [projectId] : [])) as Array<{ project_id: string }>;
  let count = 0;
  for (const project of projects) {
    if (!resolveReviewPolicy(db, project.project_id, "reviewMeetingAutoStart")) continue;
    // Revision selection remains a separate decision. Never advance a pending round.
    const pending = db
      .prepare(
        `
      SELECT 1 FROM tasks t JOIN meeting_minutes mm ON mm.task_id = t.id
      WHERE t.project_id = ? AND t.status = 'review' AND t.source_task_id IS NULL
        AND mm.meeting_type = 'review' AND mm.status = 'revision_requested'
        AND mm.id = (SELECT id FROM meeting_minutes WHERE task_id = t.id AND meeting_type = 'review'
          ORDER BY started_at DESC, created_at DESC LIMIT 1)
      LIMIT 1
    `,
      )
      .get(project.project_id);
    if (pending) continue;
    const roots = db
      .prepare(
        `
      SELECT t.id, t.title, t.updated_at FROM tasks t
      WHERE t.project_id = ? AND t.status = 'review' AND t.source_task_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM meeting_minutes mm WHERE mm.task_id = t.id
          AND mm.meeting_type = 'review' AND mm.status = 'in_progress')
      ORDER BY t.updated_at ASC, t.created_at ASC
    `,
      )
      .all(project.project_id) as Array<{ id: string; title: string; updated_at: number }>;
    for (const root of roots) {
      // A held task must not notify the CEO on every 2.5-second timer tick.
      // Task/subtask changes retry immediately; unchanged artifact holds back off.
      const progress = db
        .prepare(
          `
        SELECT GROUP_CONCAT(progress, '|') AS token FROM (
          SELECT s.id || ':' || s.status || ':' || COALESCE(s.completed_at, '') || ':' ||
            COALESCE(dt.status, '') || ':' || COALESCE(dt.updated_at, '') AS progress
          FROM subtasks s LEFT JOIN tasks dt ON dt.id = s.delegated_task_id
          WHERE s.task_id = ? ORDER BY s.id
        )
      `,
        )
        .get(root.id) as { token: string | null };
      const token = `${root.updated_at}:${progress.token ?? ""}`;
      const previous = retries.get(root.id);
      if (!options?.forceRetry && previous?.token === token && previous.retryAt > now) continue;
      const attempts = previous?.token === token ? previous.attempts + 1 : 1;
      retries.set(root.id, {
        token,
        attempts,
        retryAt: now + Math.min(30_000 * 2 ** Math.min(attempts - 1, 4), 300_000),
      });
      finishReview(root.id, root.title, { bypassProjectDecisionGate: true, trigger: "review_auto_start_setting" });
      count += 1;
    }
  }
  return count;
}
