import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveTaskMergePolicy } from "./merge-policy.ts";

describe("task merge policy resolution", () => {
  it.each([
    [undefined, null, "auto", "default"],
    ["manual", null, "manual", "global"],
    ['"manual"', null, "manual", "global"],
    ["auto", null, "auto", "global"],
    ["manual", "auto", "auto", "project"],
    ["auto", "manual", "manual", "project"],
    ["invalid", null, "auto", "default"],
  ])("resolves global %s and project %s as %s (%s)", (global, project, policy, source) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, merge_policy TEXT);
      `);
      db.prepare("INSERT INTO projects VALUES ('project', ?)").run(project);
      if (global !== undefined) db.prepare("INSERT INTO settings VALUES ('mergePolicy', ?)").run(global);
      expect(resolveTaskMergePolicy(db, "project")).toEqual({ policy, source });
      expect(resolveTaskMergePolicy(db, null).policy).toBe(global?.includes("manual") ? "manual" : "auto");
    } finally {
      db.close();
    }
  });
});
