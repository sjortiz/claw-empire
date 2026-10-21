import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { resumeReviewsOnStartup } from "./review-startup.ts";

let db: DatabaseSync;
afterEach(() => db?.close());

describe("resumeReviewsOnStartup", () => {
  it("resumes an interrupted review meeting past the gate and re-gates the rest", () => {
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    applyTaskSchemaMigrations(db);
    db.exec(`INSERT INTO tasks (id,title,status,updated_at) VALUES
        ('interrupted','Interrupted','review',1), ('waiting','Waiting','review',2), ('closed','Closed','done',3);
      INSERT INTO meeting_minutes (id,task_id,meeting_type,round,title,status,started_at) VALUES
        ('m1','interrupted','review',2,'Review','in_progress',10),
        ('m0','interrupted','review',1,'Review','revision_requested',5);`);
    const finishReview = vi.fn();
    const appendTaskLog = vi.fn();

    resumeReviewsOnStartup({ db, finishReview, appendTaskLog, schedule: (run) => run() });

    expect(finishReview.mock.calls).toEqual([
      ["interrupted", "Interrupted", { bypassProjectDecisionGate: true, trigger: "restart_resume" }],
      ["waiting", "Waiting"],
    ]);
    expect(appendTaskLog).toHaveBeenCalledWith(
      "interrupted",
      "system",
      expect.stringContaining("interrupted by a restart"),
    );
  });
});
