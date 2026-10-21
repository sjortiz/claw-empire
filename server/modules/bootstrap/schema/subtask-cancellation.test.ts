import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ensureSubtaskCancellation } from "./subtask-cancellation.ts";

it("upgrades the legacy terminal check while preserving data, dependency columns and indexes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE subtasks (id TEXT PRIMARY KEY, task_id TEXT, status TEXT CHECK(status IN ('pending','in_progress','done','blocked')), depends_on TEXT, delegated_task_id TEXT);
      CREATE INDEX existing_subtask_index ON subtasks(task_id);
      INSERT INTO subtasks VALUES ('revision','root','done','["prerequisite"]','child');`);
    ensureSubtaskCancellation(db);
    db.exec("UPDATE subtasks SET status = 'cancelled'");
    expect(db.prepare("SELECT * FROM subtasks").get()).toEqual({
      id: "revision",
      task_id: "root",
      status: "cancelled",
      depends_on: '["prerequisite"]',
      delegated_task_id: "child",
    });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'existing_subtask_index'").get()).toBeTruthy();
    ensureSubtaskCancellation(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM subtasks").get()).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});
