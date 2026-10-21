import { describe, expect, it } from "vitest";
import {
  detectImplementationIntent,
  directiveTextFromTask,
  implementationPlanningRules,
  includeImplementationDepartment,
  implementationIntentFromTask,
} from "./implementation-intent.ts";
import { validateImplementationCoverage, type PlanningItem } from "./planning-graph.ts";

export const nexoDirective =
  "Fix the first two open issues on Nexo, #84 and #85. Add regression tests, run lint/tests and check observability. Use one branch per issue.";
const intent = detectImplementationIntent(nexoDirective);
const implementation = (reference: string): PlanningItem => ({
  key: `fix${reference.slice(1)}`,
  title: `Fix Nexo issue ${reference}`,
  description: `Change production code and add regression tests on a separate branch for ${reference}.`,
  department_id: "dev",
  depends_on: [],
});

describe("directive implementation intent", () => {
  it("preserves two Nexo fixes and branch/test requirements without department keywords", () => {
    expect(intent.requiresImplementation).toBe(true);
    expect(
      intent.implementationUnits.map((unit) => [unit.key, unit.reference, unit.requiresTests, unit.separateBranch]),
    ).toEqual([
      ["issue-84", "#84", true, true],
      ["issue-85", "#85", true, true],
    ]);
    expect(includeImplementationDepartment(["operations", "planning"], intent)).toEqual([
      "operations",
      "planning",
      "dev",
    ]);
  });
  it.each([
    "Fix the API authentication bug",
    "Implement login",
    "Build an app",
    "Update src/api.ts to reject empty input",
    "Add regression tests for the API",
    "Open a PR to fix #84",
    "Refactor the backend handler",
    "버그를 수정하고 테스트를 추가해",
    "APIのバグを修正してテストを追加",
    "修复登录功能并添加测试",
  ])("detects concrete implementation action: %s", (text) =>
    expect(detectImplementationIntent(text).requiresImplementation).toBe(true),
  );
  it.each([
    "Announce that implementation of issue #84 is complete",
    "Research how to fix issue #84 and write a report",
    "Write implementation specifications for issues #84 and #85",
    "Fix README documentation",
    "Update documentation for the API",
    "Hold a meeting about code quality and tests",
    "code fix tests branch",
    "Report on open PR #84",
    "Review the code in src/api.ts",
    "Document the fix for issue #84",
  ])("does not force implementation: %s", (text) =>
    expect(detectImplementationIntent(text, "Implement the application code").requiresImplementation).toBe(false),
  );
  it("uses context only to disambiguate an action, ignoring stored project goals", () => {
    expect(detectImplementationIntent("Fix it", "API bug in src/api.ts").requiresImplementation).toBe(true);
    const text = directiveTextFromTask(
      "Docs",
      "[CEO] Write release documentation\n[PROJECT CORE GOAL] Fix API bug #84\n[ROUND GOAL] Implement code",
    );
    expect(detectImplementationIntent(text).requiresImplementation).toBe(false);
  });
  it("keeps implementation in mixed code/documentation requests", () => {
    expect(
      detectImplementationIntent("Fix API authentication and write release documentation").requiresImplementation,
    ).toBe(true);
  });
  it.each([
    "Fix API authentication with tests and documentation",
    "Fix #84 with tests and update documentation",
    "Fix #84 with documentation about #85",
    "Fix #84 and #85 with tests and documentation, one branch per issue",
  ])("retains implementation ownership with supporting deliverables: %s", (text) => {
    const mixedIntent = detectImplementationIntent(text);
    expect(mixedIntent.requiresImplementation).toBe(true);
    expect(includeImplementationDepartment(["operations"], mixedIntent)).toContain("dev");
    expect(validateImplementationCoverage(null, mixedIntent)).not.toEqual([]);
    if (text.includes("#84")) {
      expect(mixedIntent.implementationUnits.map((unit) => unit.reference)).toEqual(
        text.includes("and #85") ? ["#84", "#85"] : ["#84"],
      );
    }
    if (text.includes("branch")) {
      expect(mixedIntent.implementationUnits.every((unit) => unit.separateBranch && unit.requiresTests)).toBe(true);
    }
  });
  it.each([
    "Update API documentation with tests and examples",
    "Write API documentation including code fixes for #84",
    "Fix documentation for API authentication with regression tests",
  ])("does not infer code work from documentation supplements: %s", (text) => {
    expect(detectImplementationIntent(text).requiresImplementation).toBe(false);
  });
  it.each([
    "Fix #84 and API documentation about #85",
    "#84 버그를 수정하고 #85 문서를 업데이트해",
    "#84 버그를 수정하며 #85 문서를 업데이트해",
    "#84 のバグを修正して #85 の文書を更新",
    "修复功能 #84并更新文档 #85",
    "修复功能 #84并且更新文档 #85",
  ])("keeps only executable issue references in mixed clauses: %s", (text) => {
    const mixedIntent = detectImplementationIntent(text);
    expect(mixedIntent.requiresImplementation).toBe(true);
    expect(mixedIntent.implementationUnits.map((unit) => unit.reference)).toEqual(["#84"]);
  });
  it.each([
    "Fix API authentication documentation and regression test examples",
    "API 문서를 수정하고 테스트 문서를 추가해",
    "APIの文書を修正してテストの文書を追加",
    "修改功能文档并更新测试文档",
  ])("keeps coordinated supporting targets out of implementation: %s", (text) => {
    expect(detectImplementationIntent(text, "Fix API bug #84").requiresImplementation).toBe(false);
  });
});

