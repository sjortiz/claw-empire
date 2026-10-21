import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import {
  hasUnfinishedDependencies,
  parseSubtaskDependencies,
  validateSubtaskDependencies,
} from "./subtask-dependencies.ts";

let db: DatabaseSync;
afterEach(() => db?.close());
function fixture() {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO tasks (id, title, status) VALUES ('root', 'Root', 'in_progress'), ('child', 'Child', 'review');
    INSERT INTO subtasks (id, task_id, title, status, delegated_task_id) VALUES ('a', 'root', 'A', 'done', 'child');
    INSERT INTO subtasks (id, task_id, title, depends_on, target_department_id) VALUES ('b', 'root', 'B', '["a"]', 'dev');
  `);
}

describe("explicit subtask dependencies", () => {
  it("requires integrated delegated work, then releases its dependents", () => {
    fixture();
    const subtask = { task_id: "root", depends_on: '["a"]' };
    expect(hasUnfinishedDependencies(db, subtask)).toBe(true);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'child'").run();
    expect(hasUnfinishedDependencies(db, subtask)).toBe(false);
  });
  it("accepts independent legacy work and blocks malformed or missing prerequisites", () => {
    fixture();
    expect(hasUnfinishedDependencies(db, { task_id: "root" })).toBe(false);
    expect(hasUnfinishedDependencies(db, { task_id: "root", depends_on: '["missing"]' })).toBe(true);
    expect(hasUnfinishedDependencies(db, { task_id: "root", depends_on: "broken" })).toBe(true);
    expect(parseSubtaskDependencies(["a", "a"])).toEqual(["a"]);
  });
  it("rejects self, indirect cycles, and references outside the parent task", () => {
    fixture();
    expect(validateSubtaskDependencies(db, "root", "a", ["a"])).toBe(false);
    expect(validateSubtaskDependencies(db, "root", "a", ["b"])).toBe(false);
    expect(validateSubtaskDependencies(db, "different-root", "c", ["a"])).toBe(false);
    expect(validateSubtaskDependencies(db, "root", "c", ["b"])).toBe(true);
  });
});
