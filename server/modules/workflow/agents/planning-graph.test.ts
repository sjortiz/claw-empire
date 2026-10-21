import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { parsePlanningGraph, validateImplementationCoverage, repairImplementationCoverage } from "./planning-graph.ts";
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

// Shared with consolidation/materialization regressions so ownership is asserted end to end.
import { nexoDirective, nexoImplementation, nexoSupportPlan } from "../../../test/implementation-planning-fixture.ts";
import { detectImplementationIntent } from "./implementation-intent.ts";
const nexoIntent = detectImplementationIntent(nexoDirective);

describe("implementation prerequisite coverage and repair", () => {
  it("rejects missing consumer prerequisites and dangling owner handoffs, preserving independent preparation", () => {
    const errors = validateImplementationCoverage(nexoSupportPlan(), nexoIntent).join("\n");
    expect(errors).toContain("Missing Development implementation for issue-84");
    expect(errors).toContain("Missing Development implementation for issue-85");
    expect(errors).toContain("observability: dangling implementation-owner handoff");
    const graph = [...nexoSupportPlan(), nexoImplementation(84), nexoImplementation(85)];
    const missingLinks = validateImplementationCoverage(graph, nexoIntent).join("\n");
    expect(missingLinks).toContain("verify84: add implementation prerequisite fix84");
    expect(missingLinks).toContain("evidence: add implementation prerequisite fix84");
    expect(missingLinks).toContain("evidence: add implementation prerequisite fix85");
    expect(missingLinks).not.toMatch(
      /(?:automation|observability|docs|readiness|spec): add implementation prerequisite/,
    );
  });

  it("repairs seven support items into two distinct code owners with tests, branches and real prerequisite links", () => {
    const original = nexoSupportPlan();
    const repaired = repairImplementationCoverage(original, nexoIntent)!;
    expect(original).toEqual(nexoSupportPlan());
    expect(repaired).toHaveLength(9);
    expect(validateImplementationCoverage(repaired, nexoIntent)).toEqual([]);
    const fixes = repaired.filter((item) => item.department_id === "dev");
    expect(fixes).toHaveLength(2);
    for (const [index, fix] of fixes.entries()) {
      expect(fix.implementation_unit).toBe(`issue-${84 + index}`);
      expect(fix.description).toMatch(/production code.*regression tests.*separate branch/);
      expect(fix.depends_on).toEqual([]);
    }
    expect(repaired.find((item) => item.key === "verify84")?.depends_on).toEqual([fixes[0].key]);
    expect(repaired.find((item) => item.key === "evidence")?.depends_on).toEqual(fixes.map((item) => item.key));
    for (const key of ["automation", "observability", "docs", "readiness", "spec"])
      expect(repaired.find((item) => item.key === key)?.depends_on).toEqual([]);
    expect(parsePlanningGraph(JSON.stringify({ plan_items: repaired }))).toEqual(repaired);
    expect(repairImplementationCoverage(repaired, nexoIntent)).toEqual(repaired);
  });

  it("accepts transitive consumer prerequisites unchanged and adds no Development to non-code plans", () => {
    const graph = [
      nexoImplementation(84),
      nexoImplementation(85),
      { key: "verify", title: "Verify completed fix #84", department_id: "operations", depends_on: ["fix84"] },
      {
        key: "evidence",
        title: "Consolidate completion evidence for #84",
        department_id: "planning",
        depends_on: ["verify"],
      },
    ];
    expect(validateImplementationCoverage(graph, nexoIntent)).toEqual([]);
    expect(repairImplementationCoverage(graph, nexoIntent)).toEqual(graph);
    const docs = [{ key: "docs", title: "Write API documentation", department_id: "planning", depends_on: [] }];
    expect(repairImplementationCoverage(docs, detectImplementationIntent("Write API documentation"))).toEqual(docs);
  });

  it.each([
    ["Verify completed fix #84", "Test planning for #84"],
    ["#84 수정 검증", "#84 테스트 준비"],
    ["#84 修正の検証", "#84 テスト準備"],
    ["验证 #84 修复", "准备 #84 测试"],
  ])("distinguishes verification from independent preparation: %s", (verification, preparation) => {
    const graph = [
      nexoImplementation(84),
      nexoImplementation(85),
      { key: "verify", title: verification, department_id: "operations", depends_on: [] },
      { key: "prepare", title: preparation, department_id: "operations", depends_on: [] },
    ];
    expect(validateImplementationCoverage(graph, nexoIntent)).toEqual([
      "verify: add implementation prerequisite fix84 for issue-84; this work consumes the completed code change.",
    ]);
    const repaired = repairImplementationCoverage(graph, nexoIntent)!;
    expect(repaired.find((item) => item.key === "verify")?.depends_on).toEqual(["fix84"]);
    expect(repaired.find((item) => item.key === "prepare")?.depends_on).toEqual([]);
  });

  it.each([
    "Review code changes for #84",
    "Configure observability after implementation of #84",
    "Apply runtime settings after the fix for #84 lands",
    "Run lint for #84",
    "#84 구현 후 모니터링 설정",
    "#84 実装後の監視設定",
    "#84 实现后配置监控",
  ])("requires completed implementation for %s", (title) => {
    const graph = [
      nexoImplementation(84),
      nexoImplementation(85),
      { key: "consumer", title, department_id: "operations", depends_on: [] },
    ];
    expect(validateImplementationCoverage(graph, nexoIntent).join(" ")).toContain(
      "consumer: add implementation prerequisite fix84",
    );
    const repaired = repairImplementationCoverage(graph, nexoIntent)!;
    expect(repaired.find((item) => item.key === "consumer")?.depends_on).toEqual(["fix84"]);
  });

  it("reports actionable dependency failures and keeps unsafe repairs invalid", () => {
    expect(() =>
      parsePlanningGraph(
        JSON.stringify({
          plan_items: [
            { key: "verify", title: "Verify fix", department_id: "operations", depends_on: ["missing_owner"] },
          ],
        }),
      ),
    ).toThrow(/verify.*missing_owner/);
    const graph = [
      { ...nexoImplementation(84), depends_on: ["verify"] },
      nexoImplementation(85),
      { key: "verify", title: "Verify completed fix #84", department_id: "operations", depends_on: [] },
    ];
    const repaired = repairImplementationCoverage(graph, nexoIntent);
    expect(() => parsePlanningGraph(JSON.stringify({ plan_items: repaired }))).toThrow(/cycle.*fix84.*verify/i);
  });
});
