import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { REVIEW_AUTO_START_LOG } from "../core/review-automation.ts";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";

function createHarness(options: { global?: boolean; project?: "on" | "off" | null; otherTaskStatus?: string } = {}) {
  const db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.prepare(
    "INSERT INTO projects (id, name, project_path, core_goal, review_auto_start) VALUES ('project-1', 'Empire', '/project', 'Goal', ?)",
  ).run(options.project ?? null);
  if (options.global !== undefined) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('reviewAutoStart', ?)").run(String(options.global));
  }
  const insertTask = db.prepare(
    "INSERT INTO tasks (id, title, status, project_id, updated_at) VALUES (?, ?, ?, 'project-1', ?)",
  );
  insertTask.run("task-1", "Backend", "review", 1);
  insertTask.run("task-2", "Frontend", options.otherTaskStatus ?? "review", 2);

  const reviewInFlight = new Set<string>();
  const startReviewConsensusMeeting = vi.fn((taskId: string) => {
    reviewInFlight.add(taskId);
  });
  const appendTaskLog = vi.fn();
  const notifyCeo = vi.fn();
  const tools = createReviewFinalizeTools({
    db,
    nowMs: () => 100_000,
    broadcast: vi.fn(),
    appendTaskLog,
    getPreferredLanguage: () => "en",
    resolveLang: () => "en",
    l: (_ko: string[], en: string[]) => en[0],
    pickL: (value: string) => value,
    getProjectReviewGateSnapshot: (projectId: string) => {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS active_total,
             SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS active_review
           FROM tasks WHERE project_id = ?`,
        )
        .get(projectId) as { active_total: number; active_review: number };
      return {
        activeTotal: row.active_total,
        activeReview: row.active_review,
        rootReviewTotal: row.active_review,
        ready: row.active_total > 0 && row.active_total === row.active_review,
      };
    },
    projectReviewGateNotifiedAt: new Map(),
    notifyCeo,
    taskWorktrees: new Map(),
    reviewRoundState: new Map(),
    reviewInFlight,
    startReviewConsensusMeeting,
  });
  const logsFor = (taskId: string) =>
    appendTaskLog.mock.calls.filter(([id]) => id === taskId).map(([, , message]) => message as string);
  const notices = () => db.prepare("SELECT project_id, task_ids_json FROM review_auto_start_notices").all();
  return { db, ...tools, startReviewConsensusMeeting, notifyCeo, logsFor, notices };
}

describe("automatic review meeting safety holds", () => {
  it("preserves unfinished-subtask holds and retries after the subtask completes", () => {
    const h = createHarness({ global: true });
    try {
      h.db.exec("INSERT INTO subtasks (id, task_id, title, status) VALUES ('held', 'task-1', 'Fix', 'pending')");
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting.mock.calls.map(([id]) => id)).toEqual(["task-2"]);
      expect(h.logsFor("task-1")).toContain("Review hold: waiting for 1 unfinished subtasks");
      expect(h.logsFor("task-1")).not.toContain(REVIEW_AUTO_START_LOG);
      expect(h.notices()).toEqual([{ project_id: "project-1", task_ids_json: JSON.stringify(["task-2"]) }]);

      h.db.exec("UPDATE subtasks SET status='done' WHERE id='held'");
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting.mock.calls.map(([id]) => id)).toEqual(["task-2", "task-1"]);
      expect(h.logsFor("task-1")).toContain(REVIEW_AUTO_START_LOG);
      expect(h.notices()).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  it("preserves video-artifact holds without reporting that the held meeting started", () => {
    const h = createHarness({ global: true });
    try {
      h.db.exec(
        "UPDATE tasks SET workflow_pack_key='video_preprod', project_path='/missing-review-artifact' WHERE id='task-1'",
      );
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting.mock.calls.map(([id]) => id)).toEqual(["task-2"]);
      expect(h.logsFor("task-1")).toEqual(
        expect.arrayContaining([expect.stringContaining("Review hold: video artifact gate blocked approval")]),
      );
      expect(h.logsFor("task-1")).not.toContain(REVIEW_AUTO_START_LOG);
      expect(h.notices()).toEqual([{ project_id: "project-1", task_ids_json: JSON.stringify(["task-2"]) }]);
    } finally {
      h.db.close();
    }
  });

  it("waits for active collaboration children before automatically starting root reviews", () => {
    const h = createHarness({ global: true });
    try {
      h.db.exec(
        "INSERT INTO tasks (id, title, status, project_id, source_task_id) VALUES ('child', 'Child', 'in_progress', 'project-1', 'task-1')",
      );
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting).not.toHaveBeenCalled();
      expect(h.notices()).toEqual([]);

      h.db.exec("UPDATE tasks SET status='done' WHERE id='child'");
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting.mock.calls.map(([id]) => id)).toEqual(["task-1", "task-2"]);
    } finally {
      h.db.close();
    }
  });
});
