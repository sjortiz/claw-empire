import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyBaseSchema } from "./base-schema.ts";
import { applyTaskSchemaMigrations } from "./task-schema-migrations.ts";

describe("project review automation schema", () => {
  it.each([false, true])("retains inheritance and checked overrides for legacy=%s", (legacy) => {
    const db = new DatabaseSync(":memory:");
    try {
      applyBaseSchema(db);
      if (legacy) {
        db.exec("ALTER TABLE projects DROP COLUMN review_meeting_auto_start");
        db.exec("ALTER TABLE projects DROP COLUMN review_items_auto_apply");
      }
      db.exec(
        "INSERT INTO projects (id, name, project_path, core_goal) VALUES ('project', 'Review', '/project', 'Goal')",
      );
      applyTaskSchemaMigrations(db);
      expect(
        db.prepare("SELECT name, review_meeting_auto_start, review_items_auto_apply FROM projects").get(),
      ).toMatchObject({
        name: "Review",
        review_meeting_auto_start: null,
        review_items_auto_apply: null,
      });
      db.exec("UPDATE projects SET review_meeting_auto_start = 1, review_items_auto_apply = 0");
      applyTaskSchemaMigrations(db);
      expect(db.prepare("SELECT review_meeting_auto_start, review_items_auto_apply FROM projects").get()).toMatchObject(
        {
          review_meeting_auto_start: 1,
          review_items_auto_apply: 0,
        },
      );
      for (const field of ["review_meeting_auto_start", "review_items_auto_apply"]) {
        expect(() => db.exec(`UPDATE projects SET ${field} = 2`)).toThrow();
        expect(() => db.exec(`UPDATE projects SET ${field} = 'true'`)).toThrow();
      }
    } finally {
      db.close();
    }
  });
});
