import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { parsePlanningGraph, parseMergedPlanningGraph } from "./planning-graph.ts";
import { createSubtaskSeedingTools } from "./subtask-seeding.ts";
import { hasUnfinishedDependencies } from "../../routes/collab/subtask-dependencies.ts";

let db: DatabaseSync | null = null;
afterEach(() => {
  db?.close();
  db = null;
});
const graph = [
  { key: "api", title: "Implement API", department_id: "dev", depends_on: [] },
  { key: "check", title: "Verify API", department_id: "qa", depends_on: ["api"] },
  { key: "notes", title: "Write migration notes", department_id: "planning", depends_on: [] },
];

describe("structured planning graph", () => {
  it("validates plans above the 30-item target without rejecting their size", () => {
    const items = Array.from({ length: 32 }, (_, index) => ({
      key: `item${index}`,
      title: `Work ${index}`,
      department_id: "dev",
      depends_on: index ? [`item${index - 1}`] : [],
    }));
    expect(parsePlanningGraph(JSON.stringify({ plan_items: items }))).toEqual(items);
    expect(() =>
      parsePlanningGraph(
        JSON.stringify({
          plan_items: items.map((item, index) => (index === 0 ? { ...item, depends_on: ["missing"] } : item)),
        }),
      ),
    ).toThrow("Invalid planning graph dependency");
  });
  it("requires merged plans to preserve source coverage, owners and prerequisites", () => {
    const merged = graph.map((item) => ({ ...item, source_keys: [item.key] }));
    expect(parseMergedPlanningGraph(JSON.stringify({ plan_items: merged }), graph)).toEqual(graph);
    for (const plan_items of [
      merged.slice(1),
      merged.map((item, index) => (index === 0 ? { ...item, department_id: "qa" } : item)),
      merged.map((item, index) => (index === 1 ? { ...item, depends_on: [] } : item)),
      merged.map((item, index) => (index === 0 ? { ...item, source_keys: ["api", "notes"] } : item)),
    ]) {
      expect(() => parseMergedPlanningGraph(JSON.stringify({ plan_items }), graph)).toThrow();
    }
  });

  it("resolves plan-local prerequisites to persisted IDs and delegates origin items as children", () => {
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    applyTaskSchemaMigrations(db);
    db.exec(`
      INSERT INTO departments (id, name, name_ko, icon, color) VALUES
        ('planning', 'Planning', '기획', 'P', '#111'), ('dev', 'Development', '개발', 'D', '#111'), ('qa', 'QA', 'QA', 'Q', '#111');
      INSERT INTO tasks (id, title, department_id, status) VALUES ('root', 'Root', 'planning', 'planned');
    `);
    const tools = createSubtaskSeedingTools({
      db,
      nowMs: () => 1,
      broadcast: vi.fn(),
      analyzeSubtaskDepartment: () => null,
      rerouteSubtasksByPlanningLeader: vi.fn(),
      findTeamLeader: () => null,
      getDeptName: (id: string) => id,
      getPreferredLanguage: () => "en",
      resolveLang: () => "en",
      l: (ko: string[], en: string[]) => ({ ko, en }),
      pickL: (pool: { en: string[] }) => pool.en[0],
      appendTaskLog: vi.fn(),
      notifyCeo: vi.fn(),
    });
    tools.seedApprovedPlanSubtasks("root", "planning", [JSON.stringify({ plan_items: graph })]);
    const rows = db.prepare("SELECT * FROM subtasks ORDER BY title").all() as any[];
    expect(rows).toHaveLength(3);
    const api = rows.find((row) => row.title === "Implement API");
    const check = rows.find((row) => row.title === "Verify API");
    expect(JSON.parse(check.depends_on)).toEqual([api.id]);
    expect(hasUnfinishedDependencies(db, check)).toBe(true);
    expect(rows.find((row) => row.title === "Write migration notes").target_department_id).toBe("planning");
    tools.seedApprovedPlanSubtasks("root", "planning", [JSON.stringify({ plan_items: graph })]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM subtasks").get()).toEqual({ count: 3 });
  });
  it("parses a summary fence without truncating plan metadata", () => {
    expect(
      parsePlanningGraph(`Consolidated plan\n\n\`\`\`json\n${JSON.stringify({ plan_items: graph })}\n\`\`\``),
    ).toEqual(graph);
    expect(parsePlanningGraph("Existing prose-only plan")).toBeNull();
  });
  it("rejects cyclic, missing, duplicate or malformed keys instead of silently dropping dependencies", () => {
    expect(() => parsePlanningGraph(JSON.stringify({ plan_items: [graph[0], graph[0]] }))).toThrow();
    expect(() => parsePlanningGraph(JSON.stringify({ plan_items: [graph[1]] }))).toThrow();
    expect(() => parsePlanningGraph(JSON.stringify({ plan_items: [{ ...graph[0], depends_on: ["api"] }] }))).toThrow();
  });
});
