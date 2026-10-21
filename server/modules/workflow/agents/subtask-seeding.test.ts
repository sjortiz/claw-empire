import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Lang } from "../../../types/lang.ts";
import { createSubtaskSeedingTools } from "./subtask-seeding.ts";

describe("planned subtask scope", () => {
  it.each(["ko", "en", "ja", "zh"] as const)(
    "seeds executable department items without copying another department's note in %s",
    (lang) => {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(`
          CREATE TABLE tasks (
            id TEXT PRIMARY KEY, title TEXT, description TEXT, assigned_agent_id TEXT,
            department_id TEXT, project_id TEXT, workflow_pack_key TEXT
          );
          CREATE TABLE subtasks (
            id TEXT PRIMARY KEY, task_id TEXT, title TEXT, description TEXT, status TEXT,
            assigned_agent_id TEXT, blocked_reason TEXT, target_department_id TEXT, created_at INTEGER
          );
          INSERT INTO tasks VALUES (
            'parent', 'Deliver coordination', 'FULL PARENT DIRECTIVE', 'planner', 'planning', NULL, 'development'
          );
        `);
        const tools = createSubtaskSeedingTools({
          db,
          nowMs: () => 1,
          broadcast: () => {},
          analyzeSubtaskDepartment: (note) =>
            note.startsWith("Development:") ? "dev" : note.startsWith("QA:") ? "qa" : null,
          rerouteSubtasksByPlanningLeader: async () => {},
          findTeamLeader: (department) => ({ id: `${department}-leader` }),
          getDeptName: (department) => department,
          getPreferredLanguage: () => lang,
          resolveLang: () => lang,
          l: (ko: string[], en: string[], ja: string[], zh: string[]): Record<Lang, string[]> => ({ ko, en, ja, zh }),
          pickL: (choices: Record<Lang, string[]>, language: string) => choices[language as Lang][0],
          appendTaskLog: () => {},
          notifyCeo: () => {},
        });
        tools.seedApprovedPlanSubtasks("parent", "planning", [
          "Development: Implement the coordination API.",
          "QA: Verify delivery while the task is running.",
        ]);
        const rows = db
          .prepare("SELECT description, target_department_id FROM subtasks WHERE task_id = ?")
          .all("parent") as Array<{ description: string; target_department_id: string | null }>;
        const devItem = rows.find((row) => row.description.includes("Implement the coordination API."));
        const qaItem = rows.find((row) => row.description.includes("Verify delivery while the task is running."));

        expect(devItem?.target_department_id).toBe("dev");
        expect(qaItem?.target_department_id).toBe("qa");
        expect(devItem?.description).not.toContain("Verify delivery");
        expect(qaItem?.description).not.toContain("Implement the coordination API");
        expect(rows.every((row) => !row.description.includes("FULL PARENT DIRECTIVE"))).toBe(true);
        if (lang === "en") expect(devItem?.description).toContain("Execute only this assigned planned-meeting item");
      } finally {
        db.close();
      }
    },
  );
});
