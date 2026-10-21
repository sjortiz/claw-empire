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

describe("project review gate with review auto-start", () => {
  it.each([undefined, false])("waits for a CEO decision when the setting is off (global=%s)", (global) => {
    const h = createHarness({ global });
    try {
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting).not.toHaveBeenCalled();
      expect(h.logsFor("task-1")).toEqual([
        "Review gate: waiting for project-level decision (2/2 active tasks in review)",
      ]);
      expect(h.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("Approve from Decision Inbox"), "task-1");
      expect(h.notices()).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  it("starts the meeting for every root task in review without a decision when the setting is on", () => {
    const h = createHarness({ global: true });
    try {
      h.finishReview("task-2", "Frontend");
      expect(h.startReviewConsensusMeeting.mock.calls.map(([id]) => id)).toEqual(["task-1", "task-2"]);
      for (const taskId of ["task-1", "task-2"]) {
        expect(h.logsFor(taskId)).toContain(REVIEW_AUTO_START_LOG);
        expect(h.logsFor(taskId)).toContain("Review gate bypassed (trigger=review_auto_start)");
      }
      expect(h.notices()).toEqual([{ project_id: "project-1", task_ids_json: JSON.stringify(["task-1", "task-2"]) }]);
      expect(h.notifyCeo).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("started automatically"), "task-1");

      // A later gate pass while the meetings run neither restarts them nor posts another notice.
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting).toHaveBeenCalledTimes(2);
      expect(h.notices()).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  it("keeps waiting for other tasks, not for the CEO, until the gate conditions are met", () => {
    const h = createHarness({ global: true, otherTaskStatus: "in_progress" });
    try {
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting).not.toHaveBeenCalled();
      expect(h.notifyCeo).not.toHaveBeenCalled();
      expect(h.logsFor("task-1")).toEqual([
        "Review gate: waiting for other project tasks (1/2 active tasks in review); the review meeting starts automatically (setting)",
      ]);
      expect(h.notices()).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  it.each([
    ["revision_requested", "a pending review round decision"],
    ["in_progress", "the running project review meeting"],
  ])("does not run over a %s review meeting in the project", (status, reason) => {
    const h = createHarness({ global: true });
    try {
      h.db
        .prepare(
          "INSERT INTO meeting_minutes (id, task_id, meeting_type, round, title, status, started_at) VALUES ('m1', 'task-1', 'review', 1, 'Review', ?, 1)",
        )
        .run(status);
      h.finishReview("task-2", "Frontend");
      expect(h.startReviewConsensusMeeting).not.toHaveBeenCalled();
      expect(h.logsFor("task-2")).toEqual([
        `Review gate: waiting for ${reason} before starting automatically (setting)`,
      ]);
      expect(h.notices()).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  it.each([
    { global: true, project: "off" as const, starts: false },
    { global: false, project: "on" as const, starts: true },
    { global: undefined, project: "on" as const, starts: true },
  ])("lets the project override beat the global setting: %j", ({ global, project, starts }) => {
    const h = createHarness({ global, project });
    try {
      h.finishReview("task-1", "Backend");
      expect(h.startReviewConsensusMeeting).toHaveBeenCalledTimes(starts ? 2 : 0);
      expect(h.notices()).toHaveLength(starts ? 1 : 0);
    } finally {
      h.db.close();
    }
  });
});
