import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { resolveReviewAutomation, type ReviewAutomationSetting } from "./review-automation.ts";

function createDb(global: Partial<Record<ReviewAutomationSetting, string>>, project: Record<string, string | null>) {
  const db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  for (const [key, value] of Object.entries(global)) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
  db.prepare(
    "INSERT INTO projects (id, name, project_path, core_goal, review_auto_start, review_auto_apply) VALUES ('p', 'P', '/p', 'Goal', ?, ?)",
  ).run(project.review_auto_start ?? null, project.review_auto_apply ?? null);
  return db;
}

describe("resolveReviewAutomation", () => {
  it.each(["reviewAutoStart", "reviewAutoApply"] as const)("defaults %s to off", (setting) => {
    const db = createDb({}, {});
    try {
      expect(resolveReviewAutomation(db, setting, "p")).toEqual({ enabled: false, source: "default" });
      expect(resolveReviewAutomation(db, setting, null)).toEqual({ enabled: false, source: "default" });
    } finally {
      db.close();
    }
  });

  it("reads the global setting when the project inherits", () => {
    const db = createDb({ reviewAutoStart: "true", reviewAutoApply: "false" }, {});
    try {
      expect(resolveReviewAutomation(db, "reviewAutoStart", "p")).toEqual({ enabled: true, source: "global" });
      expect(resolveReviewAutomation(db, "reviewAutoApply", "p")).toEqual({ enabled: false, source: "global" });
    } finally {
      db.close();
    }
  });

  it("lets a project override beat the global setting in both directions", () => {
    const db = createDb(
      { reviewAutoStart: "true", reviewAutoApply: "false" },
      { review_auto_start: "off", review_auto_apply: "on" },
    );
    try {
      expect(resolveReviewAutomation(db, "reviewAutoStart", "p")).toEqual({ enabled: false, source: "project" });
      expect(resolveReviewAutomation(db, "reviewAutoApply", "p")).toEqual({ enabled: true, source: "project" });
      // Unknown projects fall back to the global setting.
      expect(resolveReviewAutomation(db, "reviewAutoStart", "missing")).toEqual({ enabled: true, source: "global" });
    } finally {
      db.close();
    }
  });

  it("keeps the settings independent and ignores malformed global values", () => {
    const db = createDb({ reviewAutoStart: "yes" }, { review_auto_start: "on" });
    try {
      expect(resolveReviewAutomation(db, "reviewAutoApply", "p")).toEqual({ enabled: false, source: "default" });
      expect(resolveReviewAutomation(db, "reviewAutoStart", null)).toEqual({ enabled: false, source: "default" });
      expect(() => db.exec("UPDATE projects SET review_auto_start = 'maybe'")).toThrow();
    } finally {
      db.close();
    }
  });
});
