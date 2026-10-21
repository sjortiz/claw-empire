import type { DatabaseSync } from "node:sqlite";

type FinishReview = (
  taskId: string,
  taskTitle: string,
  options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
) => void;

// Re-drive every review root after a restart. A meeting still in progress already passed
// the project decision gate, so its round resumes instead of asking the CEO again.
export function resumeReviewsOnStartup(deps: {
  db: Pick<DatabaseSync, "prepare">;
  finishReview: FinishReview;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  schedule?: (run: () => void, delayMs: number) => void;
}): void {
  const { db, finishReview, appendTaskLog } = deps;
  const schedule = deps.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
  const reviewTasks = db
    .prepare(
      `
    SELECT t.id, t.title,
      (SELECT mm.status FROM meeting_minutes mm
        WHERE mm.task_id = t.id AND mm.meeting_type = 'review'
        ORDER BY mm.started_at DESC, mm.created_at DESC LIMIT 1) AS latest_meeting_status
    FROM tasks t
    WHERE t.status = 'review'
    ORDER BY t.updated_at ASC
  `,
    )
    .all() as Array<{ id: string; title: string; latest_meeting_status: string | null }>;

  reviewTasks.forEach((task, idx) => {
    schedule(
      () => {
        const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as
          | { status: string }
          | undefined;
        if (!current || current.status !== "review") return;
        if (task.latest_meeting_status === "in_progress") {
          appendTaskLog(task.id, "system", "Recovery (startup): resuming the review meeting interrupted by a restart");
          finishReview(task.id, task.title, { bypassProjectDecisionGate: true, trigger: "restart_resume" });
          return;
        }
        finishReview(task.id, task.title);
      },
      1200 + idx * 400,
    );
  });
}