describe("implementation graph acceptance", () => {
  it("accepts separate Development fixes with tests/branches and independent documentation", () => {
    expect(
      validateImplementationCoverage(
        [
          implementation("#84"),
          implementation("#85"),
          { key: "docs", title: "Write notes", department_id: "planning", depends_on: [] },
        ],
        intent,
      ),
    ).toEqual([]);
  });
  it("rejects the original seven supporting items and explains both missing units", () => {
    const graph = [
      "Test automation setup",
      "Observability configuration",
      "Documentation/change-impact assessment",
      "CI/CD readiness",
      "Issue separate implementation specifications",
      "Consolidate completion evidence",
      "Finalize detailed execution plan",
    ].map((title, index) => ({
      key: `support${index}`,
      title,
      department_id: index % 2 ? "planning" : "operations",
      depends_on: [],
    }));
    const errors = validateImplementationCoverage(graph, intent);
    expect(errors).toHaveLength(2);
    expect(errors.join(" ")).toContain("issue-84");
    expect(errors.join(" ")).toContain("issue-85");
    expect(errors.join(" ")).toContain("Specifications, readiness and evidence do not qualify");
  });
  it.each([
    "Write implementation specifications",
    "Implement issue specifications",
    "Consolidate implementation evidence",
    "Prepare code readiness checklist",
    "Review code fix",
  ])("rejects misleading dev ownership: %s", (title) => {
    expect(
      validateImplementationCoverage([{ ...implementation("#84"), title }], detectImplementationIntent("Fix #84")),
    ).not.toEqual([]);
  });
  it("rejects prose, wrong owners, combined units and omitted constraints", () => {
    expect(validateImplementationCoverage(null, intent)[0]).toContain("structured");
    expect(
      validateImplementationCoverage(
        [{ ...implementation("#84"), department_id: "operations" }, implementation("#85")],
        intent,
      ),
    ).toHaveLength(1);
    expect(
      validateImplementationCoverage(
        [{ ...implementation("#84"), description: "Fix #84 and #85 with tests on separate branches" }],
        intent,
      ),
    ).toHaveLength(2);
    expect(
      validateImplementationCoverage(
        [{ ...implementation("#84"), description: "Change production code" }],
        detectImplementationIntent("Fix #84 with tests, one branch per issue"),
      ).join(" "),
    ).toMatch(/regression tests.*separate branch/);
  });
  it("allows documentation-only plans and revalidates corrected graphs", () => {
    expect(validateImplementationCoverage(null, detectImplementationIntent("Write documentation"))).toEqual([]);
    expect(validateImplementationCoverage([implementation("#84")], intent)).toHaveLength(1);
    expect(validateImplementationCoverage([implementation("#84"), implementation("#85")], intent)).toEqual([]);
  });
});

describe("conditional planning rules", () => {
  it("requires real owners and per-unit deliverables in implementation rules", () => {
    const rules = implementationPlanningRules(intent);
    expect(rules).toContain('department_id: "dev"');
    expect(rules).toContain('implementation_unit to "issue-84"');
    expect(rules).toContain('implementation_unit to "issue-85"');
    expect(rules).toContain("one separate branch for this issue");
    expect(rules).toContain("cannot replace implementation");
    expect(rules).toContain("Independent implementation items start together");
  });
  it("does not add any rule for docs-only work", () =>
    expect(implementationPlanningRules(detectImplementationIntent("Write docs"))).toBe(""));
});

it("retains actionable title/context and excludes documentation-only issue references", () => {
  expect(detectImplementationIntent("I need you to fix the API bug").requiresImplementation).toBe(true);
  expect(
    implementationIntentFromTask("Fix API authentication bug", "Login rejects valid credentials")
      .requiresImplementation,
  ).toBe(true);
  expect(
    implementationIntentFromTask("Fix it", "[CEO] Fix it\n[PROJECT CORE GOAL] API bug in src/api.ts")
      .requiresImplementation,
  ).toBe(true);
  expect(
    detectImplementationIntent("Fix #84 and document #85").implementationUnits.map((unit) => unit.reference),
  ).toEqual(["#84"]);
  expect(detectImplementationIntent("Write API documentation").requiresImplementation).toBe(false);
  expect(detectImplementationIntent("Update the API documentation").requiresImplementation).toBe(false);
});
it("rejects test-only/specification-only replacements but supports explicit test code requests", () => {
  const original = detectImplementationIntent("Fix #84 with tests, one branch per issue");
  expect(
    validateImplementationCoverage(
      [
        {
          ...implementation("#84"),
          title: "Add regression tests for #84",
          description: "Add regression tests on a separate branch",
        },
      ],
      original,
    ),
  ).not.toEqual([]);
  expect(
    validateImplementationCoverage(
      [
        {
          ...implementation("#84"),
          title: "Implement #84",
          description: "Write implementation specification with regression tests on a separate branch",
        },
      ],
      original,
    ),
  ).not.toEqual([]);
  expect(
    validateImplementationCoverage(
      [{ key: "tests", title: "Add regression tests for API", department_id: "dev", depends_on: [] }],
      detectImplementationIntent("Add regression tests for API"),
    ),
  ).toEqual([]);
});

it("rejects explicit omission of requested tests and a shared branch", () => {
  expect(
    validateImplementationCoverage(
      [{ ...implementation("#84"), description: "Change production code without tests on a separate branch" }],
      detectImplementationIntent("Fix #84"),
    ).join(" "),
  ).toContain("regression tests");
  expect(
    validateImplementationCoverage(
      [{ ...implementation("#84"), description: "Change production code with tests on the same branch" }],
      detectImplementationIntent("Fix #84, one branch per issue"),
    ).join(" "),
  ).toContain("separate branch");
});
