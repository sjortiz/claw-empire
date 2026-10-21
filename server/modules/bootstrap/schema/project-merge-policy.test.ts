import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyBaseSchema } from "./base-schema.ts";
import { applyTaskSchemaMigrations } from "./task-schema-migrations.ts";

describe("project merge policy schema", () => {
  it("adds inheritance to legacy projects and preserves existing overrides across repeated migrations", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyBaseSchema(db);
      db.exec("ALTER TABLE projects DROP COLUMN merge_policy");
      db.prepare("INSERT INTO projects (id, name, project_path, core_goal) VALUES (?, ?, ?, ?)").run(
        "existing",
        "Existing project",
        "/project",
        "Existing goal",
      );

      applyTaskSchemaMigrations(db);
      expect(db.prepare("SELECT id, name, core_goal, merge_policy FROM projects").get()).toMatchObject({
        id: "existing",
        name: "Existing project",
        core_goal: "Existing goal",
        merge_policy: null,
      });

      db.prepare("UPDATE projects SET merge_policy = 'manual' WHERE id = ?").run("existing");
      applyTaskSchemaMigrations(db);
      expect(db.prepare("SELECT merge_policy FROM projects").get()).toMatchObject({ merge_policy: "manual" });
      expect(() => db.exec("UPDATE projects SET merge_policy = 'invalid'")).toThrow();
    } finally {
      db.close();
    }
  });

  it("creates new projects with inherited policy by default", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyBaseSchema(db);
      db.prepare("INSERT INTO projects (id, name, project_path, core_goal) VALUES (?, ?, ?, ?)").run(
        "new",
        "New project",
        "/project",
        "New goal",
      );
      expect(db.prepare("SELECT merge_policy FROM projects").get()).toMatchObject({ merge_policy: null });
      expect(() => db.exec("UPDATE projects SET merge_policy = 'invalid'")).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("project review automation schema", () => {
  it("adds inheriting overrides to legacy projects and the notices table", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyBaseSchema(db);
      db.exec("ALTER TABLE projects DROP COLUMN review_auto_start");
      db.exec("ALTER TABLE projects DROP COLUMN review_auto_apply");
      db.prepare("INSERT INTO projects (id, name, project_path, core_goal) VALUES (?, ?, ?, ?)").run(
        "existing",
        "Existing project",
        "/project",
        "Existing goal",
      );

      applyTaskSchemaMigrations(db);
      applyTaskSchemaMigrations(db);
      expect(db.prepare("SELECT review_auto_start, review_auto_apply FROM projects").get()).toMatchObject({
        review_auto_start: null,
        review_auto_apply: null,
      });
      expect(() => db.exec("UPDATE projects SET review_auto_apply = 'auto'")).toThrow();
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_auto_start_notices").get()).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  });
});
